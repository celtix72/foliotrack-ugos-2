const yahooFinance = require('yahoo-finance2').default;

async function test() {
    try {
        const ticker = 'TSLA'; // Tesla often has pre-market/after-market data
        const quote = await yahooFinance.quote(ticker);
        console.log('Quote for', ticker);
        console.log('Pre-Market Change:', quote.preMarketChange);
        console.log('Pre-Market Change %:', quote.preMarketChangePercent);
        console.log('Post-Market Change:', quote.postMarketChange);
        console.log('Post-Market Change %:', quote.postMarketChangePercent);
        console.log('Market State:', quote.marketState);
    } catch (err) {
        console.error(err);
    }
}

test();
