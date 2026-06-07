const fs = require('fs');

let code = fs.readFileSync('src/server.js', 'utf8');

const helper = `function parseAIResponse(rawText) {
    let cleanText = rawText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
    try {
        return JSON.parse(cleanText);
    } catch (e) {
        console.warn('JSON parse failed, attempting regex extraction. Error:', e.message);
        const result = { action: 'HOLD', targetProfit: 0, stopLoss: 0, reasoning: rawText };
        
        const actionMatch = rawText.match(/"action"\\s*:\\s*"([^"]+)"/i);
        if (actionMatch) result.action = actionMatch[1].toUpperCase();
        
        const tpMatch = rawText.match(/"targetProfit"\\s*:\\s*([\\d.]+)/i);
        if (tpMatch) result.targetProfit = parseFloat(tpMatch[1]);
        
        const slMatch = rawText.match(/"stopLoss"\\s*:\\s*([\\d.]+)/i);
        if (slMatch) result.stopLoss = parseFloat(slMatch[1]);
        
        // Extract reasoning
        const reasoningMatch = rawText.match(/"reasoning"\\s*:\\s*"([\\s\\S]*?)"(?=\\n\\s*\\}|\\r\\n\\s*\\}|,\\s*"targetProfit"|,\\s*"stopLoss"|,\\s*"action"|$)/i);
        if (reasoningMatch) {
            result.reasoning = reasoningMatch[1].replace(/\\\\n/g, '\\n').replace(/\\\\"/g, '"');
        } else {
            // If we can't find reasoning field, try to strip the json wrapper from raw text
            let stripped = rawText.replace(/\\{[\\s\\S]*"reasoning"\\s*:\\s*"/i, '');
            stripped = stripped.replace(/"\\s*\\}[\\s\\S]*$/i, '');
            result.reasoning = stripped.trim() ? stripped : rawText;
        }
        
        return result;
    }
}
`;

// Insert the helper near callAIModel
code = code.replace("async function callAIModel", helper + "\nasync function callAIModel");

// Update the Both branch
const oldBothGemini = `                try {
                    const cleanG = geminiText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
                    parsedGemini = JSON.parse(cleanG);
                } catch(e) {}`;
code = code.replace(oldBothGemini, "                parsedGemini = parseAIResponse(geminiText);");

const oldBothQwen = `                try {
                    const cleanQ = qwenText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
                    parsedQwen = JSON.parse(cleanQ);
                } catch(e) {}`;
code = code.replace(oldBothQwen, "                parsedQwen = parseAIResponse(qwenText);");

// Update the single engine branch
const oldSingleEngine = `                const cleanText = rawText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
                parsedResponse = JSON.parse(cleanText);`;
code = code.replace(oldSingleEngine, "                parsedResponse = parseAIResponse(rawText);");

fs.writeFileSync('src/server.js', code, 'utf8');
