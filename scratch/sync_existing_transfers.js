const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'foliotrack.db');
const db = new Database(DB_PATH);

console.log(`Connecting to database at: ${DB_PATH}`);

// Get all portfolios for currency reference
const portfolios = db.prepare("SELECT id, name, currency FROM portfolios").all();
const portMap = Object.fromEntries(portfolios.map(p => [p.id, p]));

// Select all unlinked TRANSFER transactions
const transfers = db.prepare("SELECT * FROM transactions WHERE type = 'TRANSFER' AND linkedTransactionId IS NULL").all();
console.log(`Found ${transfers.length} unlinked TRANSFER transactions.`);

let linkedCount = 0;

db.transaction(() => {
    for (const t of transfers) {
        const srcPort = portMap[t.portfolioId];
        if (!srcPort) continue;

        // Find potential cash DEPOSIT transactions on the same day in other portfolios
        const candidates = db.prepare(`
            SELECT * FROM transactions 
            WHERE type = 'DEPOSIT' 
              AND assetTicker = 'CASH'
              AND date = ? 
              AND portfolioId != ? 
              AND linkedTransactionId IS NULL
        `).all(t.date, t.portfolioId);

        if (candidates.length === 0) {
            console.log(`No matching DEPOSIT found for TRANSFER on ${t.date} of ${t.amount} ${srcPort.currency} (Portfolio: ${srcPort.name})`);
            continue;
        }

        let bestMatch = null;

        if (candidates.length === 1) {
            bestMatch = candidates[0];
        } else {
            // Multiple candidates: find the one with the closest amount
            let minDiff = Infinity;
            for (const c of candidates) {
                const destPort = portMap[c.portfolioId];
                let expectedAmount = t.amount;

                if (srcPort.currency !== destPort.currency) {
                    // Try to fetch exchange rate for that date
                    const quote = db.prepare("SELECT price FROM asset_quotes WHERE ticker = 'EURUSD=X' AND date = ?").get(t.date);
                    const fxRate = (quote && quote.price > 0) ? quote.price : 1.1;

                    if (srcPort.currency === 'USD' && destPort.currency === 'EUR') {
                        expectedAmount = t.amount / fxRate;
                    } else if (srcPort.currency === 'EUR' && destPort.currency === 'USD') {
                        expectedAmount = t.amount * fxRate;
                    }
                }

                const diff = Math.abs(c.amount - expectedAmount);
                if (diff < minDiff && diff < (expectedAmount * 0.15)) { // 15% tolerance max
                    minDiff = diff;
                    bestMatch = c;
                }
            }
        }

        if (bestMatch) {
            const destPort = portMap[bestMatch.portfolioId];
            console.log(`Linking: TRANSFER on ${t.date} (${t.amount} ${srcPort.currency} from ${srcPort.name}) <-> DEPOSIT (${bestMatch.amount} ${destPort.currency} to ${destPort.name})`);
            
            db.prepare("UPDATE transactions SET linkedTransactionId = ? WHERE id = ?").run(bestMatch.id, t.id);
            db.prepare("UPDATE transactions SET linkedTransactionId = ? WHERE id = ?").run(t.id, bestMatch.id);
            
            linkedCount++;
        } else {
            console.log(`Could not uniquely resolve matching DEPOSIT for TRANSFER on ${t.date} of ${t.amount} ${srcPort.currency}`);
        }
    }
})();

console.log(`Successfully linked ${linkedCount} transfer pairs.`);
