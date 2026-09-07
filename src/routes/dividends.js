const express = require('express');

/**
 * Dividends Router
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        requirePortfolioAccess,
        database,
        logger,
        getEurUsdRate,
        refreshDividendProjections,
        triggerHistoryRebuild,
        clearPerformanceCache
    } = dependencies;

    // ─── DIVIDENDS PROJECTIONS & CONFIRMATION ───────────────────────────────
    router.get('/dividends/manual-projections', requireAuth, (req, res) => {
        try {
            const data = database.db.prepare(`
                SELECT m.*, a.name FROM dividend_projections m 
                JOIN assets a ON m.ticker = a.ticker 
                WHERE m.user_id = ?
                ORDER BY exDate ASC
            `).all(req.user.id);
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/dividends/projections', requireAuth, (req, res) => {
        try {
            const { ticker, exDate, amount } = req.body;
            if (!ticker || !exDate || !amount) return res.status(400).json({ error: 'Missing fields' });
            const year = parseInt(exDate.substring(0, 4));
            database.db.prepare(`
                INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, yield, tag, year, isCustom)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `).run(req.user.id, ticker, null, exDate, parseFloat(amount), parseFloat(amount), 0, 'MANUALE', year);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.put('/dividends/projections/:id', requireAuth, (req, res) => {
        try {
            const { exDate, amount } = req.body;
            const year = parseInt(exDate.substring(0, 4));
            database.db.prepare(`
                UPDATE dividend_projections 
                SET exDate = ?, amount = ?, totalAmount = ?, year = ?, tag = 'MANUALE', isCustom = 1
                WHERE id = ? AND user_id = ?
            `).run(exDate, parseFloat(amount), parseFloat(amount), year, req.params.id, req.user.id);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/dividends/projections/:id', requireAuth, (req, res) => {
        try {
            database.db.prepare(`DELETE FROM dividend_projections WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/dividends/projections/:id/confirm', requireAuth, requirePortfolioAccess, async (req, res) => {
        try {
            const { portfolioId, ticker, grossAmount, tax, date, createWithdrawal } = req.body;
            if (!portfolioId || !ticker || !date) {
                return res.status(400).json({ error: 'Missing fields' });
            }
            const taxVal   = parseFloat(tax)   || 0;
            const grossVal = parseFloat(grossAmount) || 0;
            // Net amount (what hits the portfolio cash) = gross - tax
            const netVal   = grossVal - taxVal;
            
            const divRes = database.db.prepare(`
                INSERT INTO transactions (portfolioId, type, assetTicker, date, amount, quantity, price, commission, tax, exchangeRate)
                VALUES (?, 'DIVIDEND', ?, ?, ?, 0, 0, 0, ?, 1)
            `).run(portfolioId, ticker, date, netVal, taxVal);
            const divTxId = divRes.lastInsertRowid;

            if (createWithdrawal && netVal > 0) {
                const wRes = database.db.prepare(`
                    INSERT INTO transactions (portfolioId, type, assetTicker, date, amount, quantity, price, commission, tax, exchangeRate, notes, linkedTransactionId)
                    VALUES (?, 'WITHDRAWAL', 'CASH', ?, ?, 0, 0, 0, 0, 1, ?, ?)
                `).run(portfolioId, date, netVal, `Storno liquidità dividendo ${ticker}`, divTxId);
                const wTxId = wRes.lastInsertRowid;

                database.db.prepare(`
                    UPDATE transactions SET linkedTransactionId = ? WHERE id = ?
                `).run(wTxId, divTxId);
            }
            
            database.db.prepare(`DELETE FROM dividend_projections WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
            const liveRate = await getEurUsdRate();
            database.recalculatePortfolio(portfolioId, liveRate);
            if (triggerHistoryRebuild) triggerHistoryRebuild(portfolioId);
            if (clearPerformanceCache) clearPerformanceCache();
            
            res.json({ success: true, divTxId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /**
     * PUT /api/dividends/transactions/:id
     * Modifica un dividendo già confermato (transazione esistente).
     */
    router.put('/dividends/transactions/:id', requireAuth, async (req, res) => {
        try {
            const { grossAmount, tax, date } = req.body;
            const taxVal   = parseFloat(tax)   || 0;
            const grossVal = parseFloat(grossAmount) || 0;
            const netVal   = grossVal - taxVal;

            // Verifica che la transazione appartenga a un portfolio dell'utente
            const tx = database.db.prepare(`
                SELECT t.id, t.portfolioId, t.linkedTransactionId FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE t.id = ? AND pu.user_id = ? AND t.type = 'DIVIDEND'
            `).get(req.params.id, req.user.id);

            if (!tx) return res.status(404).json({ error: 'Transazione non trovata' });

            database.db.prepare(`
                UPDATE transactions SET date = ?, amount = ?, tax = ? WHERE id = ?
            `).run(date, netVal, taxVal, tx.id);

            if (tx.linkedTransactionId) {
                database.db.prepare(`
                    UPDATE transactions SET date = ?, amount = ? WHERE id = ? AND type = 'WITHDRAWAL'
                `).run(date, netVal, tx.linkedTransactionId);
            }

            const liveRate = await getEurUsdRate();
            database.recalculatePortfolio(tx.portfolioId, liveRate);
            if (triggerHistoryRebuild) triggerHistoryRebuild(tx.portfolioId);
            if (clearPerformanceCache) clearPerformanceCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /**
     * DELETE /api/dividends/transactions/:id
     * Elimina un dividendo già confermato (transazione esistente).
     */
    router.delete('/dividends/transactions/:id', requireAuth, async (req, res) => {
        try {
            const tx = database.db.prepare(`
                SELECT t.id, t.portfolioId, t.linkedTransactionId FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE t.id = ? AND pu.user_id = ? AND t.type = 'DIVIDEND'
            `).get(req.params.id, req.user.id);

            if (!tx) return res.status(404).json({ error: 'Transazione non trovata' });

            if (tx.linkedTransactionId) {
                database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(tx.linkedTransactionId);
            }
            database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(tx.id);
            const liveRate = await getEurUsdRate();
            database.recalculatePortfolio(tx.portfolioId, liveRate);
            if (triggerHistoryRebuild) triggerHistoryRebuild(tx.portfolioId);
            if (clearPerformanceCache) clearPerformanceCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/dividends/projections/reset', requireAuth, async (req, res) => {
        try {
            const count = await refreshDividendProjections(req.user.id);
            res.json({ success: true, count });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
