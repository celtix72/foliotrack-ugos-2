const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const newEndpoint = `
// GET /api/ai/available-engines
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

// Just insert it before app.get('/api/admin/ai-settings'
code = code.replace("app.get('/api/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {", newEndpoint + "\napp.get('/api/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {");

fs.writeFileSync('src/server.js', code, 'utf8');
console.log("Patched correctly");
