const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

async function test() {
    try {
        const ks = await yahooFinance.quoteSummary('AAPL', { modules: ['financialData', 'defaultKeyStatistics'] });
        console.log("financialData:", ks.financialData);
        console.log("defaultKeyStatistics:", ks.defaultKeyStatistics);
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
