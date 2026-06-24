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
        
        console.log(financials.map(f => ({ date: f.date, eps: f.dilutedEPS, basicEps: f.basicEPS })));
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
