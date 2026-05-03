const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'foliotrack.db');
console.log('Opening DB at:', DB_PATH);
const db = new Database(DB_PATH);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));

try {
    const count = db.prepare("SELECT count(*) as count FROM user_watchlist").get();
    console.log('user_watchlist count:', count.count);
} catch (e) {
    console.log('Error accessing user_watchlist:', e.message);
}

const assetsInfo = db.prepare("PRAGMA table_info(assets)").all();
console.log('Assets columns:', assetsInfo.map(c => c.name));
