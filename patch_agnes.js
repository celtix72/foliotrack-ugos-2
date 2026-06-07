const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

// Update /api/admin/ai-settings GET
code = code.replace(
    "openaiApiKey: settings.openaiApiKey || '',",
    "openaiApiKey: settings.openaiApiKey || '',\n            agnesApiKey: settings.agnesApiKey || '',"
);

// Update /api/admin/ai-settings POST
code = code.replace(
    "const { aiEngine, geminiApiKey, qwenApiKey, openaiApiKey, aiAssetPrompt, aiPortfolioPrompt } = req.body;",
    "const { aiEngine, geminiApiKey, qwenApiKey, openaiApiKey, agnesApiKey, aiAssetPrompt, aiPortfolioPrompt } = req.body;"
);

code = code.replace(
    "if (openaiApiKey !== undefined) database.setSetting(1, 'openaiApiKey', openaiApiKey);",
    "if (openaiApiKey !== undefined) database.setSetting(1, 'openaiApiKey', openaiApiKey);\n        if (agnesApiKey !== undefined) database.setSetting(1, 'agnesApiKey', agnesApiKey);"
);

// Update callAIModel to include Agnes
const newHelper = `    } else if (engine === 'Agnes') {
        const apiKey = keys.agnesApiKey || process.env.AGNES_API_KEY;
        if (!apiKey) throw new Error('Agnes API Key mancante.');
        const res = await axios.post('https://apihub.agnes-ai.com/v1/chat/completions', {
            model: 'agnes-2.0-flash',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
        });
        const content = res.data.choices?.[0]?.message?.content || '{}';
        return { text: content, usage: res.data.usage || {} };
    } else {
        // Default to Gemini`;

code = code.replace("    } else {\n        // Default to Gemini", newHelper);

fs.writeFileSync('src/server.js', code, 'utf8');
