const fs = require('fs');

let content = fs.readFileSync('src/server.js', 'utf8');

const helper = `async function callAIModel(engine, prompt, keys) {
    if (engine === 'Qwen') {
        const apiKey = keys.qwenApiKey || process.env.QWEN_API_KEY;
        if (!apiKey) throw new Error('Qwen API Key mancante.');
        const res = await axios.post('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
            model: 'qwen-plus',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
        });
        const content = res.data.choices?.[0]?.message?.content || '{}';
        return { text: content, usage: res.data.usage || {} };
    } else if (engine === 'OpenAI') {
        const apiKey = keys.openaiApiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OpenAI API Key mancante.');
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
        });
        const content = res.data.choices?.[0]?.message?.content || '{}';
        return { text: content, usage: res.data.usage || {} };
    } else {
        // Default to Gemini
        const apiKey = keys.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('Gemini API Key mancante.');
        const geminiModel = await getBestGeminiModel(apiKey);
        const res = await axios.post(
            \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json' } }
        );
        const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };
    }
}
`;

content = content.replace("    return 'gemini-2.5-flash';\n}\n\napp.get('/api/assets/:ticker/ai-analysis'", "    return 'gemini-2.5-flash';\n}\n\n" + helper + "\napp.get('/api/assets/:ticker/ai-analysis'");

fs.writeFileSync('src/server.js', content, 'utf8');
