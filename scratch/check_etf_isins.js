const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'foliotrack.db');
const db = new Database(dbPath);

const etfs = db.prepare("SELECT ticker, name, isin, type FROM assets WHERE type LIKE '%ETF%'").all();
console.log("ETFs in DB:");
etfs.forEach(e => {
    console.log(`${e.ticker} | ${e.name} | ISIN: ${e.isin || 'MISSING'}`);
});
