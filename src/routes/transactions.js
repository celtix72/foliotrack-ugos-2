const express = require('express');
const { detectBroker, parseDirecta, parseIfis } = require('../utils/brokerParsers');

/**
 * Transactions Router
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        requireAdmin,
        requirePortfolioAccess,
        database,
        logger,
        yahooFinance,
        getEurUsdRate,
        fetchAssetMetadata,
        clearPerformanceCache,
        notifyUser,
        triggerHistoryRebuild,
        refreshDividendProjections,
        sanitizeTicker,
        APP_VERSION
    } = dependencies;

    // ─── TRANSACTION AUDIT ───────────────────────────────────────────────────
    // Each user sees only their own portfolios; admin sees everything.
    router.get('/transactions/audit', requireAuth, async (req, res) => {
        try {
            let portfolios;
            if (req.user.role === 'admin') {
                portfolios = database.db.prepare(`SELECT id, name, currency FROM portfolios`).all();
            } else {
                portfolios = database.db.prepare(`
                    SELECT p.id, p.name, p.currency FROM portfolios p
                    JOIN portfolio_users pu ON p.id = pu.portfolio_id
                    WHERE pu.user_id = ?
                `).all(req.user.id);
            }
            const pMap = Object.fromEntries(portfolios.map(p => [p.id, p]));
            
            const assets = database.db.prepare(`SELECT ticker, name, currency, isVirtualHistory, hasHistoryInconsistency FROM assets`).all();
            const aMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

            let transactions;
            if (req.user.role === 'admin') {
                transactions = database.db.prepare(`SELECT * FROM transactions ORDER BY date ASC, id ASC`).all();
            } else {
                const pIds = portfolios.map(p => p.id);
                if (pIds.length === 0) return res.json([]);
                const ph = pIds.map(() => '?').join(',');
                transactions = database.db.prepare(`
                    SELECT * FROM transactions WHERE portfolioId IN (${ph}) ORDER BY date ASC, id ASC
                `).all(...pIds);
            }
            
            const pmcStats = {}; // { portfolioId: { ticker: { shares: 0, costEUR: 0 } } }
            
            const audit = transactions.map(t => {
                const p = pMap[t.portfolioId] || { name: 'Unknown', currency: 'EUR' };
                const a = aMap[t.assetTicker] || { name: t.assetTicker || 'CASH', currency: 'EUR' };
                
                const qty = t.quantity || 0;
                const price = t.price || 0;
                const comm = t.commission || 0;
                const tax = t.tax || 0;
                const fx = t.exchangeRate || 1;
                
                // Fixed Amount Calculation (consistent with the rest of the app)
                const amountEUR = t.amount ? t.amount : (qty * price + (t.type === 'BUY' ? comm + tax : -comm - tax)) / fx;
                
                if (!pmcStats[t.portfolioId]) pmcStats[t.portfolioId] = {};
                if (t.assetTicker && !pmcStats[t.portfolioId][t.assetTicker]) {
                    pmcStats[t.portfolioId][t.assetTicker] = { shares: 0, costEUR: 0 };
                }
                
                const stats = t.assetTicker ? pmcStats[t.portfolioId][t.assetTicker] : null;
                let pmcEURBefore = stats && stats.shares > 0 ? stats.costEUR / stats.shares : 0;
                let realizedGainEUR = 0;
                
                if (t.type === 'BUY' && stats) {
                    stats.shares += qty;
                    stats.costEUR += amountEUR;
                } else if (t.type === 'SELL' && stats) {
                    const costBasis = qty * pmcEURBefore;
                    realizedGainEUR = amountEUR - costBasis;
                    stats.shares -= qty;
                    stats.costEUR -= costBasis;
                    if (stats.shares <= 0.0001) {
                        stats.shares = 0;
                        stats.costEUR = 0;
                    }
                } else if (t.type === 'DIVIDEND') {
                    realizedGainEUR = amountEUR;
                }
                
                return {
                    ...t,
                    portfolioName: p.name,
                    assetName: a.name,
                    assetCurrency: a.currency,
                    amountEUR: amountEUR,
                    pmcEURBefore: pmcEURBefore,
                    realizedGainEUR: realizedGainEUR,
                    isVirtualHistory: a.isVirtualHistory,
                    hasHistoryInconsistency: a.hasHistoryInconsistency
                };
            });
            
            res.json(audit);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ─── GET TRANSACTIONS ────────────────────────────────────────────────────
    router.get('/transactions', requireAuth, (req, res) => {
        const { portfolioId, assetTicker, id } = req.query;
        
        // Isolation: Filter by portfolios user has access to
        let query = `
            SELECT t.* FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE pu.user_id = ?
        `;
        let params = [req.user.id];
        
        if (id) {
            query += `AND t.id = ? `;
            params.push(id);
        }
        if (portfolioId) {
            query += `AND t.portfolioId = ? `;
            params.push(portfolioId);
        }
        if (assetTicker) {
            query += `AND assetTicker = ? `;
            params.push(assetTicker);
        }
        
        query += `ORDER BY date ASC`;
        res.json(database.db.prepare(query).all(...params));
    });

    // ─── CREATE TRANSACTION ──────────────────────────────────────────────────
    router.post('/transactions', requireAuth, requirePortfolioAccess, async (req, res) => {
        const { 
            portfolioId, type, assetTicker, date, quantity, price, 
            commission, tax, exchangeRate, amount, destinationPortfolioId, 
            isin, dataSource, assetName, assetCurrency, assetType, assetExchange, assetCountry 
        } = req.body;
        
        if (!portfolioId) return res.status(400).send('portfolioId is required');

        const sanitizedTicker = sanitizeTicker(assetTicker);

        // Auto-create/update asset with ISIN and Data Source
        if (sanitizedTicker && sanitizedTicker !== 'CASH') {
            const existingAsset = database.db.prepare(`SELECT id, dataSource FROM assets WHERE ticker = ?`).get(sanitizedTicker);
            if (existingAsset) {
                database.db.prepare(`
                    UPDATE assets SET 
                        isin = COALESCE(?, isin), 
                        dataSource = COALESCE(?, dataSource),
                        name = COALESCE(?, name),
                        currency = COALESCE(?, currency)
                    WHERE ticker = ?
                `).run(isin || null, dataSource || null, assetName || null, assetCurrency || null, sanitizedTicker);
            } else {
                let metadata = {};
                // Only fetch metadata if NOT manual
                if (dataSource !== 'MANUAL') {
                    try {
                        metadata = await fetchAssetMetadata(sanitizedTicker) || {};
                    } catch(e) { metadata = {}; }
                }
                
                database.db.prepare(`
                    INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `).run(
                    sanitizedTicker, 
                    sanitizedTicker, 
                    assetName || metadata.name || sanitizedTicker, 
                    assetType || metadata.type || (dataSource === 'MANUAL' ? 'Manual' : 'Stock'), 
                    assetExchange || metadata.exchange || (dataSource === 'MANUAL' ? 'MANUAL' : 'N/A'), 
                    assetCurrency || metadata.currency || 'USD', 
                    metadata.currentPrice || price || 0, 
                    metadata.changePercent || 0, 
                    metadata.pe || null, 
                    assetCountry || metadata.country || (dataSource === 'MANUAL' ? 'Manual' : 'N/A'), 
                    (dataSource === 'MANUAL' ? 1 : 0),
                    dataSource || 'YF', 
                    isin || metadata.isin || null
                );
            }
        }

        let finalQty = parseFloat(quantity || 0);
        let finalPrice = parseFloat(price || 0);
        let finalExRate = parseFloat(exchangeRate || 1);

        // Enforcement for CD_ assets: Quantity is always 1, Currency is always EUR
        if (sanitizedTicker && sanitizedTicker.startsWith('CD_')) {
            finalQty = 1.0;
            finalExRate = 1.0;
        }

        const result = database.db.prepare(`
            INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            parseInt(portfolioId), type, sanitizedTicker || '',
            date || new Date().toISOString().split('T')[0],
            finalQty, finalPrice,
            parseFloat(commission || 0), parseFloat(tax || 0),
            finalExRate, parseFloat(amount || 0)
        );

        // Dividend Notification
        if (type === 'DIVIDEND' && sanitizedTicker) {
            const userId = req.user.id;
            const netAmount = parseFloat(amount || 0) - parseFloat(tax || 0);
            notifyUser(userId, 'DIVIDEND', {
                title: 'DIVIDENDO RICEVUTO 💰',
                body: `${sanitizedTicker}: +€${netAmount.toFixed(2)} (Netto)`,
                telegramMessage: `*💰 DIVIDENDO RICEVUTO*\n\nAsset: \`${sanitizedTicker}\`\nImporto Netto: \`€${netAmount.toFixed(2)}\`\nData: \`${date}\``,
                data: { url: '/dividend' }
            });
        }

        const liveRate = await getEurUsdRate();

        // Automation for TRANSFER: Create a DEPOSIT in the destination portfolio and link them
        if (type === 'TRANSFER' && destinationPortfolioId) {
            const srcPort = database.db.prepare("SELECT currency FROM portfolios WHERE id = ?").get(parseInt(portfolioId));
            const destPort = database.db.prepare("SELECT currency FROM portfolios WHERE id = ?").get(parseInt(destinationPortfolioId));
            
            if (srcPort && destPort) {
                let fxRate = 1.0;
                if (srcPort.currency !== destPort.currency) {
                    const txDate = date || new Date().toISOString().split('T')[0];
                    const quote = database.db.prepare("SELECT price FROM asset_quotes WHERE ticker = 'EURUSD=X' AND date = ?").get(txDate);
                    if (quote && quote.price > 0) {
                        fxRate = quote.price;
                    } else {
                        const current = database.db.prepare("SELECT currentPrice FROM assets WHERE ticker = 'EURUSD=X'").get();
                        if (current && current.currentPrice > 0) {
                            fxRate = current.currentPrice;
                        } else {
                            fxRate = liveRate || 1.1;
                        }
                    }
                }
                
                let destAmount = parseFloat(amount || 0);
                if (srcPort.currency === 'USD' && destPort.currency === 'EUR') {
                    destAmount = parseFloat(amount || 0) / fxRate;
                } else if (srcPort.currency === 'EUR' && destPort.currency === 'USD') {
                    destAmount = parseFloat(amount || 0) * fxRate;
                }

                // Insert the DEPOSIT transaction in the destination portfolio
                const destResult = database.db.prepare(`
                    INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    parseInt(destinationPortfolioId), 'DEPOSIT', 'CASH',
                    date || new Date().toISOString().split('T')[0],
                    0, 0, 0, 0, 1, destAmount
                );
                
                const sourceTxId = result.lastInsertRowid;
                const destTxId = destResult.lastInsertRowid;
                
                // Link both transactions together
                database.db.prepare(`
                    UPDATE transactions SET linkedTransactionId = ? WHERE id = ?
                `).run(destTxId, sourceTxId);
                
                database.db.prepare(`
                    UPDATE transactions SET linkedTransactionId = ? WHERE id = ?
                `).run(sourceTxId, destTxId);
                
                database.recalculatePortfolio(destinationPortfolioId, liveRate);
                triggerHistoryRebuild(destinationPortfolioId);
            }
        }

        database.recalculatePortfolio(portfolioId, liveRate);
        clearPerformanceCache();
        
        // Auto-rebuild history for this portfolio
        triggerHistoryRebuild(portfolioId);
        
        // Auto-refresh dividend projections (non-blocking)
        refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error:", e));

        res.status(201).json(database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(result.lastInsertRowid));
    });

    // ─── DELETE TRANSACTION ──────────────────────────────────────────────────
    router.delete('/transactions/:id', requireAuth, async (req, res) => {
        const row = database.db.prepare(`
            SELECT t.* FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE t.id = ? AND pu.user_id = ?
        `).get(req.params.id, req.user.id);
        
        if (!row && req.user.role !== 'admin') return res.status(404).send('Transaction not found or access denied');
        
        const finalRow = row || database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
        if (!finalRow) return res.status(404).send('Transaction not found');

        let linkedPortfolioId = null;
        if (finalRow.linkedTransactionId) {
            const linkedTx = database.db.prepare(`SELECT id, portfolioId FROM transactions WHERE id = ?`).get(finalRow.linkedTransactionId);
            if (linkedTx) {
                linkedPortfolioId = linkedTx.portfolioId;
                database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(linkedTx.id);
            }
        }
        
        database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(req.params.id);
        const liveRate = await getEurUsdRate();
        database.recalculatePortfolio(row.portfolioId, liveRate);

        if (linkedPortfolioId) {
            database.recalculatePortfolio(linkedPortfolioId, liveRate);
            triggerHistoryRebuild(linkedPortfolioId);
        }
        
        // Check if the ticker has any remaining transactions globally
        if (row.assetTicker && row.assetTicker !== 'CASH') {
            const remainingTxs = database.db.prepare(`SELECT COUNT(*) as count FROM transactions WHERE assetTicker = ?`).get(row.assetTicker);
            if (remainingTxs.count === 0) {
                // Check if it's on the watchlist
                const asset = database.db.prepare(`SELECT inWatchlist FROM assets WHERE ticker = ?`).get(row.assetTicker);
                if (asset && asset.inWatchlist === 0) {
                    database.db.prepare(`DELETE FROM assets WHERE ticker = ?`).run(row.assetTicker);
                }
            }
        }

        clearPerformanceCache();
        
        // Auto-rebuild history for this portfolio
        triggerHistoryRebuild(row.portfolioId);

        // Auto-refresh dividend projections (non-blocking)
        refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error:", e));

        res.json(row);
    });

    // ─── UPDATE TRANSACTION ──────────────────────────────────────────────────
    router.put('/transactions/:id', requireAuth, async (req, res) => {
        const { type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount } = req.body;
        
        // Check ownership
        const existing = database.db.prepare(`
            SELECT t.* FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE t.id = ? AND pu.user_id = ?
        `).get(req.params.id, req.user.id);
        
        if (!existing && req.user.role !== 'admin') return res.status(404).send('Transaction not found or access denied');
        
        const finalExisting = existing || database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
        if (!finalExisting) return res.status(404).send('Transaction not found');

        const newType = type || finalExisting.type;
        const typeChanged = finalExisting.type !== newType;

        // If transaction has a link and the type changed (e.g. changed from TRANSFER to BUY), break the link
        if (finalExisting.linkedTransactionId && typeChanged) {
            const linkedId = finalExisting.linkedTransactionId;
            database.db.prepare(`UPDATE transactions SET linkedTransactionId = NULL WHERE id = ?`).run(linkedId);
            database.db.prepare(`UPDATE transactions SET linkedTransactionId = NULL WHERE id = ?`).run(finalExisting.id);
            
            const linkedTx = database.db.prepare(`SELECT portfolioId FROM transactions WHERE id = ?`).get(linkedId);
            if (linkedTx) {
                database.recalculatePortfolio(linkedTx.portfolioId);
                triggerHistoryRebuild(linkedTx.portfolioId);
            }
        }

        // If transaction is linked and type is unchanged, synchronize values to the paired transaction
        if (finalExisting.linkedTransactionId && !typeChanged) {
            const linkedTx = database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(finalExisting.linkedTransactionId);
            if (linkedTx) {
                const srcPort = database.db.prepare("SELECT currency FROM portfolios WHERE id = ?").get(finalExisting.portfolioId);
                const destPort = database.db.prepare("SELECT currency FROM portfolios WHERE id = ?").get(linkedTx.portfolioId);
                
                let fxRate = 1.0;
                const newDate = date || finalExisting.date;
                if (srcPort && destPort && srcPort.currency !== destPort.currency) {
                    const quote = database.db.prepare("SELECT price FROM asset_quotes WHERE ticker = 'EURUSD=X' AND date = ?").get(newDate);
                    if (quote && quote.price > 0) {
                        fxRate = quote.price;
                    } else {
                        const current = database.db.prepare("SELECT currentPrice FROM assets WHERE ticker = 'EURUSD=X'").get();
                        if (current && current.currentPrice > 0) {
                            fxRate = current.currentPrice;
                        } else {
                            fxRate = 1.1;
                        }
                    }
                }
                
                const newAmount = parseFloat(amount !== undefined ? amount : finalExisting.amount);
                let linkedAmount = newAmount;
                
                if (srcPort && destPort && srcPort.currency !== destPort.currency) {
                    if (finalExisting.type === 'TRANSFER') {
                        if (srcPort.currency === 'USD' && destPort.currency === 'EUR') {
                            linkedAmount = newAmount / fxRate;
                        } else if (srcPort.currency === 'EUR' && destPort.currency === 'USD') {
                            linkedAmount = newAmount * fxRate;
                        }
                    } else {
                        if (destPort.currency === 'USD' && srcPort.currency === 'EUR') {
                            linkedAmount = newAmount * fxRate;
                        } else if (destPort.currency === 'EUR' && srcPort.currency === 'USD') {
                            linkedAmount = newAmount / fxRate;
                        }
                    }
                }
                
                // Update the linked transaction
                database.db.prepare(`
                    UPDATE transactions 
                    SET date = ?, amount = ?
                    WHERE id = ?
                `).run(
                    newDate,
                    linkedAmount,
                    linkedTx.id
                );
                
                // Recalculate and rebuild history for the linked portfolio
                database.recalculatePortfolio(linkedTx.portfolioId);
                triggerHistoryRebuild(linkedTx.portfolioId);
            }
        }

        database.db.prepare(`
            UPDATE transactions 
            SET type = ?, assetTicker = ?, date = ?, quantity = ?, price = ?, commission = ?, tax = ?, exchangeRate = ?, amount = ?
            WHERE id = ?
        `).run(
            newType,
            sanitizeTicker(assetTicker) || finalExisting.assetTicker,
            date || finalExisting.date,
            parseFloat(quantity || 0),
            parseFloat(price || 0),
            parseFloat(commission || 0),
            parseFloat(tax || 0),
            parseFloat(exchangeRate || 1),
            parseFloat(amount || 0),
            req.params.id
        );

        database.recalculatePortfolio(finalExisting.portfolioId);
        clearPerformanceCache();

        triggerHistoryRebuild(finalExisting.portfolioId);
        refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error:", e));

        res.json({ success: true });
    });

    // ─── YAHOO TICKER TEST ───────────────────────────────────────────────────
    router.get('/test/yahoo-ticker', requireAuth, requireAdmin, async (req, res) => {
        const ticker = (req.query.ticker || "").trim().toUpperCase();
        if (!ticker) return res.status(400).send('Ticker required');

        try {
            const quote = await yahooFinance.quote(ticker).catch(() => null);
            const summary = await yahooFinance.quoteSummary(ticker, {
                modules: ['summaryDetail', 'assetProfile', 'financialData', 'defaultKeyStatistics', 'calendarEvents', 'price', "majorDirectHolders", "majorHoldersBreakdown", "insiderTransactions"]
            }).catch(() => null);

            if (!quote && !summary) {
                return res.status(404).json({ error: 'Ticker not found on Yahoo Finance' });
            }

            res.json({
                ticker,
                timestamp: new Date().toISOString(),
                quote,
                summary
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ─── BULK IMPORT ─────────────────────────────────────────────────────────
    router.post('/transactions/bulk', requireAuth, async (req, res) => {
        const { portfolioId, transactions } = req.body;
        logger.info(`Bulk import request received for portfolioId: ${portfolioId} | Rows: ${transactions ? transactions.length : 0}`);
        if (!portfolioId || !transactions || !transactions.length) {
            return res.status(400).json({ error: 'portfolioId and transactions[] required' });
        }

        // Build a set of portfolio IDs the user is allowed to write to (admin bypasses)
        const allowedPids = req.user.role === 'admin'
            ? null // null means all allowed
            : new Set(
                database.db.prepare(`SELECT portfolio_id FROM portfolio_users WHERE user_id = ?`)
                    .all(req.user.id).map(r => r.portfolio_id)
              );

        try {
            const parseItalianDate = (dateStr) => {
                if (!dateStr) return null;
                const s = String(dateStr).trim();
                if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
                const match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
                return s;
            };

            const typeMapping = {
                'DIV': 'DIVIDEND', 'DIVIDENDO': 'DIVIDEND',
                'DEPOSITO': 'DEPOSIT', 'PRELIEVO': 'WITHDRAWAL',
                'ACQUISTO': 'BUY', 'VENDITA': 'SELL'
            };

            const insertTx = database.db.prepare(`
                INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const results = [];
            const affectedPortfolios = new Set();
            if (portfolioId !== 'all') {
                const pid = parseInt(portfolioId);
                if (!isNaN(pid)) affectedPortfolios.add(pid);
            }

            const importMany = database.db.transaction((txs) => {
                for (const t of txs) {
                    try {
                        let targetId = parseInt(portfolioId);
                        
                        // Multi-portfolio logic: resolve or create by name
                        if (t.portfolioName && t.portfolioName.trim()) {
                            const pName = t.portfolioName.trim();
                            let p = database.db.prepare(`SELECT id FROM portfolios WHERE name = ?`).get(pName);
                            if (!p) {
                                // Only admin or portfolio owners can auto-create portfolios
                                if (allowedPids !== null) {
                                    throw new Error(`Portfolio '${pName}' non trovato e non hai i permessi per crearlo automaticamente.`);
                                }
                                const info = database.db.prepare(`
                                    INSERT INTO portfolios (name, currency, startDate, initialCash)
                                    VALUES (?, 'EUR', ?, 0)
                                `).run(pName, t.date || new Date().toISOString().split('T')[0]);
                                targetId = info.lastInsertRowid;
                                logger.info(`Auto-created portfolio: ${pName} (ID: ${targetId})`);
                            } else {
                                targetId = p.id;
                            }
                        }
                        
                        if (isNaN(targetId)) {
                            throw new Error(`Invalid portfolio mapping for transaction on ${t.date}. 'portfolioId' is '${portfolioId}' and row 'portfolioName' is '${t.portfolioName || 'Missing'}'.`);
                        }

                        // Security: ensure user owns the target portfolio
                        if (allowedPids !== null && !allowedPids.has(targetId)) {
                            throw new Error(`Accesso negato: non hai i permessi per il portfolio ID ${targetId}.`);
                        }

                        affectedPortfolios.add(targetId);

                        let sanitizedTicker = '';
                        let newSource = (t.assetTicker && t.assetTicker.toUpperCase().startsWith('BTP')) ? 'B_ITA' : 'YF';
                        let newIsin = (t.isin && t.isin.trim()) ? t.isin.trim() : null;

                        if (t.assetTicker) {
                            sanitizedTicker = t.assetTicker.trim();
                            const existingAsset = database.db.prepare(
                                `SELECT id, ticker FROM assets WHERE UPPER(ticker) = UPPER(?)`
                            ).get(sanitizedTicker);

                            if (existingAsset) {
                                database.db.prepare(`
                                    UPDATE assets SET 
                                        isin = CASE WHEN ? IS NOT NULL THEN ? ELSE isin END,
                                        dataSource = ?,
                                        name = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE name END
                                    WHERE UPPER(ticker) = UPPER(?)
                                `).run(newIsin, newIsin, newSource, 
                                       t.assetName || null, t.assetName || null, t.assetName || null, 
                                       sanitizedTicker);
                            } else {
                                database.db.prepare(`
                                    INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, forwardPE, dividendYield, eps, beta, pegRatio, nextDividendDate, country, isManual, dataSource, isin, updatedAt)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                                `).run(
                                    t.assetId || sanitizedTicker, 
                                    sanitizedTicker, 
                                    t.assetName || sanitizedTicker, 
                                    sanitizedTicker.startsWith('CD_') ? 'Deposito Vincolato' : (t.assetType || (newSource === 'B_ITA' ? 'Bond' : 'Stock')), 
                                    sanitizedTicker.startsWith('CD_') ? 'MANUAL' : (t.assetExchange || (newSource === 'B_ITA' ? 'XMIL' : 'N/A')), 
                                    sanitizedTicker.startsWith('CD_') ? 'EUR' : (t.assetCurrency || (newSource === 'B_ITA' ? 'EUR' : 'USD')), 
                                    parseFloat(t.assetPrice || 0) || 0,
                                    0, 
                                    t.assetPe || null,
                                    null, null, null, null, null, null, // forwardPE, dividendYield, eps, beta, pegRatio, nextDividendDate
                                    sanitizedTicker.startsWith('CD_') ? 'Italy' : (t.assetCountry || (newSource === 'B_ITA' ? 'Italy' : 'N/A')),
                                    0,
                                    sanitizedTicker.startsWith('CD_') ? 'MANUAL' : newSource,
                                    newIsin
                                );
                            }
                        }

                        // Robust parsing helper for common export formats
                        const cleanNum = (val, dflt = 0) => {
                            if (typeof val === 'number') return isFinite(val) ? val : dflt;
                            if (!val) return dflt;
                            // Handle Italian comma decimals and dot thousands
                            const s = String(val).replace(/[€$£\s]/g,'').replace(/\./g,'').replace(',','.');
                            const n = parseFloat(s);
                            return isNaN(n) ? dflt : n;
                        };

                        let finalQty = cleanNum(t.quantity);
                        let finalExRate = cleanNum(t.exchangeRate, 1);
                        if (sanitizedTicker && sanitizedTicker.startsWith('CD_')) {
                            finalQty = 1.0;
                            finalExRate = 1.0;
                        }

                        let finalType = (t.type || '').toUpperCase();
                        if (typeMapping[finalType]) finalType = typeMapping[finalType];

                        let finalDate = parseItalianDate(t.date);

                        insertTx.run(
                            targetId,
                            finalType,
                            sanitizedTicker || null,
                            finalDate,
                            finalQty,
                            cleanNum(t.price),
                            cleanNum(t.commission),
                            cleanNum(t.tax),
                            finalExRate,
                            cleanNum(t.amount)
                        );

                        results.push({ ok: true, ticker: t.assetTicker, date: t.date, portfolioId: targetId });
                    } catch (err) {
                        logger.warn(`Failed to process row: ${JSON.stringify(t)} | Error: ${err.message}`);
                        results.push({ ok: false, ticker: t.assetTicker, date: t.date, error: err.message });
                    }
                }
            });

            importMany(transactions);

            // Recalculate affected portfolios
            for (const pid of affectedPortfolios) {
                if (!isNaN(pid) && pid > 0) {
                    database.recalculatePortfolio(pid);
                }
            }
            
            clearPerformanceCache();
            
            // Auto-refresh dividend projections after bulk import (non-blocking)
            refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error (Bulk):", e));

            res.json({ 
                success: true, 
                imported: results.filter(r => r.ok).length,
                errors: results.filter(r => !r.ok),
                details: results 
            });
        } catch (err) {
            logger.error('Bulk import crash:', err);
            res.status(500).json({ error: 'Internal Server Error during bulk processing: ' + err.message });
        }
    });

    // ─── EXPORT TRANSACTIONS ─────────────────────────────────────────────────
    // Each user exports only their own transactions; admin exports all.
    router.get('/export-all-transactions', requireAuth, (req, res) => {
        try {
            let transactions;
            if (req.user.role === 'admin') {
                transactions = database.db.prepare(`
                    SELECT t.*, p.name as portfolioName 
                    FROM transactions t
                    JOIN portfolios p ON t.portfolioId = p.id
                    ORDER BY t.date ASC, t.id ASC
                `).all();
            } else {
                transactions = database.db.prepare(`
                    SELECT t.*, p.name as portfolioName 
                    FROM transactions t
                    JOIN portfolios p ON t.portfolioId = p.id
                    JOIN portfolio_users pu ON p.id = pu.portfolio_id
                    WHERE pu.user_id = ?
                    ORDER BY t.date ASC, t.id ASC
                `).all(req.user.id);
            }

            if (transactions.length === 0) {
                return res.status(400).send('No transactions to export');
            }

            const headers = ['Portfolio', 'Type', 'Asset', 'Date', 'Quantity', 'Price', 'Commission', 'Tax', 'FX Rate', 'Amount'];
            const rows = transactions.map(t => [
                t.portfolioName,
                t.type,
                t.assetTicker || '',
                t.date,
                t.quantity,
                t.price,
                t.commission,
                t.tax,
                t.exchangeRate,
                t.amount
            ]);

            let csvContent = headers.join(',') + '\n';
            rows.forEach(row => {
                csvContent += row.map(value => {
                    if (typeof value === 'string') {
                        return `"${value.replace(/"/g, '""')}"`;
                    }
                    return value;
                }).join(',') + '\n';
            });

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=all_transactions_export_${new Date().toISOString().split('T')[0]}.csv`);
            res.status(200).send(csvContent);
        } catch (err) {
            console.error('Export all error:', err);
            res.status(500).send('Export error: ' + err.message);
        }
    });

    // ─── PARSE BROKER CSV ─────────────────────────────────────────────────────────────
    // POST /api/transactions/parse-broker
    // Accepts raw CSV text + broker type, returns normalized transactions for preview.
    router.post('/transactions/parse-broker', requireAuth, express.json({ limit: '5mb' }), (req, res) => {
        try {
            const { broker, csv, portfolioName } = req.body;
            if (!csv || !csv.trim()) return res.status(400).json({ error: 'csv is required' });

            const detectedBroker = broker && broker !== 'AUTO' ? broker.toUpperCase() : detectBroker(csv);

            let result;
            if (detectedBroker === 'DIRECTA') {
                result = parseDirecta(csv);
            } else if (detectedBroker === 'IFIS') {
                result = parseIfis(csv, portfolioName || 'IFIS');
            } else {
                return res.status(400).json({ error: `Broker '${detectedBroker}' non supportato. Usa: DIRECTA, IFIS.` });
            }

            res.json({ broker: detectedBroker, ...result });
        } catch (err) {
            logger.error('[parse-broker]', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
