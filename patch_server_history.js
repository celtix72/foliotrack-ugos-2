const fs = require('fs');

let code = fs.readFileSync('src/server.js', 'utf8');

// Update the insertion to include engine
const insertSql = `                INSERT INTO asset_ai_history (ticker, action, reasoning, targetPrice, stopLoss)
                VALUES (?, ?, ?, ?, ?)`;
const insertSqlNew = `                INSERT INTO asset_ai_history (ticker, action, reasoning, targetPrice, stopLoss, engine)
                VALUES (?, ?, ?, ?, ?, ?)`;
code = code.replace(insertSql, insertSqlNew);

const insertRun = `            }).run(ticker, action, reasoning, targetPrice, stopLoss);`;
const insertRunNew = `            }).run(ticker, action, reasoning, targetPrice, stopLoss, engine);`;
code = code.replace(insertRun, insertRunNew);

// Update Both insertion (we have two inserts inside Both)
// Wait, "Both" engine does a single insert?
// Let's check how Both handles the insert
