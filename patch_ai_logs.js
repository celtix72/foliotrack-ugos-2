const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const oldFuncStart = `async function callAIModel(engine, prompt, keys) {`;
const newFuncStart = `async function callAIModel(engine, prompt, keys) {
    logger.info(\`[AI Iteration] Starting analysis with engine: \${engine}\`);
    logger.info(\`[AI Prompt] \n\${prompt}\`);`;

code = code.replace(oldFuncStart, newFuncStart);

// Qwen return
code = code.replace(
    `const content = res.data.choices?.[0]?.message?.content || '{}';
        return { text: content, usage: res.data.usage || {} };`,
    `const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \n\${content}\`);
        return { text: content, usage: res.data.usage || {} };`
);

// OpenAI return
code = code.replace(
    `const content = res.data.choices?.[0]?.message?.content || '{}';
        return { text: content, usage: res.data.usage || {} };`,
    `const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \n\${content}\`);
        return { text: content, usage: res.data.usage || {} };`
);

// Agnes return
code = code.replace(
    `const content = res.data.choices?.[0]?.message?.content || '{}';
        return { text: content, usage: res.data.usage || {} };`,
    `const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(\`[AI Response (\${engine})] \n\${content}\`);
        return { text: content, usage: res.data.usage || {} };`
);

// Gemini return
code = code.replace(
    `const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };`,
    `const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        logger.info(\`[AI Response (\${engine})] \n\${content}\`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };`
);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched AI logs');
