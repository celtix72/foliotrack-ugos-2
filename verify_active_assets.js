const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'foliotrack.db');
const db = new Database(DB_PATH);

console.log('--- Verifying Active Assets Query ---');

const query = `
    SELECT a.ticker, a.name, a.inWatchlist, IFNULL(t.balance, 0) as balance
    FROM assets a
    LEFT JOIN (
        SELECT assetTicker, SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
        FROM transactions
        GROUP BY assetTicker
    ) t ON a.ticker = t.assetTicker
    WHERE a.inWatchlist = 1 OR IFNULL(t.balance, 0) > 0.0001
`;

try {
    const activeAssets = db.prepare(query).all();
    console.log(`Found ${activeAssets.length} active assets:`);
    activeAssets.forEach(a => {
        console.log(`- ${a.ticker}: Watchlist=${a.inWatchlist}, Balance=${a.balance.toFixed(4)}`);
    });

    const allAssetsCount = db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
    console.log(`\nTotal assets in database: ${allAssetsCount}`);
    
    if (activeAssets.length < allAssetsCount) {
        console.log('SUCCESS: Filtering is working. Some assets are inactive and excluded.');
    } else if (activeAssets.length === allAssetsCount) {
        console.log('NOTE: All assets in the database are currently active (Watchlist or Portfolio).');
    }

} catch (e) {
    console.error('Verification failed:', e.message);
} finally {
    db.close();
}
