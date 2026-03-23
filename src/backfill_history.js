const Database = require('better-sqlite3');
const db = new Database('/Users/mauro/Documents/Progetto_FolioTracker2/foliotrack.db');

console.log('Starting backfill of netDeposits in portfolio_history...');

const history = db.prepare('SELECT id, portfolioId, date FROM portfolio_history').all();
const stmtUpdate = db.prepare('UPDATE portfolio_history SET netDeposits = ? WHERE id = ?');

for (const record of history) {
    if (!record.portfolioId) {
        // Global history record - sum all portfolios
        const portfolios = db.prepare('SELECT id FROM portfolios').all();
        let globalNetDep = 0;
        for (const p of portfolios) {
            const txs = db.prepare('SELECT type, amount, quantity, price, commission, tax, exchangeRate FROM transactions WHERE portfolioId = ? AND date <= ?').all(p.id, record.date);
            let pNetDep = 0;
            for (const t of txs) {
                const amount = t.amount || ((t.quantity || 0) * (t.price || 0) + (t.commission || 0) + (t.tax || 0)) / (t.exchangeRate || 1);
                if (t.type === 'DEPOSIT') pNetDep += amount;
                if (t.type === 'WITHDRAWAL' || t.type === 'TRANSFER') pNetDep -= amount;
            }
            // For now, assume EUR if no currency info in history record (history is in EUR global)
            globalNetDep += pNetDep;
        }
        stmtUpdate.run(Math.round(globalNetDep), record.id);
    } else {
        // Individual portfolio history record
        const txs = db.prepare('SELECT type, amount, quantity, price, commission, tax, exchangeRate FROM transactions WHERE portfolioId = ? AND date <= ?').all(record.portfolioId, record.date);
        let netDep = 0;
        for (const t of txs) {
            const amount = t.amount || ((t.quantity || 0) * (t.price || 0) + (t.commission || 0) + (t.tax || 0)) / (t.exchangeRate || 1);
            if (t.type === 'DEPOSIT') netDep += amount;
            if (t.type === 'WITHDRAWAL' || t.type === 'TRANSFER') netDep -= amount;
        }
        stmtUpdate.run(Math.round(netDep), record.id);
    }
}

console.log('Backfill completed successfully.');
db.close();
