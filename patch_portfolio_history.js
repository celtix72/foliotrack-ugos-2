const fs = require('fs');

let code = fs.readFileSync('src/db.js', 'utf8');

// Update the initial CREATE TABLE
code = code.replace(
    "portfolioId  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,",
    "portfolioId  INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,"
);

// Add the user_id column into the initial CREATE TABLE
code = code.replace(
    "createdAt    TEXT    NOT NULL DEFAULT (datetime('now')),",
    "createdAt    TEXT    NOT NULL DEFAULT (datetime('now')),\n        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,"
);

// Replace the old migration with the robust one
const robustMigration = `    // Robust Migration: Fix portfolio_history NOT NULL constraint and ensure user_id exists
    try {
        const tableInfo = dbConnection.prepare("PRAGMA table_info(portfolio_history)").all();
        const portfolioIdCol = tableInfo.find(c => c.name === 'portfolioId');
        const hasUserId = tableInfo.some(c => c.name === 'user_id');
        
        if (!hasUserId || (portfolioIdCol && portfolioIdCol.notnull === 1)) {
            dbConnection.transaction(() => {
                dbConnection.prepare(\`
                    CREATE TABLE portfolio_history_new (
                        id           INTEGER PRIMARY KEY AUTOINCREMENT,
                        portfolioId  INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
                        date         TEXT    NOT NULL,
                        totalValue   REAL    NOT NULL DEFAULT 0,
                        cashValue    REAL    NOT NULL DEFAULT 0,
                        assetValue   REAL    NOT NULL DEFAULT 0,
                        netDeposits  REAL    NOT NULL DEFAULT 0,
                        createdAt    TEXT    NOT NULL DEFAULT (datetime('now')),
                        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
                        UNIQUE(portfolioId, date)
                    )
                \`).run();
                
                // Copy data
                if (hasUserId) {
                    dbConnection.prepare(\`
                        INSERT INTO portfolio_history_new (id, portfolioId, date, totalValue, cashValue, assetValue, netDeposits, createdAt, user_id)
                        SELECT id, portfolioId, date, totalValue, cashValue, assetValue, netDeposits, createdAt, user_id
                        FROM portfolio_history
                    \`).run();
                } else {
                    dbConnection.prepare(\`
                        INSERT INTO portfolio_history_new (id, portfolioId, date, totalValue, cashValue, assetValue, netDeposits, createdAt)
                        SELECT id, portfolioId, date, totalValue, cashValue, assetValue, netDeposits, createdAt
                        FROM portfolio_history
                    \`).run();
                }
                
                dbConnection.prepare(\`DROP TABLE portfolio_history\`).run();
                dbConnection.prepare(\`ALTER TABLE portfolio_history_new RENAME TO portfolio_history\`).run();
                
                // Create index for global snapshot
                dbConnection.prepare(\`CREATE UNIQUE INDEX IF NOT EXISTS idx_global_history_user ON portfolio_history(date, user_id) WHERE portfolioId IS NULL\`).run();
            })();
        }
    } catch (e) {
        console.error("Migration error: Failed to recreate portfolio_history:", e);
    }`;

code = code.replace(
    "    // Migration: Add user_id to portfolio_history if it doesn't exist\n    try {\n        dbConnection.prepare(`ALTER TABLE portfolio_history ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`).run();\n    } catch (e) {}",
    robustMigration
);

fs.writeFileSync('src/db.js', code, 'utf8');
