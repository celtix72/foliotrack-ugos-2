const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const insertSql = `            // Inserisci nello storico
            database.db.prepare(\`
                INSERT INTO asset_ai_history (ticker, action, reasoning, targetPrice, stopLoss)
                VALUES (?, ?, ?, ?, ?)
            \`).run(ticker, action, reasoning, targetPrice, stopLoss);`;
            
const insertSqlNew = `            // Inserisci nello storico
            database.db.prepare(\`
                INSERT INTO asset_ai_history (ticker, action, reasoning, targetPrice, stopLoss, engine)
                VALUES (?, ?, ?, ?, ?, ?)
            \`).run(ticker, action, reasoning, targetPrice, stopLoss, engine);`;

code = code.replace(insertSql, insertSqlNew);
fs.writeFileSync('src/server.js', code, 'utf8');
