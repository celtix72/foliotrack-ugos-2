const Database = require('better-sqlite3');
const db = new Database('foliotrack.db');

try {
    const user_id = 1; // Assuming user id 1
    const yearMonth = '2026-08';
    
    const projList = db.prepare(`
        SELECT ticker, totalAmount as amount, exDate as paymentDate, exDate, 'PROJECTION' as type
        FROM dividend_projections
        WHERE user_id = ? AND exDate LIKE ?
        ORDER BY exDate ASC
    `).all(user_id, yearMonth + '%');

    const recList = db.prepare(`
        SELECT t.assetTicker as ticker, t.amount, t.date as paymentDate, t.date as exDate, 'RECEIVED' as type
        FROM transactions t
        JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
        WHERE pu.user_id = ? AND t.type = 'DIVIDEND' AND t.date LIKE ?
        ORDER BY t.date ASC
    `).all(user_id, yearMonth + '%');
    
    const dividendList = [...projList, ...recList].sort((a, b) => new Date(a.exDate || a.paymentDate) - new Date(b.exDate || b.paymentDate));

    const totalAmount = dividendList.reduce((sum, d) => sum + (d.amount || 0), 0);
    const totalCount = dividendList.length;

    console.log("Success", { totalAmount, totalCount, list: dividendList.length });
} catch (e) {
    console.error("ERROR:", e.message);
}
