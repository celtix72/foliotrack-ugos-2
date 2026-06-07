const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

// For /api/watchlist
let p1 = code.indexOf("const result = rows.map(a => {");
let p2 = code.indexOf("res.json(result);", p1);

let block = code.substring(p1, p2);
let newBlock = block.replace("const result = rows.map(a => {", `
        const aiHistoryStmt = database.db.prepare(\`
            SELECT engine, action as aiAction, targetPrice as aiTargetPrice, MAX(created_at) as created_at
            FROM asset_ai_history
            WHERE ticker = ? AND engine IS NOT NULL
            GROUP BY engine
        \`);
        const result = rows.map(a => {
            const aiBadges = aiHistoryStmt.all(a.ticker);
`);
newBlock = newBlock.replace("aiReasoning: a.aiReasoning,", "aiReasoning: a.aiReasoning,\n                aiBadges,");
code = code.substring(0, p1) + newBlock + code.substring(p2);

// For /api/market
p1 = code.indexOf("        const result = rows.map(a => {", p2);
p2 = code.indexOf("        res.json(result);", p1);

block = code.substring(p1, p2);
newBlock = block.replace("        const result = rows.map(a => {", `
        const aiHistoryStmt = database.db.prepare(\`
            SELECT engine, action as aiAction, targetPrice as aiTargetPrice, MAX(created_at) as created_at
            FROM asset_ai_history
            WHERE ticker = ? AND engine IS NOT NULL
            GROUP BY engine
        \`);
        const result = rows.map(a => {
            const aiBadges = aiHistoryStmt.all(a.ticker);
`);
newBlock = newBlock.replace("aiReasoning: a.ai_reasoning,", "aiReasoning: a.ai_reasoning,\n                aiBadges,");
code = code.substring(0, p1) + newBlock + code.substring(p2);

fs.writeFileSync('src/server.js', code, 'utf8');
