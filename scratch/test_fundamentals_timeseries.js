const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

async function test() {
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 6);
        const financials = await yahooFinance.fundamentalsTimeSeries('AAPL', { 
            period1: from.toISOString().split('T')[0],
            module: 'financials',
            type: 'annual'
        });
        
        console.log(JSON.stringify(financials.slice(0,2), null, 2));
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
