const YahooFinance = require('yahoo-finance2').default;

async function checkYield() {
    try {
        const tickers = ['AAPL', 'ISP.MI', 'SWDA.MI'];
        for (const ticker of tickers) {
            const quote = await YahooFinance.quote(ticker);
            const summary = await YahooFinance.quoteSummary(ticker, { modules: ['summaryDetail'] });
            console.log(`Ticker: ${ticker}`);
            console.log(`  Quote Yield: ${quote.dividendYield}`);
            console.log(`  Summary Yield: ${summary.summaryDetail ? summary.summaryDetail.dividendYield : 'N/A'}`);
        }
    } catch (err) {
        console.error(err);
    }
}

checkYield();
