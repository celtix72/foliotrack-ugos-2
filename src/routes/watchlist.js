const express = require('express');
const { mapYahooToGoogleTicker, mapGoogleToYahooTicker } = require('../services/googleFinance');


/**
 * Watchlist Router
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        database,
        logger,
        yahooFinance,
        getMarketStatus,
        isUSMarket,
        fetchAssetMetadata,
        triggerHistoryRebuild,
        historicalPricesCache,
        watchlistPerformanceCache,
        getEurUsdRate
    } = dependencies;

    // ─── WATCHLIST GET ───────────────────────────────────────────────────────
    router.get('/watchlist', requireAuth, async (req, res) => {
        try {
            const rows = database.db.prepare(`
                SELECT a.*, 
                       uw.targetPrice as userTargetPrice,
                       uw.stopLoss as userStopLoss,
                       uw.volatilityAlert as userVolatilityAlert,
                       a.ai_action as aiAction,
                       a.ai_reasoning as aiReasoning,
                       a.ai_updated_at as aiUpdatedAt,
                       a.ai_engine as aiEngine,
                       a.ai_prompt_type as aiPromptType,
                       a.targetPrice as aiTargetPrice,
                       (SELECT COUNT(*) FROM asset_ai_history ah WHERE ah.ticker = a.ticker) as aiHistoryCount,
                       CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition
                 FROM assets a
                 JOIN user_watchlist uw ON a.ticker = uw.ticker
                 LEFT JOIN (
                     SELECT assetTicker, 
                            SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
                     FROM transactions 
                     WHERE portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)
                     GROUP BY assetTicker
                 ) t ON a.ticker = t.assetTicker
                 WHERE uw.user_id = ? AND a.ticker != 'CASH'
                 ORDER BY a.ticker ASC
             `).all(req.user.id, req.user.id);
             
             // 1. Calculate holdings per portfolio to get specific PMCs (Filtered by user)
             const portfolioHoldings = {}; 
             const allP = database.db.prepare(`
                 SELECT p.id, p.name, p.color, p.currency 
                 FROM portfolios p
                 JOIN portfolio_users pu ON p.id = pu.portfolio_id
                 WHERE pu.user_id = ?
             `).all(req.user.id);
             for (const p of allP) {
                 const txs = database.db.prepare(`
                     SELECT type, assetTicker, quantity, price, commission, tax, exchangeRate, amount 
                     FROM transactions 
                     WHERE portfolioId = ? 
                     ORDER BY date ASC
                 `).all(p.id);
                 
                 const pOpenMap = {};
                 for (const t of txs) {
                     if (!t.assetTicker || t.assetTicker === 'CASH') continue;
                     const ticker = t.assetTicker;
                     if (t.type === 'BUY') {
                         if (!pOpenMap[ticker]) pOpenMap[ticker] = { qty: 0, cost: 0, costBase: 0 };
                         const fx = t.exchangeRate || 1;
                         const costBase = t.amount ? Math.abs(t.amount) : ((t.quantity * t.price + t.commission + t.tax) / fx);

                         pOpenMap[ticker].qty += t.quantity;
                         pOpenMap[ticker].cost += (t.quantity * t.price + t.commission + t.tax);
                         pOpenMap[ticker].costBase += costBase;
                     } else if (t.type === 'SELL') {
                         if (pOpenMap[ticker] && pOpenMap[ticker].qty > 0) {
                             const pmc = pOpenMap[ticker].cost / pOpenMap[ticker].qty;
                             const pmcBase = pOpenMap[ticker].costBase / pOpenMap[ticker].qty;
                             pOpenMap[ticker].qty -= t.quantity;
                             pOpenMap[ticker].cost -= t.quantity * pmc;
                             pOpenMap[ticker].costBase -= t.quantity * pmcBase;
                             if (pOpenMap[ticker].qty <= 0.0001) delete pOpenMap[ticker];
                         }
                     }
                 }
                 for (const [ticker, data] of Object.entries(pOpenMap)) {
                     if (!portfolioHoldings[ticker]) portfolioHoldings[ticker] = [];
                     portfolioHoldings[ticker].push({
                         name: p.name,
                         color: p.color,
                         currency: p.currency,
                         qty: data.qty,
                         costBase: data.costBase,
                         pmc: data.cost / data.qty
                     });
                 }
             }

             const liveRate = await getEurUsdRate();
             const today = new Date().toISOString().split('T')[0];
  
             const allTickers = rows.map(r => r.ticker);
             const badgesByTicker = {};
             if (allTickers.length > 0) {
                 const placeholders = allTickers.map(() => '?').join(',');
                 const aiHistoryStmt = database.db.prepare(`
                     SELECT ticker, engine, action as aiAction, targetPrice as aiTargetPrice, prompt_type, created_at, is_best
                     FROM asset_ai_history
                     WHERE ticker IN (${placeholders}) AND engine IS NOT NULL
                     ORDER BY created_at DESC
                 `);
                 const allBadges = aiHistoryStmt.all(...allTickers);
                 
                 const fundStmt = database.db.prepare(`SELECT ticker, data FROM asset_fundamentals WHERE ticker IN (${placeholders})`);
                 const fundamentalsList = fundStmt.all(...allTickers);
                 const latestQuarterlyDates = {};
                 for (const row of fundamentalsList) {
                     try {
                         const parsed = JSON.parse(row.data);
                         if (parsed.earningsHistory && parsed.earningsHistory.length > 0) {
                             const validDates = parsed.earningsHistory.filter(h => h.epsActual != null && h.date).map(h => new Date(h.date).getTime());
                             if (validDates.length > 0) {
                                 latestQuarterlyDates[row.ticker] = Math.max(...validDates);
                             }
                         }
                     } catch(e) {}
                 }

                 for (const b of allBadges) {
                     b.isOutdated = latestQuarterlyDates[b.ticker] && new Date(b.created_at).getTime() < latestQuarterlyDates[b.ticker];
                     if (!badgesByTicker[b.ticker]) badgesByTicker[b.ticker] = [];
                     if (badgesByTicker[b.ticker].length < 5) badgesByTicker[b.ticker].push(b);
                 }
             }

             const marketStatus = getMarketStatus();
             const result = rows.map(a => {
                 const aiBadges = badgesByTicker[a.ticker] || [];
  
                 let sparkline = [];
                 if (historicalPricesCache[a.ticker]) {
                     const history = historicalPricesCache[a.ticker];
                     const dates = Object.keys(history).sort();
                     sparkline = dates.slice(-7).map(d => history[d]);
                 }
                 const isToday = a.quoteDate === today;
                 const isUS = isUSMarket(a);
                 const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
                 const showVariation = isToday && openedToday;
                 
                 let totalGainEUR = 0;
                 
                 const portfoliosInfo = (portfolioHoldings[a.ticker] || []).map(ph => {
                     const roi = (a.currentPrice > 0 && ph.pmc > 0) ? ((a.currentPrice - ph.pmc) / ph.pmc) * 100 : 0;
                     
                     const currentValAsset = ph.qty * (a.currentPrice || 0);
                     let currentValBase = currentValAsset;
                     if (a.currency === 'USD' && ph.currency === 'EUR') {
                         currentValBase = currentValAsset / liveRate;
                     } else if (a.currency === 'EUR' && ph.currency === 'USD') {
                         currentValBase = currentValAsset * liveRate;
                     }
                     
                     const gainBase = currentValBase - ph.costBase;
                     
                     let gainEUR = gainBase;
                     if (ph.currency === 'USD') {
                         gainEUR = gainBase / liveRate;
                     }
                     
                     totalGainEUR += gainEUR;
                     
                     return {
                         name: ph.name,
                         color: ph.color,
                         roi: roi
                     };
                 });

                 const actualTotalQuantity = (portfolioHoldings[a.ticker] || []).reduce((sum, ph) => sum + ph.qty, 0);
                 const actualTotalCostAssetCurr = (portfolioHoldings[a.ticker] || []).reduce((sum, ph) => sum + (ph.pmc * ph.qty), 0);

                 return { 
                     ...a, 
                     totalQuantity: actualTotalQuantity > 0.0001 ? actualTotalQuantity : 0,
                     totalCostAssetCurr: actualTotalCostAssetCurr,
                     targetPrice: a.userTargetPrice,
                     stopLoss: a.userStopLoss,
                     aiEngine: a.aiEngine,
                     aiPromptType: a.aiPromptType,
                     aiTargetPrice: a.aiTargetPrice,
                     aiAction: a.aiAction,
                     aiReasoning: a.aiReasoning,
                     aiBadges,
                     volatilityAlert: a.userVolatilityAlert,
                     inWatchlist: 1,
                     sparkline,
                     changePercent: showVariation ? (a.changePercent || 0) : 0,
                     changeValue: showVariation ? (a.changeValue || 0) : 0,
                     portfoliosInfo,
                     totalGainEUR
                 };
             });
             res.json(result);
         } catch (err) {
             res.status(500).json({ error: err.message });
         }
     });
 
     // ─── WATCHLIST ADD ───────────────────────────────────────────────────────
     router.post('/watchlist', requireAuth, async (req, res) => {
         const { ticker, targetPrice, stopLoss, volatilityAlert, googleTicker } = req.body;
         if (!ticker) return res.status(400).send('Ticker is required');

         try {
             let normalizedTicker = ticker.trim().toUpperCase();
             let gTicker = googleTicker ? googleTicker.trim() : null;
             if (normalizedTicker.includes(':')) {
                 gTicker = normalizedTicker;
                 normalizedTicker = mapGoogleToYahooTicker(normalizedTicker);
             }
             
             // 1. Check if asset already exists in DB
             let asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
             
             if (!asset) {
                 // 2. Fetch robust metadata (Google Finance primary, Yahoo fallback)
                 const metadata = await fetchAssetMetadata(normalizedTicker, gTicker);
                 if (metadata) {
                     database.db.prepare(`
                         INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, changeValue, pe, country, isin, googleTicker, realtimeSource, isRealtime, updatedAt)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                     `).run(
                         normalizedTicker, normalizedTicker, metadata.name, metadata.type, metadata.exchange, metadata.currency, metadata.currentPrice, metadata.changePercent, metadata.changeValue || 0, metadata.pe, metadata.country, metadata.isin || null,
                         metadata.googleTicker || gTicker || null, metadata.realtimeSource || null, metadata.isRealtime ?? 0
                     );
                     asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
                 } else {
                     return res.status(404).send('Ticker not found on Google Finance or Yahoo Finance');
                 }
             } else if (gTicker && (!asset.googleTicker || asset.googleTicker !== gTicker)) {
                 database.db.prepare(`UPDATE assets SET googleTicker = ? WHERE ticker = ?`).run(gTicker, normalizedTicker);
             }
 
             // 3. Add to user_watchlist
             database.db.prepare(`
                 INSERT INTO user_watchlist (user_id, ticker, targetPrice, stopLoss, volatilityAlert)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, ticker) DO UPDATE SET
                     targetPrice = COALESCE(excluded.targetPrice, targetPrice),
                     stopLoss = COALESCE(excluded.stopLoss, stopLoss),
                     volatilityAlert = COALESCE(excluded.volatilityAlert, volatilityAlert)
             `).run(req.user.id, normalizedTicker, targetPrice, stopLoss, volatilityAlert);
 
             res.json({ ok: true, ticker: normalizedTicker });
             triggerHistoryRebuild(null);
         } catch (err) {
             console.error('Watchlist add error:', err);
             res.status(500).json({ error: err.message });
         }
     });
 
     // ─── WATCHLIST DELETE ────────────────────────────────────────────────────
     router.delete('/watchlist/:ticker', requireAuth, (req, res) => {
         try {
             const ticker = req.params.ticker.toUpperCase();
             const result = database.db.prepare('DELETE FROM user_watchlist WHERE user_id = ? AND ticker = ?').run(req.user.id, ticker);
             logger.info(`Watchlist delete: user ${req.user.id}, ticker ${ticker}, affectedRows: ${result.changes}`);
             res.json({ ok: true, changes: result.changes });
         } catch (err) {
             console.error('Watchlist delete error:', err);
             res.status(500).json({ error: err.message });
         }
     });
     // ─── WATCHLIST PERFORMANCE ───────────────────────────────────────────────
     router.get('/watchlist/performance', requireAuth, async (req, res) => {
        try {
            const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
            if (watchlistPerformanceCache.data && watchlistPerformanceCache.lastUpdated) {
                if (Date.now() - watchlistPerformanceCache.lastUpdated < CACHE_TTL_MS) {
                    return res.json(watchlistPerformanceCache.data);
                }
            }

            const watchlist = database.db.prepare(`
                SELECT a.ticker, a.currentPrice, a.currency
                FROM assets a
                JOIN user_watchlist uw ON a.ticker = uw.ticker
                WHERE uw.user_id = ? 
                  AND a.ticker != 'CASH' 
                  AND IFNULL(a.type, '') NOT IN ('Liquidità', 'Conto Deposito', 'Buono Postale')
                  AND a.ticker NOT LIKE 'CD_%'
                  AND a.ticker NOT LIKE 'BP_%'
            `).all(req.user.id);
            const results = {};
            
            const nowDate = new Date();
            const oneWeekAgo = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
            const oneMonthAgo = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000);
            const oneYearAgo = new Date(nowDate.getTime() - 365 * 24 * 60 * 60 * 1000);

            // Process in chunks of 5 to prevent Yahoo Finance rate-limiting
            const CHUNK_SIZE = 5;
            for (let i = 0; i < watchlist.length; i += CHUNK_SIZE) {
                const chunk = watchlist.slice(i, i + CHUNK_SIZE);
                await Promise.all(chunk.map(async (item) => {
                    const ticker = item.ticker;
                    try {
                        let quotes = [];

                        // 1. Try yahooFinance.chart (most reliable for global & European assets)
                        try {
                            const chartRes = await yahooFinance.chart(ticker, {
                                period1: Math.floor(oneYearAgo.getTime() / 1000),
                                period2: Math.floor(nowDate.getTime() / 1000),
                                interval: '1d'
                            }).catch(() => null);

                            if (chartRes && Array.isArray(chartRes.quotes) && chartRes.quotes.length > 0) {
                                quotes = chartRes.quotes
                                    .filter(q => q && q.close != null && q.close > 0)
                                    .map(q => ({ date: new Date(q.date), price: q.close }));
                            }
                        } catch (e) {}

                        // 2. Fallback to yahooFinance.historical if chart returned empty
                        if (quotes.length === 0) {
                            try {
                                const histRes = await yahooFinance.historical(ticker, {
                                    period1: oneYearAgo,
                                    period2: nowDate,
                                    interval: '1d'
                                }).catch(() => []);

                                if (histRes && histRes.length > 0) {
                                    quotes = histRes
                                        .filter(h => h && h.close != null && h.close > 0)
                                        .map(h => ({ date: new Date(h.date), price: h.close }));
                                }
                            } catch (e) {}
                        }

                        // 3. Fallback to local DB asset_quotes if network calls failed
                        if (quotes.length === 0) {
                            try {
                                const dbQuotes = database.db.prepare(`
                                    SELECT date, price FROM asset_quotes 
                                    WHERE UPPER(ticker) = UPPER(?) AND price > 0
                                    ORDER BY date ASC
                                `).all(ticker);
                                if (dbQuotes && dbQuotes.length > 0) {
                                    quotes = dbQuotes.map(q => ({ date: new Date(q.date), price: q.price }));
                                }
                            } catch (e) {}
                        }

                        // Determine current price: use item.currentPrice from DB first, or latest quote price
                        const currentPrice = (item.currentPrice && item.currentPrice > 0)
                            ? item.currentPrice
                            : (quotes.length > 0 ? quotes[quotes.length - 1].price : 0);

                        if (currentPrice > 0 && quotes.length > 0) {
                            const getPerformance = (targetDate, minDaysDiff, maxDaysDiff) => {
                                let closest = null;
                                let minDiffMs = Infinity;

                                for (const q of quotes) {
                                    const diffMs = Math.abs(q.date.getTime() - targetDate.getTime());
                                    if (diffMs < minDiffMs) {
                                        minDiffMs = diffMs;
                                        closest = q;
                                    }
                                }

                                if (closest && closest.price > 0) {
                                    const actualAgeDays = (nowDate.getTime() - closest.date.getTime()) / (1000 * 3600 * 24);
                                    if (actualAgeDays >= minDaysDiff && actualAgeDays <= maxDaysDiff) {
                                        return ((currentPrice - closest.price) / closest.price) * 100;
                                    }
                                }
                                return null;
                            };

                            results[ticker] = {
                                perf1W: getPerformance(oneWeekAgo, 4, 14),   // 1W: 4 to 14 days old
                                perf1M: getPerformance(oneMonthAgo, 18, 45), // 1M: 18 to 45 days old
                                perf1Y: getPerformance(oneYearAgo, 180, 450) // 1Y: 180 to 450 days old
                            };
                        }
                    } catch (e) {
                        console.error(`Error fetching performance for ${ticker}:`, e.message);
                    }
                }));
            }

            watchlistPerformanceCache.data = results;
            watchlistPerformanceCache.lastUpdated = Date.now();
            res.json(results);
        } catch (err) {
            console.error('Watchlist performance error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
