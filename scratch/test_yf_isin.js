const YahooFinance = require('yahoo-finance2').default;

async function checkIsin() {
    try {
        const tickers = ['SWDA.MI', 'ISP.MI', 'AAPL'];
        for (const ticker of tickers) {
            console.log(`Checking Ticker: ${ticker}`);
            const quote = await YahooFinance.quote(ticker);
            const summary = await YahooFinance.quoteSummary(ticker, { 
                modules: ["summaryProfile", "assetProfile", "fundProfile", "summaryDetail", "defaultKeyStatistics", "calendarEvents"] 
            });
            
            console.log(`  Quote ISIN: ${quote.isin || 'N/A'}`);
            // Check in other modules
            console.log(`  Summary Detail ISIN: ${summary.summaryDetail ? summary.summaryDetail.isin : 'N/A'}`);
            console.log(`  Default Key Stats ISIN: ${summary.defaultKeyStatistics ? summary.defaultKeyStatistics.isin : 'N/A'}`);
            console.log(`  Asset Profile ISIN: ${summary.assetProfile ? summary.assetProfile.isin : 'N/A'}`);
        }
    } catch (err) {
        console.error(err);
    }
}

checkIsin();
