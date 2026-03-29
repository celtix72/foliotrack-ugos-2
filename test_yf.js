const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

async function test() {
    try {
        const ticker = 'IWDA.AS';
        const result = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'defaultKeyStatistics', 'fundProfile', 'assetProfile']
        });
        console.log('--- Fund Profile ---');
        console.log(JSON.stringify(result.fundProfile, null, 2));
        console.log('--- Key Statistics ---');
        console.log(JSON.stringify(result.defaultKeyStatistics, null, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
