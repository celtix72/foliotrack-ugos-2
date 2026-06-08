const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

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
fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched API market');
