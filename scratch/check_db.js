const { db } = require('../src/db');

const assets = db.prepare('SELECT ticker, name, currentPrice, quoteDate, changePercent, type, currency, isManual, lastUpdateError FROM assets').all();
console.log(`Total assets in DB: ${assets.length}`);

const zeroOrBad = assets.filter(a => !a.currentPrice || a.currentPrice <= 0 || isNaN(a.currentPrice));
console.log(`Assets with price <= 0 or NaN: ${zeroOrBad.length}`);
zeroOrBad.forEach(a => console.log(` - ${a.ticker} (${a.name}): currentPrice=${a.currentPrice}, quoteDate=${a.quoteDate}, isManual=${a.isManual}, err=${a.lastUpdateError}`));

const today = new Date().toISOString().split('T')[0];
console.log(`\nToday: ${today}`);

const portfolios = db.prepare('SELECT id, name, initialCash, currentCash, currency FROM portfolios').all();
console.log('\nPortfolios:');
portfolios.forEach(p => {
    console.log(` - ID ${p.id} (${p.name}): initialCash=${p.initialCash}, currentCash=${p.currentCash}, currency=${p.currency}`);
});

const recentHistory = db.prepare('SELECT date, portfolioId, totalValue, cashValue, assetValue FROM portfolio_history ORDER BY date DESC LIMIT 20').all();
console.log('\nRecent portfolio_history entries:');
recentHistory.forEach(h => console.log(` - Date: ${h.date} | PID: ${h.portfolioId} | Total: ${h.totalValue} | Cash: ${h.cashValue} | Asset: ${h.assetValue}`));

