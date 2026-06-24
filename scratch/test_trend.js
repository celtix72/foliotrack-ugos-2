const axios = require('axios');

async function test() {
    try {
        const YahooFinance = require('yahoo-finance2').default;
        const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
        const ks = await yahooFinance.quoteSummary('AAPL', { modules: ['defaultKeyStatistics', 'earningsTrend'] });
        console.dir(ks.earningsTrend, {depth: null});
    } catch(e) {
        console.error(e);
    }
}
test();
