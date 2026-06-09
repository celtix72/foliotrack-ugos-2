const yahooFinance = require('yahoo-finance2').default;
async function test() {
    const q = await yahooFinance.quote('ISP.MI');
    console.log('regularMarketTime:', q.regularMarketTime);
    console.log('regularMarketChange:', q.regularMarketChange);
    console.log('regularMarketChangePercent:', q.regularMarketChangePercent);
    console.log('regularMarketVolume:', q.regularMarketVolume);
    console.log('regularMarketPrice:', q.regularMarketPrice);
    console.log('regularMarketPreviousClose:', q.regularMarketPreviousClose);
}
test();
