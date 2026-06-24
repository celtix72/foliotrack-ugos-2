const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

async function test() {
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 6);
        const p1 = from.toISOString().split('T')[0];
        
        const [financials, chart] = await Promise.all([
            yahooFinance.fundamentalsTimeSeries('AAPL', { period1: p1, module: 'financials', type: 'annual' }),
            yahooFinance.chart('AAPL', { period1: p1, interval: '1mo' })
        ]);
        
        const prices = chart.quotes;
        
        const result = financials.map(f => {
            if (!f.dilutedEPS) return null;
            const targetTime = new Date(f.date).getTime();
            // find closest price
            let closestPrice = null;
            let minDiff = Infinity;
            for (const q of prices) {
                const diff = Math.abs(new Date(q.date).getTime() - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestPrice = q.close;
                }
            }
            return {
                date: f.date,
                eps: f.dilutedEPS,
                price: closestPrice,
                pe: closestPrice / f.dilutedEPS
            };
        }).filter(Boolean);
        
        console.log(result);
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
