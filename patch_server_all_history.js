const fs = require('fs');

let code = fs.readFileSync('src/server.js', 'utf8');

// The query I previously inserted:
const oldQuery = `SELECT engine, action as aiAction, targetPrice as aiTargetPrice, MAX(created_at) as created_at
            FROM asset_ai_history
            WHERE ticker = ? AND engine IS NOT NULL
            GROUP BY engine`;

const newQuery = `SELECT engine, action as aiAction, targetPrice as aiTargetPrice, created_at
            FROM asset_ai_history
            WHERE ticker = ? AND engine IS NOT NULL
            ORDER BY created_at DESC LIMIT 5`;

code = code.split(oldQuery).join(newQuery);

fs.writeFileSync('src/server.js', code, 'utf8');
