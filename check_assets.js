const Database = require('better-sqlite3');
const db = new Database('./foliotrack.db');

const rows = db.prepare(`
    SELECT a.ticker, a.name, a.changePercent, a.currentPrice, a.currency, a.quoteDate, SUM(h.netQty) as totalNetQty
    FROM assets a
    JOIN (
        SELECT t.assetTicker, 
               SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) as netQty 
        FROM transactions t
        JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
        JOIN portfolios p ON t.portfolioId = p.id
        WHERE pu.user_id = 1 AND p.include_in_totals != 0 AND t.assetTicker IS NOT NULL AND t.assetTicker != 'CASH'
        GROUP BY t.assetTicker 
        HAVING netQty > 0.001
    ) h ON a.ticker = h.assetTicker
    GROUP BY a.ticker
`).all();

console.log('Held assets from query:', rows.filter(r => r.currency === 'USD' || r.ticker === 'UNH'));
