const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const newEndpoint = `// GET /api/ai/available-engines
app.get('/api/ai/available-engines', requireAuth, (req, res) => {
    try {
        const settings = database.getSettings(1);
        const available = [];
        
        if (settings.geminiApiKey || process.env.GEMINI_API_KEY) available.push('Gemini');
        if (settings.qwenApiKey || process.env.QWEN_API_KEY) available.push('Qwen');
        if (settings.openaiApiKey || process.env.OPENAI_API_KEY) available.push('OpenAI');
        if (settings.agnesApiKey || process.env.AGNES_API_KEY) available.push('Agnes');
        
        if (available.length >= 2 && available.includes('Gemini') && available.includes('Qwen')) {
            available.push('Both');
        }
        
        res.json({ engines: available, default: settings.aiEngine || 'Gemini' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

`;

// Insert after the /api/admin/ai-settings POST endpoint
code = code.replace(
    "        res.json({ ok: true });\n    } catch (e) {\n        res.status(500).json({ error: e.message });\n    }\n});\n",
    "        res.json({ ok: true });\n    } catch (e) {\n        res.status(500).json({ error: e.message });\n    }\n});\n\n" + newEndpoint
);

// Update /api/assets/:ticker/ai-analysis to accept ?engine=
code = code.replace(
    "        const engine = globalSettings.aiEngine || 'Gemini';",
    "        const engine = req.query.engine || globalSettings.aiEngine || 'Gemini';"
);

// Do the same for /api/portfolios/:id/ai-analysis
// We'll replace it generally if possible, or just look for the second match.
// Wait, for portfolios it's also inside ai-analysis.
let index = 0;
code = code.replace(/const engine = globalSettings\.aiEngine \|\| 'Gemini';/g, match => {
    index++;
    // The first one is assets, second is portfolios
    return "const engine = req.query.engine || globalSettings.aiEngine || 'Gemini';";
});

fs.writeFileSync('src/server.js', code, 'utf8');
