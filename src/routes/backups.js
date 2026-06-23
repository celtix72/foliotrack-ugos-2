const express = require('express');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        requireAdmin,
        database,
        logger,
        logAudit,
        backupManager,
        clearPerformanceCache,
        setLastUpdateTime
    } = dependencies;

    // GET /api/backups (SQLite - Admin Only)
    router.get('/', requireAuth, requireAdmin, (req, res) => {
        res.json(backupManager.listBackups());
    });

    // POST /api/backups/manual (Admin Only)
    router.post('/manual', requireAuth, requireAdmin, async (req, res) => {
        try {
            const metadata = await backupManager.createBackup(false);
            res.json(metadata);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/backups/restore (Admin Only)
    router.post('/restore', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { filename } = req.body;
            if (!filename) return res.status(400).send('Filename required');
            await backupManager.restoreBackup(filename);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/backups/:filename (Admin Only)
    router.delete('/:filename', requireAuth, requireAdmin, (req, res) => {
        try {
            backupManager.deleteBackup(req.params.filename);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/backups/export (User Export - JSON)
    router.get('/export', requireAuth, async (req, res) => {
        try {
            const userId = req.user.id;
            const data = {
                version: '2.0',
                exportedAt: new Date().toISOString(),
                portfolios: [],
                transactions: [],
                settings: [],
                tax_rates: [],
                user_watchlist: [],
                notifications: [],
                dividend_projections: [],
                portfolio_history: []
            };

            const portfolios = database.db.prepare(`
                SELECT p.* FROM portfolios p 
                JOIN portfolio_users pu ON p.id = pu.portfolio_id 
                WHERE pu.user_id = ?
            `).all(userId);
            data.portfolios = portfolios;

            const pIds = portfolios.map(p => p.id);
            if (pIds.length > 0) {
                const placeholders = pIds.map(() => '?').join(',');
                data.transactions = database.db.prepare(`SELECT * FROM transactions WHERE portfolioId IN (${placeholders})`).all(...pIds);
                data.portfolio_history = database.db.prepare(`SELECT * FROM portfolio_history WHERE portfolioId IN (${placeholders})`).all(...pIds);
            }
            
            const globalHistory = database.db.prepare(`SELECT * FROM portfolio_history WHERE portfolioId IS NULL AND user_id = ?`).all(userId);
            data.portfolio_history.push(...globalHistory);

            data.settings = database.db.prepare(`SELECT * FROM settings WHERE user_id = ?`).all(userId);
            data.tax_rates = database.db.prepare(`SELECT * FROM tax_rates WHERE user_id = ?`).all(userId);
            data.user_watchlist = database.db.prepare(`SELECT * FROM user_watchlist WHERE user_id = ?`).all(userId);
            data.notifications = database.db.prepare(`SELECT * FROM notifications WHERE user_id = ?`).all(userId);
            data.dividend_projections = database.db.prepare(`SELECT * FROM dividend_projections WHERE user_id = ?`).all(userId);

            res.setHeader('Content-disposition', `attachment; filename=foliotracker_export_${new Date().toISOString().split('T')[0]}.json`);
            res.setHeader('Content-type', 'application/json');
            
            logAudit(userId, 'DATA_EXPORT', { count: data.portfolios.length }, req);
            
            res.send(JSON.stringify(data, null, 2));
        } catch (err) {
            logger.error('Export failed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/backups/import (User Import - JSON)
    router.post('/import', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
        try {
            const userId = req.user.id;
            const data = req.body;
            if (!data || !data.portfolios) return res.status(400).json({ error: 'Invalid backup format' });

            database.db.transaction(() => {
                const pIdMap = {};
                for (const p of data.portfolios) {
                    const oldId = p.id;
                    delete p.id;
                    const result = database.db.prepare(`
                        INSERT INTO portfolios (name, type, currency, startDate, initialCash, currentCash, totalValue, performance1D, performance1DPrePost, totalDividends, investedCapital, assetCount, color)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(p.name, p.type, p.currency, p.startDate, p.initialCash, p.currentCash, p.totalValue, p.performance1D, p.performance1DPrePost, p.totalDividends, p.investedCapital, p.assetCount, p.color);
                    const newId = result.lastInsertRowid;
                    pIdMap[oldId] = newId;
                    
                    database.db.prepare(`INSERT INTO portfolio_users (portfolio_id, user_id) VALUES (?, ?)`).run(newId, userId);
                }

                for (const t of data.transactions) {
                    const newPId = pIdMap[t.portfolioId];
                    if (!newPId) continue;
                    database.db.prepare(`
                        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(newPId, t.type, t.assetTicker, t.date, t.quantity, t.price, t.commission, t.tax, t.exchangeRate, t.amount);
                }

                for (const s of data.settings) {
                    database.db.prepare(`INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)`).run(userId, s.key, s.value);
                }

                for (const tr of data.tax_rates) {
                    database.db.prepare(`INSERT OR REPLACE INTO tax_rates (user_id, asset_type, rate) VALUES (?, ?, ?)`).run(userId, tr.asset_type, tr.rate);
                }

                for (const w of data.user_watchlist) {
                    database.db.prepare(`INSERT OR REPLACE INTO user_watchlist (user_id, ticker, targetPrice, stopLoss, volatilityAlert) VALUES (?, ?, ?, ?, ?)`).run(userId, w.ticker, w.targetPrice, w.stopLoss, w.volatilityAlert);
                }

                for (const dp of data.dividend_projections) {
                    database.db.prepare(`INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, yield, tag, year, isCustom) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, dp.ticker, dp.name, dp.exDate, dp.amount, dp.totalAmount, dp.yield, dp.tag, dp.year, dp.isCustom);
                }

                for (const ph of data.portfolio_history) {
                    const newPId = ph.portfolioId ? pIdMap[ph.portfolioId] : null;
                    if (ph.portfolioId && !newPId) continue; 
                    database.db.prepare(`INSERT INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newPId, userId, ph.date, ph.totalValue, ph.cashValue, ph.assetValue, ph.netDeposits);
                }
            })();

            res.json({ success: true, message: 'Data imported successfully' });
        } catch (err) {
            logger.error('Import failed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/reset-data
    router.post('/reset-data', requireAuth, (req, res) => {
        const userId = req.user.id;
        const isAdmin = req.user.role === 'admin';
        const scope = req.query.scope || 'user';

        logger.info(`Initiating data reset (Scope: ${scope}) for user ${userId}...`);
        logAudit(userId, 'DATA_RESET', { scope }, req);
        
        try {
            database.db.transaction(() => {
                if (isAdmin && scope === 'system') {
                    const tables = [
                        'notifications', 'portfolio_history', 'portfolio_losses', 'asset_quotes', 
                        'dividend_projections', 'transactions', 'portfolios', 'assets', 
                        'tax_rates', 'settings', 'test'
                    ];
                    for (const table of tables) {
                        try { database.db.prepare(`DELETE FROM ${table}`).run(); } catch (e) {}
                    }
                    database.initDb();
                    logger.info('FULL SYSTEM RESET COMPLETED.');
                } else {
                    const pIds = database.db.prepare(`SELECT portfolio_id FROM portfolio_users WHERE user_id = ?`).all(userId).map(r => r.portfolio_id);
                    for (const pId of pIds) {
                        const usersCount = database.db.prepare(`SELECT COUNT(*) as c FROM portfolio_users WHERE portfolio_id = ?`).get(pId).c;
                        if (usersCount <= 1) {
                            database.db.prepare(`DELETE FROM portfolios WHERE id = ?`).run(pId);
                        } else {
                            database.db.prepare(`DELETE FROM portfolio_users WHERE portfolio_id = ? AND user_id = ?`).run(pId, userId);
                        }
                    }
                    
                    const userTables = ['notifications', 'portfolio_history', 'dividend_projections', 'user_watchlist', 'tax_rates', 'settings'];
                    for (const table of userTables) {
                        database.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
                    }
                    logger.info(`User-level data reset completed for user ${userId}.`);
                }
            })();

            clearPerformanceCache();
            setLastUpdateTime(0);
            res.json({ success: true, message: scope === 'system' ? 'Application has been fully reset.' : 'Your data has been reset.' });
        } catch (err) {
            logger.error('RESET ERROR:', err);
            res.status(500).json({ error: 'Reset failed: ' + err.message });
        }
    });

    return router;
};
