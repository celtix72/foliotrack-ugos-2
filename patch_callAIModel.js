const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

// 1. Remove hardcoded checks in /api/assets/:ticker/ai-analysis
const assetCheck = `        const apiKey = globalSettings.geminiApiKey || process.env.GEMINI_API_KEY;
        
        if (!apiKey) {
            return res.status(400).json({ error: 'Chiave API GEMINI_API_KEY mancante. Configurala nel pannello Admin o nel file .env per abilitare questa funzionalità.' });
        }`;
code = code.replace(assetCheck, '');

// 2. Remove hardcoded checks in /api/portfolios/:id/ai-analysis
code = code.replace(assetCheck, '');

// 3. Update callAIModel
const oldCallAiModel = `async function callAIModel(engine, prompt, keys) {
    logger.info(\`[AI Iteration] Starting analysis with engine: \${engine}\`);
    logger.info(\`[AI Prompt] \\n\${prompt}\`);
    if (engine === 'Qwen') {
        const apiKey = keys.qwenApiKey || process.env.QWEN_API_KEY;
        if (!apiKey) throw new Error('Qwen API Key mancante.');
        let res;
        try {
            res = await axios.post('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
                model: 'qwen-plus',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Qwen)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        return { text: content, usage: res.data.usage || {} };
    } else if (engine === 'OpenAI') {
        const apiKey = keys.openaiApiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OpenAI API Key mancante.');
        let res;
        try {
            res = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (OpenAI)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        return { text: content, usage: res.data.usage || {} };
    } else if (engine === 'Agnes') {
        const apiKey = keys.agnesApiKey || process.env.AGNES_API_KEY;
        if (!apiKey) throw new Error('Agnes API Key mancante.');
        let res;
        try {
            res = await axios.post('https://apihub.agnes-ai.com/v1/chat/completions', {
                model: 'agnes-2.0-flash',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Agnes)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        return { text: content, usage: res.data.usage || {} };
    } else {
        // Default to Gemini
        const apiKey = keys.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('Gemini API Key mancante.');
        const geminiModel = await getBestGeminiModel(apiKey);
        let res;
        try {
            res = await axios.post(
                \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
                { contents: [{ parts: [{ text: prompt }] }] },
                { headers: { 'Content-Type': 'application/json' } }
            );
        } catch (apiErr) {
            logger.error('[AI API Error (Gemini)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };
    }
}`;

const newCallAiModel = `async function callAIModel(engine, prompt, keys) {
    const parts = engine.split('_');
    const baseEngine = parts[0] || 'Gemini';
    const tier = parts[1] || 'Pay';

    logger.info(\`[AI Iteration] Starting analysis with engine: \${engine}\`);
    logger.info(\`[AI Prompt] \\n\${prompt}\`);
    if (baseEngine === 'Qwen') {
        const apiKey = tier === 'Free' ? keys.qwenApiKeyFree : (keys.qwenApiKeyPay || keys.qwenApiKey || process.env.QWEN_API_KEY);
        if (!apiKey) throw new Error(\`Qwen API Key (\${tier}) mancante.\`);
        let res;
        try {
            res = await axios.post('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
                model: 'qwen-plus',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Qwen)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'OpenAI') {
        const apiKey = tier === 'Free' ? keys.openaiApiKeyFree : (keys.openaiApiKeyPay || keys.openaiApiKey || process.env.OPENAI_API_KEY);
        if (!apiKey) throw new Error(\`OpenAI API Key (\${tier}) mancante.\`);
        let res;
        try {
            res = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (OpenAI)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'Agnes') {
        const apiKey = tier === 'Free' ? keys.agnesApiKeyFree : (keys.agnesApiKeyPay || keys.agnesApiKey || process.env.AGNES_API_KEY);
        if (!apiKey) throw new Error(\`Agnes API Key (\${tier}) mancante.\`);
        let res;
        try {
            res = await axios.post('https://apihub.agnes-ai.com/v1/chat/completions', {
                model: 'agnes-2.0-flash',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Agnes)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        return { text: content, usage: res.data.usage || {} };
    } else {
        // Default to Gemini
        const apiKey = tier === 'Free' ? keys.geminiApiKeyFree : (keys.geminiApiKeyPay || keys.geminiApiKey || process.env.GEMINI_API_KEY);
        if (!apiKey) throw new Error(\`Gemini API Key (\${tier}) mancante.\`);
        const geminiModel = await getBestGeminiModel(apiKey);
        let res;
        try {
            res = await axios.post(
                \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
                { contents: [{ parts: [{ text: prompt }] }] },
                { headers: { 'Content-Type': 'application/json' } }
            );
        } catch (apiErr) {
            logger.error('[AI API Error (Gemini)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        logger.info(\`[AI Response (\${engine})] \\n\${content}\`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };
    }
}`;

code = code.replace(oldCallAiModel, newCallAiModel);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched callAIModel');
