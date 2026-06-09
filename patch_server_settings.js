const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

// 1. In GET /api/admin/ai-settings
const oldAdminAiSettings = `        res.json({
            aiEngine: settings.aiEngine || 'Gemini',
            geminiApiKey: settings.geminiApiKey || '',
            qwenApiKey: settings.qwenApiKey || '',
            openaiApiKey: settings.openaiApiKey || '',
            agnesApiKey: settings.agnesApiKey || '',
            aiAssetPrompt: settings.aiAssetPrompt || '',
            aiPortfolioPrompt: settings.aiPortfolioPrompt || '',
            aiTokensUsedToday: settings.aiTokensUsedToday || '0',
            aiTokensDate: settings.aiTokensDate || ''
        });`;

const newAdminAiSettings = `        res.json({
            aiEngine: settings.aiEngine || 'Gemini_Free',
            geminiApiKeyFree: settings.geminiApiKeyFree || '',
            geminiApiKeyPay: settings.geminiApiKeyPay || settings.geminiApiKey || '',
            qwenApiKeyFree: settings.qwenApiKeyFree || '',
            qwenApiKeyPay: settings.qwenApiKeyPay || settings.qwenApiKey || '',
            openaiApiKeyFree: settings.openaiApiKeyFree || '',
            openaiApiKeyPay: settings.openaiApiKeyPay || settings.openaiApiKey || '',
            agnesApiKeyFree: settings.agnesApiKeyFree || '',
            agnesApiKeyPay: settings.agnesApiKeyPay || settings.agnesApiKey || '',
            aiAssetPrompt: settings.aiAssetPrompt || '',
            aiPortfolioPrompt: settings.aiPortfolioPrompt || '',
            aiTokensUsedToday: settings.aiTokensUsedToday || '0',
            aiTokensDate: settings.aiTokensDate || ''
        });`;

code = code.replace(oldAdminAiSettings, newAdminAiSettings);

// 2. In POST /api/settings/ai
const oldPostAiSettings = `    const { aiEngine, geminiApiKey, qwenApiKey, openaiApiKey, agnesApiKey, aiAssetPrompt, aiPortfolioPrompt } = req.body;
    try {
        if (aiEngine !== undefined) database.setSetting(1, 'aiEngine', aiEngine);
        if (geminiApiKey !== undefined) database.setSetting(1, 'geminiApiKey', geminiApiKey);
        if (qwenApiKey !== undefined) database.setSetting(1, 'qwenApiKey', qwenApiKey);
        if (openaiApiKey !== undefined) database.setSetting(1, 'openaiApiKey', openaiApiKey);
        if (agnesApiKey !== undefined) database.setSetting(1, 'agnesApiKey', agnesApiKey);
        if (aiAssetPrompt !== undefined) database.setSetting(1, 'aiAssetPrompt', aiAssetPrompt);
        if (aiPortfolioPrompt !== undefined) database.setSetting(1, 'aiPortfolioPrompt', aiPortfolioPrompt);`;

const newPostAiSettings = `    const { aiEngine, geminiApiKeyFree, geminiApiKeyPay, qwenApiKeyFree, qwenApiKeyPay, openaiApiKeyFree, openaiApiKeyPay, agnesApiKeyFree, agnesApiKeyPay, aiAssetPrompt, aiPortfolioPrompt } = req.body;
    try {
        if (aiEngine !== undefined) database.setSetting(1, 'aiEngine', aiEngine);
        if (geminiApiKeyFree !== undefined) database.setSetting(1, 'geminiApiKeyFree', geminiApiKeyFree);
        if (geminiApiKeyPay !== undefined) database.setSetting(1, 'geminiApiKeyPay', geminiApiKeyPay);
        if (qwenApiKeyFree !== undefined) database.setSetting(1, 'qwenApiKeyFree', qwenApiKeyFree);
        if (qwenApiKeyPay !== undefined) database.setSetting(1, 'qwenApiKeyPay', qwenApiKeyPay);
        if (openaiApiKeyFree !== undefined) database.setSetting(1, 'openaiApiKeyFree', openaiApiKeyFree);
        if (openaiApiKeyPay !== undefined) database.setSetting(1, 'openaiApiKeyPay', openaiApiKeyPay);
        if (agnesApiKeyFree !== undefined) database.setSetting(1, 'agnesApiKeyFree', agnesApiKeyFree);
        if (agnesApiKeyPay !== undefined) database.setSetting(1, 'agnesApiKeyPay', agnesApiKeyPay);
        if (aiAssetPrompt !== undefined) database.setSetting(1, 'aiAssetPrompt', aiAssetPrompt);
        if (aiPortfolioPrompt !== undefined) database.setSetting(1, 'aiPortfolioPrompt', aiPortfolioPrompt);`;

code = code.replace(oldPostAiSettings, newPostAiSettings);

// 3. In GET /api/settings/ai
const oldGetAiSettings = `        if (settings.geminiApiKey || process.env.GEMINI_API_KEY) available.push('Gemini');
        if (settings.qwenApiKey || process.env.QWEN_API_KEY) available.push('Qwen');
        if (settings.openaiApiKey || process.env.OPENAI_API_KEY) available.push('OpenAI');
        if (settings.agnesApiKey || process.env.AGNES_API_KEY) available.push('Agnes');
        
        if (available.length >= 2 && available.includes('Gemini') && available.includes('Qwen')) {
            available.push('Both');
        }
        
        res.json({ engines: available, default: settings.aiEngine || 'Gemini' });`;

const newGetAiSettings = `        if (settings.geminiApiKeyFree) available.push('Gemini_Free');
        if (settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY) available.push('Gemini_Pay');
        if (settings.qwenApiKeyFree) available.push('Qwen_Free');
        if (settings.qwenApiKeyPay || settings.qwenApiKey || process.env.QWEN_API_KEY) available.push('Qwen_Pay');
        if (settings.openaiApiKeyFree) available.push('OpenAI_Free');
        if (settings.openaiApiKeyPay || settings.openaiApiKey || process.env.OPENAI_API_KEY) available.push('OpenAI_Pay');
        if (settings.agnesApiKeyFree) available.push('Agnes_Free');
        if (settings.agnesApiKeyPay || settings.agnesApiKey || process.env.AGNES_API_KEY) available.push('Agnes_Pay');
        
        const hasGemini = available.some(e => e.startsWith('Gemini'));
        const hasQwen = available.some(e => e.startsWith('Qwen'));
        if (hasGemini && hasQwen) {
            available.push('Both');
        }
        
        res.json({ engines: available, default: settings.aiEngine || 'Gemini_Free' });`;

code = code.replace(oldGetAiSettings, newGetAiSettings);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched server settings endpoints');
