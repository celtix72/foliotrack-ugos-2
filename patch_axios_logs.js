const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const geminiCall = `        const res = await axios.post(
            \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json' } }
        );`;

const newGeminiCall = `        let res;
        try {
            res = await axios.post(
                \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
                { contents: [{ parts: [{ text: prompt }] }] },
                { headers: { 'Content-Type': 'application/json' } }
            );
        } catch (apiErr) {
            logger.error('[AI API Error (Gemini)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }`;

code = code.replace(geminiCall, newGeminiCall);

const openaiCall = `        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
        });`;

const newOpenaiCall = `        let res;
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
        }`;

code = code.replace(openaiCall, newOpenaiCall);

const qwenCall = `        const res = await axios.post('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
            model: 'qwen-plus',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
        });`;

const newQwenCall = `        let res;
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
        }`;

code = code.replace(qwenCall, newQwenCall);

const agnesCall = `        const res = await axios.post('https://apihub.agnes-ai.com/v1/chat/completions', {
            model: 'agnes-2.0-flash',
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' }
        });`;

const newAgnesCall = `        let res;
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
        }`;

code = code.replace(agnesCall, newAgnesCall);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched API error logging');
