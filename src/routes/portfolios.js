const express = require('express');
const { parse } = require('json2csv'); // Needed for export
const fs = require('fs');
const path = require('path');

module.exports = function (dependencies) {
    const router = express.Router();
    
    // Destructure dependencies
    const {
        requireAuth,
        requirePortfolioAccess,
        database,
        logger,
        getAllPortfolioStats,
        getPortfolioDetails,
        calculatePerformanceHistory,
        getEurUsdRate,
        callAIModel,
        parseAIResponse,
        clearPerformanceCache
    } = dependencies;

    // GET /api/portfolios
    router.get('/', requireAuth, async (req, res) => {
        try {
            const tagIds = req.query.tagIds ? req.query.tagIds.split(',').map(Number) : null;
            const stats = await getAllPortfolioStats(req.user.id, null, tagIds);
            res.json({
                portfolios: stats.portfolios,
                global: {
                    totalValue: stats.totalValue,
                    totalNetValue: stats.totalNetValue,
                    totalTax: stats.totalTax,
                    totalGain: stats.totalGain,
                    investedCapital: stats.investedCapital,
                    changeValue: stats.totalChange,
                    changeValuePrePost: stats.totalChangePrePost,
                    changePercent: stats.changePercent,
                    topWinners: stats.topWinners,
                    topLosers: stats.topLosers,
                    topWinnersAbs: stats.topWinnersAbs,
                    topLosersAbs: stats.topLosersAbs
                }
            });
        } catch (err) {
            console.error('API Error /api/portfolios:', err);
            const errPayload = { error: err.message };
            if (process.env.NODE_ENV === 'development') errPayload.stack = err.stack;
            res.status(500).json(errPayload);
        }
    });

    // GET /api/portfolios/:id
    router.get('/:id', requireAuth, requirePortfolioAccess, async (req, res) => {
        try {
            const data = await getPortfolioDetails(req.params.id);
            res.json(data);
        } catch (err) {
            res.status(err.message === 'Portfolio non trovato' ? 404 : 500).json({ error: err.message });
        }
    });

    // GET /api/portfolios/:id/ai-analysis
    router.get('/:id/ai-analysis', requireAuth, requirePortfolioAccess, async (req, res) => {
        try {
            const globalSettings = database.getSettings(1) || {};
            
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            const sendEvent = (event, data) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            const portfolio = await getPortfolioDetails(req.params.id);
            if (!portfolio || !portfolio.holdings || portfolio.holdings.length === 0) {
                sendEvent('error', { error: 'Portafoglio vuoto o non valido.' });
                return res.end();
            }

            const promptTemplate = globalSettings.aiPortfolioPrompt || 
`Sei un analista finanziario esperto.
Analizza questo portafoglio e fornisci:
1. Una valutazione del rischio (1-10).
2. Considerazioni sulla diversificazione.
3. Tre azioni pratiche da intraprendere (es: vendi asset X, compra più Y, bilancia settore Z).

Dati Portafoglio:
Value: {TOTAL_VALUE} EUR
Performance 1D: {PERF_1D}%
Asset: {ASSETS_JSON}

Rispondi in JSON: { "riskScore": 7, "diversification": "...", "actions": ["...", "...", "..."], "reasoning": "..." }`;

            const assetsList = portfolio.holdings.map(h => {
                let fundamentals = null;
                try {
                    const row = database.db.prepare('SELECT data FROM asset_fundamentals WHERE ticker = ?').get(h.ticker);
                    if (row) {
                        const parsed = JSON.parse(row.data);
                        fundamentals = {
                            peTrailing: parsed.summaryDetail?.trailingPE || parsed.keyStats?.trailingPE || null,
                            peForward: parsed.keyStats?.forwardPE || null,
                            pegRatio: parsed.pegRatio || null,
                            debtToEquity: parsed.financialData?.debtToEquity || null,
                            roe: parsed.financialData?.returnOnEquity ? (parsed.financialData.returnOnEquity * 100).toFixed(1) + '%' : null,
                            netMargin: parsed.financialData?.profitMargins ? (parsed.financialData.profitMargins * 100).toFixed(1) + '%' : null,
                            dividendYield: parsed.summaryDetail?.dividendYield ? (parsed.summaryDetail.dividendYield * 100).toFixed(2) + '%' : null,
                            recommendation: parsed.financialData?.recommendationKey || null,
                            altmanZScore: parsed.altmanZScore !== null ? parsed.altmanZScore.toFixed(2) + ' (' + parsed.altmanZScoreZone + ')' : null,
                        };
                    }
                } catch (err) {
                    logger.error(`Error reading fundamentals for ${h.ticker} in portfolio analysis:`, err);
                }

                return {
                    ticker: h.ticker,
                    name: h.name,
                    value: h.currentValue,
                    unrealizedGainPct: h.unrealizedGainPct,
                    allocation: h.currentValue / portfolio.totalValue,
                    fundamentals: fundamentals
                };
            });

            const prompt = promptTemplate
                .replace('{TOTAL_VALUE}', portfolio.totalValue.toFixed(2))
                .replace('{PERF_1D}', portfolio.changePercent.toFixed(2))
                .replace('{ASSETS_JSON}', JSON.stringify(assetsList, null, 2));

            const engine = globalSettings.aiEngine || 'Gemini_Free';
            
            sendEvent('status', { message: 'Inizializzazione AI...', progress: 20 });
            
            const aiRes = await callAIModel(engine, prompt, globalSettings);
            
            sendEvent('status', { message: 'Lettura risposta...', progress: 80 });

            let parsed;
            try {
                const cleanText = aiRes.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                parsed = JSON.parse(cleanText);
            } catch (e) {
                parsed = {
                    riskScore: 5,
                    diversification: "Impossibile estrarre automaticamente il testo.",
                    actions: ["Consulta manualmente la risposta RAW"],
                    reasoning: aiRes.text
                };
            }

            const analysisRecord = {
                riskScore: parsed.riskScore || 5,
                diversification: parsed.diversification || '',
                actions: parsed.actions || [],
                reasoning: `### Analisi prodotta da ${engine} (${aiRes.modelUsed || 'N/D'})\n\n` + (parsed.reasoning || ''),
                raw_response: aiRes.text,
                tokens_used: aiRes.usage?.totalTokenCount || 0
            };

            const stmt = database.db.prepare(`
                INSERT INTO portfolio_ai_history (portfolioId, analysis_date, analysis_data) 
                VALUES (?, datetime('now'), ?)
            `);
            const info = stmt.run(req.params.id, JSON.stringify(analysisRecord));
            analysisRecord.id = info.lastInsertRowid;
            analysisRecord.date = new Date().toISOString();

            sendEvent('status', { message: 'Analisi completata.', progress: 100 });
            sendEvent('complete', { analysis: analysisRecord });
            
            return res.end();
            
        } catch (err) {
            logger.error(`[AI Portfolio Analysis Error]`, err);
            const errorMsg = err?.response?.data?.error?.message 
                          || (err?.response?.data ? JSON.stringify(err.response.data) : null)
                          || err.message 
                          || "Errore sconosciuto.";
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
            res.end();
        }
    });

    // GET /api/portfolios/:id/ai-history
    router.get('/:id/ai-history', requireAuth, requirePortfolioAccess, (req, res) => {
        try {
            const history = database.db.prepare(`
                SELECT id, analysis_date, analysis_data 
                FROM portfolio_ai_history 
                WHERE portfolioId = ? 
                ORDER BY analysis_date DESC
            `).all(req.params.id).map(r => ({
                id: r.id,
                date: r.analysis_date,
                data: JSON.parse(r.analysis_data)
            }));
            res.json(history);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /api/portfolios/:id/ai-history/:analysisId
    router.delete('/:id/ai-history/:analysisId', requireAuth, requirePortfolioAccess, (req, res) => {
        try {
            const stmt = database.db.prepare(`DELETE FROM portfolio_ai_history WHERE id = ? AND portfolioId = ?`);
            const info = stmt.run(req.params.analysisId, req.params.id);
            if (info.changes > 0) {
                res.json({ ok: true });
            } else {
                res.status(404).json({ error: 'Analisi non trovata' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/portfolios/:id/export
    router.get('/:id/export', requireAuth, requirePortfolioAccess, (req, res) => {
        try {
            const format = req.query.format || 'csv';
            const txs = database.db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date DESC').all(req.params.id);
            
            if (format === 'csv') {
                const fields = ['id', 'type', 'assetTicker', 'date', 'quantity', 'price', 'commission', 'tax', 'exchangeRate', 'amount', 'notes'];
                const csv = parse(txs, { fields });
                res.header('Content-Type', 'text/csv');
                res.attachment(`portfolio_${req.params.id}_transactions.csv`);
                return res.send(csv);
            } else {
                res.header('Content-Type', 'application/json');
                res.attachment(`portfolio_${req.params.id}_transactions.json`);
                return res.json(txs);
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/portfolios
    router.post('/', requireAuth, (req, res) => {
        const { name, currency, user_ids } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        
        try {
            database.db.transaction(() => {
                const todayStr = new Date().toISOString().split('T')[0];
                const info = database.db.prepare('INSERT INTO portfolios (name, currency, startDate, include_in_totals) VALUES (?, ?, ?, 1)').run(name, currency || 'EUR', todayStr);
                const pid = info.lastInsertRowid;
                
                database.db.prepare('INSERT INTO portfolio_users (portfolio_id, user_id, role) VALUES (?, ?, ?)')
                    .run(pid, req.user.id, 'owner');
                
                if (user_ids && Array.isArray(user_ids)) {
                    for (const uid of user_ids) {
                        if (uid !== req.user.id) {
                            database.db.prepare('INSERT INTO portfolio_users (portfolio_id, user_id, role) VALUES (?, ?, ?)')
                                .run(pid, uid, 'viewer');
                        }
                    }
                }
            })();
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // PUT /api/portfolios/:id
    router.put('/:id', requireAuth, requirePortfolioAccess, async (req, res) => {
        const { name, currency, include_in_totals, user_ids, tags } = req.body;
        try {
            if (name) database.db.prepare('UPDATE portfolios SET name = ? WHERE id = ?').run(name, req.params.id);
            if (currency) database.db.prepare('UPDATE portfolios SET currency = ? WHERE id = ?').run(currency, req.params.id);
            if (include_in_totals !== undefined) {
                database.db.prepare('UPDATE portfolios SET include_in_totals = ? WHERE id = ?').run(include_in_totals ? 1 : 0, req.params.id);
            }
            
            if (user_ids && Array.isArray(user_ids)) {
                database.db.transaction(() => {
                    database.db.prepare('DELETE FROM portfolio_users WHERE portfolio_id = ? AND role != ?').run(req.params.id, 'owner');
                    for (const uid of user_ids) {
                        if (uid !== req.user.id) {
                            database.db.prepare('INSERT INTO portfolio_users (portfolio_id, user_id, role) VALUES (?, ?, ?)')
                                .run(req.params.id, uid, 'viewer');
                        }
                    }
                })();
            }

            if (tags && Array.isArray(tags)) {
                database.db.transaction(() => {
                    database.db.prepare('DELETE FROM portfolio_tags WHERE portfolio_id = ?').run(req.params.id);
                    const stmt = database.db.prepare('INSERT INTO portfolio_tags (portfolio_id, tag_id) VALUES (?, ?)');
                    for (const tagId of tags) {
                        stmt.run(req.params.id, tagId);
                    }
                })();
            }
            
            if (typeof clearPerformanceCache === 'function') clearPerformanceCache();

            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /api/portfolios/:id
    router.delete('/:id', requireAuth, requirePortfolioAccess, (req, res) => {
        try {
            database.db.transaction(() => {
                database.db.prepare('DELETE FROM transactions WHERE portfolioId = ?').run(req.params.id);
                database.db.prepare('DELETE FROM portfolio_users WHERE portfolio_id = ?').run(req.params.id);
                database.db.prepare('DELETE FROM portfolio_history WHERE portfolioId = ?').run(req.params.id);
                database.db.prepare('DELETE FROM portfolio_losses WHERE portfolioId = ?').run(req.params.id);
                database.db.prepare('DELETE FROM portfolios WHERE id = ?').run(req.params.id);
            })();
            if (typeof clearPerformanceCache === 'function') clearPerformanceCache();
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/portfolios/:id/reconcile
    router.post('/:id/reconcile', requireAuth, requirePortfolioAccess, async (req, res) => {
        const { actualCash, date } = req.body;
        const portfolioId = req.params.id;

        if (actualCash == null) return res.status(400).send('actualCash is required');

        const liveRate = await getEurUsdRate();
        database.recalculatePortfolio(portfolioId, liveRate);
        
        const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
        if (!portfolio) return res.status(404).send('Portfolio not found');

        const diff = parseFloat(actualCash) - portfolio.currentCash;

        if (Math.abs(diff) < 0.01) {
            return res.json({ message: 'Balance already reconciled', diff: 0 });
        }

        const type = diff > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
        const amount = Math.abs(diff);

        database.db.prepare(`
            INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            parseInt(portfolioId), type, 'CASH',
            date || new Date().toISOString().split('T')[0],
            0, 0, 0, 0, 1, amount
        );

        const reconciliationDate = date || new Date().toISOString().split('T')[0];
        database.db.prepare(`
            UPDATE portfolio_history 
            SET totalValue = totalValue + ?, 
                cashValue = cashValue + ? 
            WHERE (portfolioId = ? OR portfolioId IS NULL) 
              AND date >= ?
        `).run(diff, diff, parseInt(portfolioId), reconciliationDate);

        database.recalculatePortfolio(portfolioId, liveRate);
        if (typeof clearPerformanceCache === 'function') clearPerformanceCache();

        res.json({ 
            message: 'Reconciliation successful', 
            diff, 
            newCash: actualCash 
        });
    });

    return router;
};
