const Database = require('better-sqlite3');
const path = require('path');

// Usage: node simulate_history.js <ticker> <startDate> <endDate> <value> [dbPath]
// Example: node simulate_history.js BTPMz30 2024-03-01 2024-03-31 100.0

const args = process.argv.slice(2);
if (args.length < 4) {
    console.log('Usage: node simulate_history.js <ticker> <startDate> <endDate> <value> [dbPath]');
    process.exit(1);
}

const [ticker, startStr, endStr, value, dbPathArg] = args;
const dbPath = dbPathArg || path.join(__dirname, '..', 'foliotrack.db');

console.log(`Simulating ${ticker} at ${value} from ${startStr} to ${endStr} in ${dbPath}`);

const db = new Database(dbPath);

const start = new Date(startStr);
const end = new Date(endStr);

const insert = db.prepare('INSERT OR REPLACE INTO asset_quotes (ticker, date, price) VALUES (?, ?, ?)');

db.transaction(() => {
    let current = new Date(start);
    while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        insert.run(ticker, dateStr, parseFloat(value));
        current.setDate(current.getDate() + 1);
    }
})();

console.log('✅ Simulation complete.');
db.close();
