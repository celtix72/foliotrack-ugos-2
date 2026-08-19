const yahooFinance = require('yahoo-finance2').default;

async function test() {
    const q = await yahooFinance.quote('AAPL');
    console.log(q.dividendYield, q.trailingAnnualDividendRate);
}
test();
