const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

// Replace the /api/assets/:ticker/ai-analysis AI call logic
const oldAssetLogic = `        const geminiModel = await getBestGeminiModel(apiKey);
        console.log(\`[AI Analysis] Using model: \${geminiModel} for asset \${ticker}\`);
        const response = await axios.post(
            \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
            {
                contents: [{ parts: [{ text: prompt }] }]
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );

        let parsedResponse = null;
        try {
            const rawText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
            const cleanText = rawText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
            parsedResponse = JSON.parse(cleanText);
        } catch (e) {
            console.error('Failed to parse AI JSON response:', e);
            throw new Error("Errore di parsing del responso IA.");
        }

        const usage = response.data.usageMetadata || {};
        const tokensUsed = usage.totalTokenCount || 0;`;

const newAssetLogic = `        const engine = globalSettings.aiEngine || 'Gemini';
        let parsedResponse = null;
        let tokensUsed = 0;
        let usage = {};

        try {
            if (engine === 'Both') {
                sendEvent('progress', { message: 'Generazione in corso (Gemini + Qwen)...' });
                const [geminiRes, qwenRes] = await Promise.allSettled([
                    callAIModel('Gemini', prompt, globalSettings),
                    callAIModel('Qwen', prompt, globalSettings)
                ]);

                let geminiText = "{}";
                if (geminiRes.status === 'fulfilled') {
                    geminiText = geminiRes.value.text;
                    tokensUsed += (geminiRes.value.usage.totalTokenCount || 0);
                }

                let qwenText = "{}";
                if (qwenRes.status === 'fulfilled') {
                    qwenText = qwenRes.value.text;
                    // Qwen tokens approximation or tracking if provided
                    tokensUsed += (qwenRes.value.usage.total_tokens || 0);
                }

                let parsedGemini = {};
                let parsedQwen = {};
                
                try {
                    const cleanG = geminiText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
                    parsedGemini = JSON.parse(cleanG);
                } catch(e) {}
                
                try {
                    const cleanQ = qwenText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
                    parsedQwen = JSON.parse(cleanQ);
                } catch(e) {}

                parsedResponse = {
                    action: parsedGemini.action || parsedQwen.action || 'HOLD',
                    targetProfit: parsedGemini.targetProfit || parsedQwen.targetProfit || 0,
                    stopLoss: parsedGemini.stopLoss || parsedQwen.stopLoss || 0,
                    reasoning: \`### Analisi prodotta da Gemini\\n\\n\${parsedGemini.reasoning || 'Nessuna risposta valida da Gemini.'}\\n\\n---\\n\\n### Analisi prodotta da Qwen\\n\\n\${parsedQwen.reasoning || 'Nessuna risposta valida da Qwen.'}\`
                };

            } else {
                sendEvent('progress', { message: \`Generazione responso IA in corso tramite \${engine}...\` });
                const res = await callAIModel(engine, prompt, globalSettings);
                const rawText = res.text;
                tokensUsed = res.usage.totalTokenCount || res.usage.total_tokens || 0;
                usage = res.usage;
                
                const cleanText = rawText.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
                parsedResponse = JSON.parse(cleanText);
                parsedResponse.reasoning = \`### Analisi prodotta da \${engine}\\n\\n\` + (parsedResponse.reasoning || '');
            }
        } catch (e) {
            console.error('Failed to parse AI JSON response:', e);
            throw new Error("Errore durante la generazione o parsing del responso IA.");
        }`;

code = code.replace(oldAssetLogic, newAssetLogic);

// Replace the /api/portfolios/:id/ai-analysis AI call logic
const oldPortfolioLogic = `        const geminiModel = await getBestGeminiModel(apiKey);
        console.log(\`[AI Analysis] Using model: \${geminiModel} for portfolio \${portfolioId}\`);
        const response = await axios.post(
            \`https://generativelanguage.googleapis.com/v1beta/models/\${geminiModel}:generateContent?key=\${apiKey}\`,
            {
                contents: [{ parts: [{ text: prompt }] }]
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const rawText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "Nessuna risposta generata.";
        
        const usage = response.data.usageMetadata || {};
        const tokensUsed = usage.totalTokenCount || 0;`;

const newPortfolioLogic = `        const engine = globalSettings.aiEngine || 'Gemini';
        let rawText = "Nessuna risposta generata.";
        let tokensUsed = 0;
        let usage = {};

        try {
            if (engine === 'Both') {
                sendEvent('progress', { message: 'Generazione in corso (Gemini + Qwen)...' });
                const [geminiRes, qwenRes] = await Promise.allSettled([
                    callAIModel('Gemini', prompt, globalSettings),
                    callAIModel('Qwen', prompt, globalSettings)
                ]);

                let geminiText = "Errore nella generazione con Gemini.";
                if (geminiRes.status === 'fulfilled') {
                    geminiText = geminiRes.value.text;
                    tokensUsed += (geminiRes.value.usage.totalTokenCount || 0);
                }

                let qwenText = "Errore nella generazione con Qwen.";
                if (qwenRes.status === 'fulfilled') {
                    qwenText = qwenRes.value.text;
                    tokensUsed += (qwenRes.value.usage.total_tokens || 0);
                }

                rawText = \`### Analisi prodotta da Gemini\\n\\n\${geminiText}\\n\\n---\\n\\n### Analisi prodotta da Qwen\\n\\n\${qwenText}\`;

            } else {
                sendEvent('progress', { message: \`Generazione responso IA in corso tramite \${engine}...\` });
                const res = await callAIModel(engine, prompt, globalSettings);
                rawText = \`### Analisi prodotta da \${engine}\\n\\n\` + res.text;
                tokensUsed = res.usage.totalTokenCount || res.usage.total_tokens || 0;
                usage = res.usage;
            }
        } catch (e) {
            console.error('Failed to generate portfolio AI response:', e);
            throw new Error("Errore durante la generazione del responso IA.");
        }`;

code = code.replace(oldPortfolioLogic, newPortfolioLogic);

fs.writeFileSync('src/server.js', code, 'utf8');
