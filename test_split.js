const db = require('./src/db');
// Create a dummy portfolio
const r1 = db.db.prepare("INSERT INTO portfolios (name, type, startDate, initialCapital, currency) VALUES ('Test Portfolio', 'Investimento', '2025-01-01', 10000, 'EUR')").run();
const portId = r1.lastInsertRowid;

// Create dummy asset
db.db.prepare(`
    INSERT OR IGNORE INTO assets (id, ticker, name, currentPrice)
    VALUES ('DUMMY_SPLIT', 'DUMMY_SPLIT', 'Dummy Company', 100)
`).run();

// Insert dummy transactions
db.db.prepare(`
    INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
    VALUES (?, 'BUY', 'DUMMY_SPLIT', '2025-01-01', 10, 100, 1000)
`).run(portId);

db.db.prepare(`
    INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
    VALUES (?, 'BUY', 'DUMMY_SPLIT', '2025-06-01', 5, 120, 600)
`).run(portId);

// Insert dummy asset quotes
db.db.prepare("INSERT INTO asset_quotes (ticker, date, price) VALUES ('DUMMY_SPLIT', '2025-01-01', 100)").run();
db.db.prepare("INSERT INTO asset_quotes (ticker, date, price) VALUES ('DUMMY_SPLIT', '2025-06-01', 120)").run();

console.log("Before Split:");
console.log(db.db.prepare("SELECT * FROM transactions WHERE assetTicker='DUMMY_SPLIT'").all());
console.log(db.db.prepare("SELECT * FROM asset_quotes WHERE ticker='DUMMY_SPLIT'").all());

// Simulate POST /api/assets/split
const oldTicker = 'DUMMY_SPLIT';
const targetTicker = 'DUMMY_SPLIT_NEW';
const r = 10; // 1:10 split
const splitDate = '2025-07-01';

db.db.transaction(() => {
    const asset = db.db.prepare('SELECT * FROM assets WHERE ticker = ?').get(oldTicker);
    db.db.prepare(`
        INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(targetTicker, targetTicker, asset.name, asset.type, asset.exchange, asset.currency, asset.currentPrice, asset.changePercent, asset.pe, asset.country, asset.isManual, asset.dataSource, asset.isin);
    
    db.db.prepare('UPDATE transactions SET assetTicker = ? WHERE assetTicker = ?').run(targetTicker, oldTicker);
    db.db.prepare('UPDATE asset_quotes SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
    try { db.db.prepare('DELETE FROM assets WHERE ticker = ?').run(oldTicker); } catch(e){}

    db.db.prepare(`
        UPDATE transactions 
        SET quantity = quantity * ?, price = price / ?
        WHERE assetTicker = ? AND date <= ? AND type != 'SPLIT'
    `).run(r, r, targetTicker, splitDate);

    db.db.prepare(`
        UPDATE asset_quotes
        SET price = price / ?
        WHERE ticker = ? AND date <= ?
    `).run(r, targetTicker, splitDate);

    const portfolios = db.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
    const insertTx = db.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
        VALUES (?, 'SPLIT', ?, ?, ?, 0, 0)
    `);
    for (const p of portfolios) {
        insertTx.run(p.portfolioId, targetTicker, splitDate, r);
    }
})();

console.log("After Split:");
console.log(db.db.prepare("SELECT * FROM transactions WHERE assetTicker=?").all(targetTicker));
console.log(db.db.prepare("SELECT * FROM asset_quotes WHERE ticker=?").all(targetTicker));

// Cleanup
db.db.prepare("DELETE FROM portfolios WHERE id = ?").run(portId);
db.db.prepare("DELETE FROM transactions WHERE portfolioId = ?").run(portId);
db.db.prepare("DELETE FROM assets WHERE ticker = ?").run(targetTicker);
db.db.prepare("DELETE FROM asset_quotes WHERE ticker = ?").run(targetTicker);

