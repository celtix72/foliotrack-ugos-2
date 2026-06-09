const fs = require('fs');
let code = fs.readFileSync('src/db.js', 'utf8');

const oldMigration = `    // Robust Migration: Fix portfolio_history NOT NULL constraint and ensure user_id exists
    try {
        const tableInfo = dbConnection.prepare("PRAGMA table_info(portfolio_history)").all();
        const portfolioIdCol = tableInfo.find(c => c.name === 'portfolioId');
        const hasUserId = tableInfo.some(c => c.name === 'user_id');
        
        if (!hasUserId || (portfolioIdCol && portfolioIdCol.notnull === 1)) {`;

const newMigration = `    // Robust Migration: Fix portfolio_history NOT NULL constraint and ensure user_id exists
    try {
        const tableInfo = dbConnection.prepare("PRAGMA table_info(portfolio_history)").all();
        if (tableInfo.length > 0) {
            const hasNetDeposits = tableInfo.some(c => c.name === 'netDeposits');
            if (!hasNetDeposits) {
                dbConnection.prepare("ALTER TABLE portfolio_history ADD COLUMN netDeposits REAL NOT NULL DEFAULT 0").run();
            }

            const portfolioIdCol = tableInfo.find(c => c.name === 'portfolioId');
            const hasUserId = tableInfo.some(c => c.name === 'user_id');
            
            if (!hasUserId || (portfolioIdCol && portfolioIdCol.notnull === 1)) {`;

code = code.replace(oldMigration, newMigration);

const oldMigrationEnd = `                // Create index for global snapshot
                dbConnection.prepare(\`CREATE UNIQUE INDEX IF NOT EXISTS idx_global_history_user ON portfolio_history(date, user_id) WHERE portfolioId IS NULL\`).run();
            })();
        }
    } catch (e) {`;

const newMigrationEnd = `                // Create index for global snapshot
                dbConnection.prepare(\`CREATE UNIQUE INDEX IF NOT EXISTS idx_global_history_user ON portfolio_history(date, user_id) WHERE portfolioId IS NULL\`).run();
            })();
        }
        }
    } catch (e) {`;

code = code.replace(oldMigrationEnd, newMigrationEnd);

fs.writeFileSync('src/db.js', code, 'utf8');
console.log('Patched db.js migration logic');
