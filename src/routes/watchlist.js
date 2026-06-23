const express = require('express');

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
        watchlistPerformanceCache
    } = dependencies;

    // ─── WATCHLIST GET ───────────────────────────────────────────────────────
    router.get('/watchlist', requireAuth, (req, res) => {
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
             
             const today = new Date().toISOString().split('T')[0];
 
             const aiHistoryStmt = database.db.prepare(`
                 SELECT engine, action as aiAction, targetPrice as aiTargetPrice, created_at
                 FROM asset_ai_history
                 WHERE ticker = ? AND engine IS NOT NULL
                 ORDER BY created_at DESC LIMIT 5
             `);
             const marketStatus = getMarketStatus();
             const result = rows.map(a => {
                 const aiBadges = aiHistoryStmt.all(a.ticker);
 
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
                 
                 return { 
                     ...a, 
                     targetPrice: a.userTargetPrice,
                     stopLoss: a.userStopLoss,
                     aiEngine: a.aiEngine,
                     aiTargetPrice: a.aiTargetPrice,
                     aiAction: a.aiAction,
                     aiReasoning: a.aiReasoning,
                     aiBadges,
                     volatilityAlert: a.userVolatilityAlert,
                     inWatchlist: 1,
                     sparkline,
                     changePercent: showVariation ? (a.changePercent || 0) : 0,
                     changeValue: showVariation ? (a.changeValue || 0) : 0
                 };
             });
             res.json(result);
         } catch (err) {
             res.status(500).json({ error: err.message });
         }
     });
 
     // ─── WATCHLIST ADD ───────────────────────────────────────────────────────
     router.post('/watchlist', requireAuth, async (req, res) => {
         const { ticker, targetPrice, stopLoss, volatilityAlert } = req.body;
         if (!ticker) return res.status(400).send('Ticker is required');
 
         try {
             const normalizedTicker = ticker.trim().toUpperCase();
             
             // 1. Check if asset already exists in DB
             let asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
             
             if (!asset) {
                 // 2. Fetch robust metadata
                 const metadata = await fetchAssetMetadata(normalizedTicker);
                 if (metadata) {
                     database.db.prepare(`
                         INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, changeValue, pe, country, isin, updatedAt)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                     `).run(
                         normalizedTicker, normalizedTicker, metadata.name, metadata.type, metadata.exchange, metadata.currency, metadata.currentPrice, metadata.changePercent, metadata.changeValue || 0, metadata.pe, metadata.country, metadata.isin || null
                     );
                     asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
                 } else {
                     return res.status(404).send('Ticker not found on Yahoo Finance');
                 }
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
            const watchlist = database.db.prepare(`
                SELECT a.ticker 
                FROM assets a
                JOIN user_watchlist uw ON a.ticker = uw.ticker
                WHERE uw.user_id = ? 
                  AND a.ticker != 'CASH' 
                  AND IFNULL(a.type, '') != 'Liquidità' 
                  AND a.ticker NOT LIKE 'CD_%'
            `).all(req.user.id);
            const results = {};
            
            const nowDate = new Date();
            const oneWeekAgo = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
            const oneMonthAgo = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000);
            const oneYearAgo = new Date(nowDate.getTime() - 365 * 24 * 60 * 60 * 1000);

            // Fetch in parallel
            await Promise.all(watchlist.map(async (item) => {
                const ticker = item.ticker;
                try {
                    // Fetch historical data from YF
                    const historical = await yahooFinance.historical(ticker, {
                        period1: oneYearAgo,
                        period2: nowDate,
                        interval: '1d'
                    }).catch(() => []);

                    if (historical.length > 0) {
                        const quote = await yahooFinance.quote(ticker).catch(() => null);
                        const currentPrice = quote?.regularMarketPrice || 0;
                        
                        if (currentPrice > 0) {
                            const getPerformance = (pastDate, minDaysDiff) => {
                                // Find the entry closest to the pastDate (first entry that is >= pastDate)
                                const pastEntry = historical.find(h => new Date(h.date) >= pastDate);
                                if (pastEntry && pastEntry.close) {
                                    // Validate if the date found is actually "past" enough
                                    const diffDays = (nowDate - new Date(pastEntry.date)) / (1000 * 3600 * 24);
                                    if (diffDays < minDaysDiff) return null;

                                    return ((currentPrice - pastEntry.close) / pastEntry.close) * 100;
                                }
                                return null;
                            };

                            results[ticker] = {
                                perf1W: getPerformance(oneWeekAgo, 4),   // 1W needs at least 4 days back (handles weekends)
                                perf1M: getPerformance(oneMonthAgo, 20), // 1M needs at least 20 days back
                                perf1Y: getPerformance(oneYearAgo, 300)  // 1Y needs at least 300 days back
                            };
                        }
                    }
                } catch (e) {
                    console.error(`Error fetching performance for ${ticker}:`, e.message);
                }
            }));

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
