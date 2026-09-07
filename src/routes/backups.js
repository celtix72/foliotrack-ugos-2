const express = require('express');
const path = require('path');
const fs = require('fs');

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

    // POST /api/backups/manual or /api/backups/run (Admin Only)
    router.post(['/manual', '/run'], requireAuth, requireAdmin, async (req, res) => {
        try {
            const metadata = await backupManager.createBackup(false);
            if (logAudit) logAudit(req.user.id, 'BACKUP_CREATE_MANUAL', { filename: metadata.filename }, req);
            res.json(metadata);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/backups/download/:filename (Admin Only) - Download .db or .zip backup file
    router.get('/download/:filename', requireAuth, requireAdmin, (req, res) => {
        try {
            const filename = req.params.filename;
            const safeName = path.basename(filename);
            if (!safeName.match(/^(?:backup-[\w.-]+-(?:auto|manual)\.db|foliotrack_backup_[\w.-]+\.zip)$/)) {
                return res.status(400).json({ error: 'Nome file di backup non valido' });
            }
            const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
            const filePath = path.join(BACKUP_DIR, safeName);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File di backup non trovato' });
            }
            res.download(filePath, safeName);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Google Drive Backup Endpoints ──
    const gdriveService = require('../services/gdriveBackupService');

    // POST /api/backups/gdrive/test (Admin Only)
    router.post('/gdrive/test', requireAuth, requireAdmin, async (req, res) => {
        try {
            const userSettings = database.getSettings ? database.getSettings(req.user.id) : null;
            const result = await gdriveService.testGDriveConnection(userSettings);
            res.json(result);
        } catch (err) {
            res.json({ success: false, error: err.response?.data?.error?.message || err.message });
        }
    });

    // POST /api/backups/gdrive/run (Admin Only) - Manual Zip Backup to Google Drive
    router.post('/gdrive/run', requireAuth, requireAdmin, async (req, res) => {
        try {
            const userSettings = database.getSettings ? database.getSettings(req.user.id) : null;
            const result = await gdriveService.runGDriveBackup(false, userSettings);
            if (logAudit) logAudit(req.user.id, 'GDRIVE_BACKUP_MANUAL', { zipName: result.zipName, size: result.size }, req);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err.response?.data?.error?.message || err.message });
        }
    });

    // GET /api/backups/gdrive/files (Admin Only) - List files on Google Drive
    router.get('/gdrive/files', requireAuth, requireAdmin, async (req, res) => {
        try {
            const userSettings = database.getSettings ? database.getSettings(req.user.id) : null;
            const folderId = userSettings ? (userSettings.gdrive_folder_id || '').trim() : '';
            const clientEmail = userSettings ? (userSettings.gdrive_client_email || '').trim() : '';
            const privateKey = userSettings ? (userSettings.gdrive_private_key || '').trim() : '';
            const clientId = userSettings ? (userSettings.gdrive_client_id || '').trim() : '';
            const clientSecret = userSettings ? (userSettings.gdrive_client_secret || '').trim() : '';
            const refreshToken = userSettings ? (userSettings.gdrive_refresh_token || '').trim() : '';

            const isConfigured = folderId && ((clientEmail && privateKey) || (clientId && clientSecret && refreshToken));
            if (!isConfigured) {
                return res.json({ configured: false, files: [], message: 'Google Drive non configurato' });
            }

            const files = await gdriveService.listRemoteBackups(userSettings);
            const gdriveFiles = files.filter(f => f.name.startsWith('foliotrack_backup_') && f.name.endsWith('.zip'));
            const { keepers, toDelete } = gdriveService.evaluateRetentionPolicy(gdriveFiles);
            
            const result = gdriveFiles.map(f => {
                const isKeeper = keepers.some(k => k.id === f.id);
                return {
                    id: f.id,
                    name: f.name,
                    createdTime: f.createdTime,
                    size: f.size,
                    status: isKeeper ? 'Conservato (Retention)' : 'In eliminazione'
                };
            });
            res.json({ configured: true, files: result });
        } catch (err) {
            if (logger) logger.warn(`[GDrive] Impossibile recuperare lista file remoti: ${err.message}`);
            res.json({ configured: false, files: [], error: err.response?.data?.error?.message || err.message });
        }
    });

    // POST /api/backups/restore or /api/backups/restore/:filename (Admin Only)
    router.post(['/restore', '/restore/:filename'], requireAuth, requireAdmin, async (req, res) => {
        try {
            const filename = req.params.filename || req.body.filename;
            if (!filename) return res.status(400).json({ error: 'Filename required' });
            await backupManager.restoreBackup(filename);
            if (logAudit) logAudit(req.user.id, 'BACKUP_RESTORE', { filename }, req);
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

    // GET /api/backups/export (User Export - JSON: all data and settings)
    router.get('/export', requireAuth, async (req, res) => {
        try {
            const userId = req.user.id;
            const data = {
                version: '2.1',
                exportedAt: new Date().toISOString(),
                user: { id: userId, username: req.user.username },
                portfolios: [],
                transactions: [],
                settings: [],
                tax_rates: [],
                user_watchlist: [],
                notifications: [],
                dividend_projections: [],
                portfolio_history: [],
                notes: [],
                tags: [],
                portfolio_tags: [],
                asset_tags: [],
                portfolio_losses: [],
                assets: [],
                ai_portfolio_reports: []
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
                data.transactions = database.db.prepare(`SELECT * FROM transactions WHERE portfolioId IN (${placeholders}) ORDER BY date ASC`).all(...pIds);
                data.portfolio_history = database.db.prepare(`SELECT * FROM portfolio_history WHERE portfolioId IN (${placeholders}) ORDER BY date ASC`).all(...pIds);
                data.portfolio_losses = database.db.prepare(`SELECT * FROM portfolio_losses WHERE portfolioId IN (${placeholders})`).all(...pIds);
                data.portfolio_tags = database.db.prepare(`SELECT * FROM portfolio_tags WHERE portfolio_id IN (${placeholders})`).all(...pIds);
                data.asset_tags = database.db.prepare(`SELECT * FROM asset_tags WHERE portfolio_id IN (${placeholders})`).all(...pIds);
            }
            
            const globalHistory = database.db.prepare(`SELECT * FROM portfolio_history WHERE portfolioId IS NULL AND user_id = ? ORDER BY date ASC`).all(userId);
            data.portfolio_history.push(...globalHistory);

            data.settings = database.db.prepare(`SELECT * FROM settings WHERE user_id = ?`).all(userId);
            data.tax_rates = database.db.prepare(`SELECT * FROM tax_rates WHERE user_id = ?`).all(userId);
            data.user_watchlist = database.db.prepare(`SELECT * FROM user_watchlist WHERE user_id = ?`).all(userId);
            data.notifications = database.db.prepare(`SELECT * FROM notifications WHERE user_id = ?`).all(userId);
            data.dividend_projections = database.db.prepare(`SELECT * FROM dividend_projections WHERE user_id = ?`).all(userId);
            data.notes = database.db.prepare(`SELECT * FROM notes WHERE user_id = ?`).all(userId);
            data.tags = database.db.prepare(`SELECT * FROM tags WHERE user_id = ?`).all(userId);
            data.ai_portfolio_reports = database.db.prepare(`SELECT * FROM ai_portfolio_reports WHERE user_id = ?`).all(userId);

            // Assets associated with user's portfolios, watchlist, or projections
            const assetTickers = new Set([
                ...data.transactions.map(t => t.assetTicker).filter(t => t && t !== 'CASH'),
                ...data.user_watchlist.map(w => w.ticker).filter(Boolean),
                ...data.dividend_projections.map(d => d.ticker).filter(Boolean)
            ]);
            if (assetTickers.size > 0) {
                const aPlaceholders = Array.from(assetTickers).map(() => '?').join(',');
                data.assets = database.db.prepare(`SELECT * FROM assets WHERE ticker IN (${aPlaceholders})`).all(...Array.from(assetTickers));
            }

            res.setHeader('Content-disposition', `attachment; filename=foliotracker_export_${new Date().toISOString().split('T')[0]}.json`);
            res.setHeader('Content-type', 'application/json');
            
            logAudit(userId, 'DATA_EXPORT', { count: data.portfolios.length, txCount: data.transactions.length }, req);
            
            res.send(JSON.stringify(data, null, 2));
        } catch (err) {
            logger.error('Export failed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/backups/import (User Import - JSON: restores all data and settings)
    router.post('/import', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
        try {
            const userId = req.user.id;
            const data = req.body;
            if (!data || !data.portfolios) return res.status(400).json({ error: 'Formato backup non valido' });

            database.db.transaction(() => {
                // 1. Assets
                if (Array.isArray(data.assets)) {
                    for (const a of data.assets) {
                        database.db.prepare(`
                            INSERT OR REPLACE INTO assets (
                                id, ticker, name, type, exchange, currency, currentPrice, changePercent,
                                pe, country, targetPrice, stopLoss, isManual, dataSource, isin, updatedAt
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            a.id || a.ticker, a.ticker, a.name, a.type || 'Stock', a.exchange || 'N/A',
                            a.currency || 'EUR', a.currentPrice || 0, a.changePercent || 0,
                            a.pe || null, a.country || 'N/A', a.targetPrice || null, a.stopLoss || null,
                            a.isManual || 0, a.dataSource || 'YF', a.isin || null, a.updatedAt || new Date().toISOString()
                        );
                    }
                }

                // 2. Portfolios
                const pIdMap = {};
                for (const p of data.portfolios) {
                    const oldId = p.id;
                    const result = database.db.prepare(`
                        INSERT INTO portfolios (name, type, currency, startDate, initialCash, currentCash, totalValue, performance1D, performance1DPrePost, totalDividends, investedCapital, assetCount, color)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(p.name, p.type, p.currency, p.startDate, p.initialCash, p.currentCash, p.totalValue, p.performance1D, p.performance1DPrePost, p.totalDividends, p.investedCapital, p.assetCount, p.color);
                    const newId = result.lastInsertRowid;
                    pIdMap[oldId] = newId;
                    
                    database.db.prepare(`INSERT INTO portfolio_users (portfolio_id, user_id) VALUES (?, ?)`).run(newId, userId);
                }

                // 3. Transactions
                if (Array.isArray(data.transactions)) {
                    for (const t of data.transactions) {
                        const newPId = pIdMap[t.portfolioId];
                        if (!newPId) continue;
                        database.db.prepare(`
                            INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount, notes)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(newPId, t.type, t.assetTicker, t.date, t.quantity, t.price, t.commission, t.tax, t.exchangeRate, t.amount, t.notes || null);
                    }
                }

                // 4. Settings
                if (Array.isArray(data.settings)) {
                    for (const s of data.settings) {
                        database.db.prepare(`INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)`).run(userId, s.key, s.value);
                    }
                }

                // 5. Tax Rates
                if (Array.isArray(data.tax_rates)) {
                    for (const tr of data.tax_rates) {
                        database.db.prepare(`INSERT OR REPLACE INTO tax_rates (user_id, asset_type, rate) VALUES (?, ?, ?)`).run(userId, tr.asset_type, tr.rate);
                    }
                }

                // 6. User Watchlist
                if (Array.isArray(data.user_watchlist)) {
                    for (const w of data.user_watchlist) {
                        database.db.prepare(`INSERT OR REPLACE INTO user_watchlist (user_id, ticker, targetPrice, stopLoss, volatilityAlert) VALUES (?, ?, ?, ?, ?)`).run(userId, w.ticker, w.targetPrice, w.stopLoss, w.volatilityAlert);
                    }
                }

                // 7. Dividend Projections
                if (Array.isArray(data.dividend_projections)) {
                    for (const dp of data.dividend_projections) {
                        database.db.prepare(`INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, yield, tag, year, isCustom) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, dp.ticker, dp.name, dp.exDate, dp.amount, dp.totalAmount, dp.yield, dp.tag, dp.year, dp.isCustom);
                    }
                }

                // 8. Portfolio History
                if (Array.isArray(data.portfolio_history)) {
                    for (const ph of data.portfolio_history) {
                        const newPId = ph.portfolioId ? pIdMap[ph.portfolioId] : null;
                        if (ph.portfolioId && !newPId) continue; 
                        database.db.prepare(`INSERT INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newPId, userId, ph.date, ph.totalValue, ph.cashValue, ph.assetValue, ph.netDeposits);
                    }
                }

                // 9. Notes
                if (Array.isArray(data.notes)) {
                    for (const n of data.notes) {
                        database.db.prepare(`
                            INSERT INTO notes (user_id, title, content, color, pinned, asset_symbol, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(userId, n.title || '', n.content || '', n.color || '#3b82f6', n.pinned || 0, n.asset_symbol || null, n.created_at || new Date().toISOString(), n.updated_at || new Date().toISOString());
                    }
                }

                // 10. Tags & Associations
                if (Array.isArray(data.tags)) {
                    const tagIdMap = {};
                    for (const tag of data.tags) {
                        const oldTagId = tag.id;
                        const res = database.db.prepare(`INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)`).run(userId, tag.name, tag.color || '#3b82f6');
                        tagIdMap[oldTagId] = res.lastInsertRowid;
                    }
                    if (Array.isArray(data.portfolio_tags)) {
                        for (const pt of data.portfolio_tags) {
                            const newPId = pIdMap[pt.portfolio_id];
                            const newTagId = tagIdMap[pt.tag_id];
                            if (newPId && newTagId) {
                                try { database.db.prepare(`INSERT OR IGNORE INTO portfolio_tags (portfolio_id, tag_id) VALUES (?, ?)`).run(newPId, newTagId); } catch(e) {}
                            }
                        }
                    }
                    if (Array.isArray(data.asset_tags)) {
                        for (const at of data.asset_tags) {
                            const newPId = pIdMap[at.portfolio_id];
                            const newTagId = tagIdMap[at.tag_id];
                            if (newPId && newTagId) {
                                try { database.db.prepare(`INSERT OR IGNORE INTO asset_tags (portfolio_id, ticker, tag_id) VALUES (?, ?, ?)`).run(newPId, at.ticker, newTagId); } catch(e) {}
                            }
                        }
                    }
                }

                // 11. Portfolio Losses
                if (Array.isArray(data.portfolio_losses)) {
                    for (const pl of data.portfolio_losses) {
                        const newPId = pIdMap[pl.portfolioId];
                        if (newPId) {
                            database.db.prepare(`INSERT INTO portfolio_losses (portfolioId, asset_type, amount) VALUES (?, ?, ?)`).run(newPId, pl.asset_type, pl.amount);
                        }
                    }
                }

                // 12. AI Portfolio Reports
                if (Array.isArray(data.ai_portfolio_reports)) {
                    for (const r of data.ai_portfolio_reports) {
                        database.db.prepare(`
                            INSERT INTO ai_portfolio_reports (user_id, date, risk_score, diversification_score, allocation_score, quality_score, pe_value, markdown_content, raw_context, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(userId, r.date, r.risk_score, r.diversification_score, r.allocation_score, r.quality_score, r.pe_value, r.markdown_content, r.raw_context, r.created_at);
                    }
                }
            })();

            res.json({ success: true, message: 'Dati e impostazioni importati con successo' });
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
