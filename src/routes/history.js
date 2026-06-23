const express = require('express');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        requirePortfolioAccess,
        database
    } = dependencies;

    // GET /api/history
    router.get('/', requireAuth, (req, res) => {
        const { portfolioId } = req.query;
        
        let query = `
            SELECT h.* FROM portfolio_history h
            JOIN portfolio_users pu ON h.portfolioId = pu.portfolio_id
            WHERE pu.user_id = ?
        `;
        let params = [req.user.id];
        
        if (portfolioId && portfolioId !== 'null' && portfolioId !== '') {
            query += ` AND h.portfolioId = ? `;
            params.push(portfolioId);
        }
        
        query += ` ORDER BY date DESC`;
        res.json(database.db.prepare(query).all(...params));
    });

    // POST /api/history
    router.post('/', requireAuth, requirePortfolioAccess, (req, res) => {
        const { id, portfolioId, date, totalValue, cashValue, assetValue } = req.body;
        const rTotal = Math.round(totalValue || 0);
        const rCash  = Math.round(cashValue || 0);
        const rAsset = Math.round(assetValue || 0);

        try {
            if (id) {
                database.db.prepare(`
                    UPDATE portfolio_history 
                    SET date = ?, totalValue = ?, cashValue = ?, assetValue = ? 
                    WHERE id = ?
                `).run(date, rTotal, rCash, rAsset, id);
            } else {
                const pid = portfolioId === 'null' ? null : portfolioId;
                database.db.prepare(`
                    INSERT INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(portfolioId, date) DO UPDATE SET
                        totalValue = excluded.totalValue,
                        cashValue = excluded.cashValue,
                        assetValue = excluded.assetValue
                `).run(pid, date, rTotal, rCash, rAsset);
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).send(err.message);
        }
    });

    // DELETE /api/history/:id
    router.delete('/:id', requireAuth, (req, res) => {
        try {
            const row = database.db.prepare(`
                SELECT h.* FROM portfolio_history h
                JOIN portfolio_users pu ON h.portfolioId = pu.portfolio_id
                WHERE h.id = ? AND pu.user_id = ?
            `).get(req.params.id, req.user.id);

            if (!row && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

            database.db.prepare(`DELETE FROM portfolio_history WHERE id = ?`).run(req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
