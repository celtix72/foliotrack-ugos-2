const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

// 1. calculateVariationOverrides
const oldCalcStr = `            // 1. Regular Session Variation
            if (openedToday && isToday) {
                overrides.regular[a.ticker] = a.changeValue || 0;
            } else if (!openedToday && isToday && isUS && !preMktActive) {
                overrides.regular[a.ticker] = a.changeValue || 0;
            } else {
                overrides.regular[a.ticker] = 0;
            }`;

const newCalcStr = `            // 1. Regular Session Variation
            if (openedToday && isToday) {
                overrides.regular[a.ticker] = a.changeValue || 0;
            } else {
                overrides.regular[a.ticker] = 0;
            }`;
code = code.replace(oldCalcStr, newCalcStr);

// 2. /api/watchlist
const oldWatchlistMap = `        const result = rows.map(a => {
            const aiBadges = aiHistoryStmt.all(a.ticker);

            let sparkline = [];
            if (historicalPricesCache[a.ticker]) {
                const history = historicalPricesCache[a.ticker];
                const dates = Object.keys(history).sort();
                sparkline = dates.slice(-7).map(d => history[d]);
            }
            const isToday = a.quoteDate === today;
            return { 
                ...a,`;

const newWatchlistMap = `        const marketStatus = getMarketStatus();
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
                ...a,`;
code = code.replace(oldWatchlistMap, newWatchlistMap);

const oldWatchlistRet = `                sparkline,
                changePercent: isToday ? (a.changePercent || 0) : 0,
                changeValue: isToday ? (a.changeValue || 0) : 0
            };`;
const newWatchlistRet = `                sparkline,
                changePercent: showVariation ? (a.changePercent || 0) : 0,
                changeValue: showVariation ? (a.changeValue || 0) : 0
            };`;
code = code.replace(oldWatchlistRet, newWatchlistRet);

// 3. /api/market
const oldMarketMap = `        const result = rows.map(a => {
            const aiBadges = aiHistoryStmt.all(a.ticker);

            let sparkline = [];
            if (historicalPricesCache[a.ticker]) {
                const history = historicalPricesCache[a.ticker];
                const dates = Object.keys(history).sort();
                sparkline = dates.slice(-7).map(d => history[d]);
            }
            const isToday = a.quoteDate === today;`;
const newMarketMap = `        const marketStatus = getMarketStatus();
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
            const showVariation = isToday && openedToday;`;
code = code.replace(oldMarketMap, newMarketMap);

const oldMarketRet = `        return { 
            ...a, 
            sparkline,
            changePercent: isToday ? a.changePercent : 0,
            changeValue: isToday ? a.changeValue : 0,`;
const newMarketRet = `        return { 
            ...a, 
            sparkline,
            changePercent: showVariation ? a.changePercent : 0,
            changeValue: showVariation ? a.changeValue : 0,`;
code = code.replace(oldMarketRet, newMarketRet);

// 4. /api/market/movers
const oldMoversAPI = `        const rows = database.db.prepare(\`
            SELECT a.* 
            FROM assets a
            JOIN (
                SELECT t.assetTicker, 
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance 
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ?
                GROUP BY t.assetTicker 
                HAVING balance > 0.0001
            ) t ON a.ticker = t.assetTicker
            WHERE a.quoteDate = ?
            ORDER BY ABS(a.changePercent) DESC
            LIMIT 10
        \`).all(userId, todayStr);

        res.json(rows);`;
const newMoversAPI = `        const marketStatus = getMarketStatus();
        let rows = database.db.prepare(\`
            SELECT a.* 
            FROM assets a
            JOIN (
                SELECT t.assetTicker, 
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance 
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ?
                GROUP BY t.assetTicker 
                HAVING balance > 0.0001
            ) t ON a.ticker = t.assetTicker
        \`).all(userId);

        rows = rows.map(a => {
            const isUS = isUSMarket(a);
            const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
            const isToday = a.quoteDate === todayStr;
            if (!openedToday || !isToday) {
                a.changePercent = 0;
                a.changeValue = 0;
            }
            return a;
        }).filter(a => Math.abs(a.changePercent) > 0)
          .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
          .slice(0, 10);

        res.json(rows);`;
code = code.replace(oldMoversAPI, newMoversAPI);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched src/server.js');
