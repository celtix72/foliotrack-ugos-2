const Database = require('better-sqlite3');
const db = new Database('./foliotrack.db');

const rows = db.prepare(`
    SELECT t.assetTicker, t.type, t.quantity, pu.user_id, p.include_in_totals
    FROM transactions t
    JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
    JOIN portfolios p ON t.portfolioId = p.id
    WHERE t.assetTicker = 'UNH' OR t.assetTicker LIKE '%UNH%'
`).all();

console.log('Transactions for UNH:', rows);

const allUSD = db.prepare(`
    SELECT t.assetTicker, a.currency, p.include_in_totals
    FROM transactions t
    JOIN assets a ON t.assetTicker = a.ticker
    JOIN portfolios p ON t.portfolioId = p.id
    WHERE a.currency = 'USD'
`).all();

console.log('USD transactions count:', allUSD.length);
if (allUSD.length > 0) {
    console.log('Sample USD transaction:', allUSD[0]);
}
