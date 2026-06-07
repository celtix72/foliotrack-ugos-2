const fs = require('fs');

let content = fs.readFileSync('src/server.js', 'utf8');

// Update SQL for assets table update
content = content.replace(
    "SET targetPrice = ?, stopLoss = ?, ai_action = ?, ai_reasoning = ?, ai_updated_at = CURRENT_TIMESTAMP",
    "SET targetPrice = ?, stopLoss = ?, ai_action = ?, ai_reasoning = ?, ai_engine = ?, ai_updated_at = CURRENT_TIMESTAMP"
);

content = content.replace(
    "            database.db.prepare(`\n                UPDATE assets \n                SET targetPrice = ?, stopLoss = ?, ai_action = ?, ai_reasoning = ?, ai_engine = ?, ai_updated_at = CURRENT_TIMESTAMP\n                WHERE ticker = ?\n            `).run(targetPrice, stopLoss, action, reasoning, ticker);",
    "            database.db.prepare(`\n                UPDATE assets \n                SET targetPrice = ?, stopLoss = ?, ai_action = ?, ai_reasoning = ?, ai_engine = ?, ai_updated_at = CURRENT_TIMESTAMP\n                WHERE ticker = ?\n            `).run(targetPrice, stopLoss, action, reasoning, engine, ticker);"
);

// We need to make sure the engine is passed. Wait, engine is already defined in the ai-analysis scope as 'const engine = globalSettings.aiEngine || 'Gemini';'
// Let's verify if `engine` is in scope there.
// The code inside /api/assets/:ticker/ai-analysis:
// const engine = globalSettings.aiEngine || 'Gemini';
// ...
// database.db.transaction(() => { ... })
// Yes, it is in scope.

// Update GET /api/watchlist
content = content.replace(
    "                   a.ai_updated_at as aiUpdatedAt,",
    "                   a.ai_updated_at as aiUpdatedAt,\n                   a.ai_engine as aiEngine,\n                   a.targetPrice as aiTargetPrice,"
);

// Ensure it's mapped in the output of GET /api/watchlist
content = content.replace(
    "                stopLoss: a.userStopLoss,",
    "                stopLoss: a.userStopLoss,\n                aiEngine: a.aiEngine,\n                aiTargetPrice: a.aiTargetPrice,\n                aiAction: a.aiAction,\n                aiReasoning: a.aiReasoning,"
);

fs.writeFileSync('src/server.js', content, 'utf8');
