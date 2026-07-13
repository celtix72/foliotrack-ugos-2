const axios = require('axios');
const { logger } = require('../utils/logger');

let _cachedGeminiModel = null;
let _geminiModelCachedAt = 0;
const GEMINI_MODEL_CACHE_MS = 60 * 60 * 1000; // 1 hour

let _cachedOpenRouterModels = [];
let _openRouterModelsCachedAt = 0;

async function fetchOpenRouterModels() {
    try {
        const res = await axios.get('https://openrouter.ai/api/v1/models');
        if (res.data && res.data.data) {
            
            const preferredProviders = ['openai/', 'anthropic/', 'google/', 'meta-llama/', 'mistralai/', 'deepseek/', 'qwen/', 'xiaomi/'];
            
            let filtered = res.data.data.filter(m => {
                const id = m.id.toLowerCase();
                const promptPrice = parseFloat(m.pricing?.prompt || 0) * 1000000;
                
                // Esclude i modelli troppo costosi (> $15 per 1M token in input)
                if (promptPrice > 15) return false;
                
                // Esclude versioni obsolete, vision, roleplay o non adatte ad analisi testuale finanziaria
                if (/legacy|deprecated|vision|image|roleplay|uncensored|mythomax|nous|openchat|gemma|llama-2|gpt-3\.5|claude-2|claude-instant|pixtral|llava|gpt-oss|lyria/.test(id)) {
                    return false;
                }
                
                // Filtra la maggior parte dei modelli ":free" inaffidabili, salvaguarda Llama, Qwen, DeepSeek, Xiaomi
                if (id.endsWith(':free') && !/llama|qwen|deepseek|mistral|xiaomi/.test(id)) {
                    return false;
                }
                
                // Seleziona solo provider leader affidabili per compiti di ragionamento
                return preferredProviders.some(p => id.startsWith(p));
            });

            let mappedModels = filtered.map(m => {
                const promptPrice = parseFloat(m.pricing?.prompt || 0);
                const compPrice = parseFloat(m.pricing?.completion || 0);
                const isFree = promptPrice === 0 && compPrice === 0;
                
                // Convert to per 1M tokens
                const prompt1M = (promptPrice * 1000000).toFixed(2);
                const comp1M = (compPrice * 1000000).toFixed(2);
                
                let priceLabel = isFree ? 'Free' : `$${prompt1M} / $${comp1M}`;
                
                // Punteggio di rilevanza per ordinamento
                let score = 0;
                const id = m.id.toLowerCase();
                if (isFree) score += 20; 
                
                // Flagships / High reasoning (include GPT-5, Claude 4/5, Gemini Pro, DeepSeek R1, QwQ, MiMo)
                if (/gpt-5(?!.*mini)|gpt-4o(?!.*mini)|claude-[345]-(sonnet|opus)|gemini-[123]\.[0-9]-pro|llama-3\.[123]-70b|deepseek-chat|deepseek-r1|qwq|mimo|mistral-large|o[134]-pro/.test(id)) score += 200;
                // Fast / Good performance
                else if (/qwen-[23]|gemini-[123]\.[0-9]-flash|claude-[345]-haiku|o[134](?!.*pro)/.test(id)) score += 100;
                // Minis
                else if (/mini|flash|haiku|8b|nano/.test(id)) score += 30;
                
                // Penalizza modelli troppo vecchi
                if (/llama-3-8b|gpt-4-|claude-3-/.test(id)) score -= 20;

                return {
                    id: m.id,
                    name: m.name.replace(' (beta)', '').replace(' (free)', ''),
                    priceLabel: priceLabel,
                    isFree: isFree,
                    score: score,
                    costScore: promptPrice + compPrice
                };
            });

            // Ordina per score (desc), poi per costo (asc), poi per nome
            mappedModels.sort((a, b) => {
                if (a.score !== b.score) return b.score - a.score;
                if (a.costScore !== b.costScore) return a.costScore - b.costScore;
                return a.name.localeCompare(b.name);
            });
            
            // Prendi solo i primi 50
            _cachedOpenRouterModels = mappedModels.slice(0, 50);
            
            // Riordina i 30 selezionati in modo che i Free stiano in cima, poi ordine alfabetico (migliore UX)
            _cachedOpenRouterModels.sort((a, b) => {
                if (a.isFree && !b.isFree) return -1;
                if (!a.isFree && b.isFree) return 1;
                return a.name.localeCompare(b.name);
            });

            _openRouterModelsCachedAt = Date.now();
            logger.info(`[OpenRouter] Cached ${_cachedOpenRouterModels.length} top models for financial analysis.`);
        }
    } catch (err) {
        logger.error('[OpenRouter] Failed to fetch models for cache', err.message);
    }
}

// Fetch on startup
fetchOpenRouterModels();

function getOpenRouterModels() {
    return _cachedOpenRouterModels;
}

const GEMINI_MODEL_PREFERENCE = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
];

async function getBestGeminiModel(apiKey) {
    const now = Date.now();
    if (_cachedGeminiModel && (now - _geminiModelCachedAt) < GEMINI_MODEL_CACHE_MS) {
        return _cachedGeminiModel;
    }
    try {
        const listRes = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
        );
        const available = (listRes.data.models || [])
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));

        for (const preferred of GEMINI_MODEL_PREFERENCE) {
            if (available.includes(preferred)) {
                _cachedGeminiModel = preferred;
                _geminiModelCachedAt = now;
                console.log(`[Gemini] Selected model: ${preferred}`);
                return preferred;
            }
        }
        const anyFlash = available.find(m => m.includes('flash'));
        if (anyFlash) {
            _cachedGeminiModel = anyFlash;
            _geminiModelCachedAt = now;
            console.log(`[Gemini] Fallback model: ${anyFlash}`);
            return anyFlash;
        }
        if (available.length > 0) {
            _cachedGeminiModel = available[0];
            _geminiModelCachedAt = now;
            console.log(`[Gemini] Last-resort model: ${available[0]}`);
            return available[0];
        }
    } catch (err) {
        console.warn('[Gemini] Could not fetch model list, using static fallback:', err.message);
    }
    return 'gemini-2.5-flash';
}

function parseAIResponse(rawText) {
    let cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleanText);
    } catch (e) {
        console.warn('JSON parse failed, attempting regex extraction. Error:', e.message);
        const result = { action: 'HOLD', targetProfit: 0, stopLoss: 0, reasoning: rawText };
        
        const actionMatch = rawText.match(/"action"\s*:\s*"([^"]+)"/i);
        if (actionMatch) result.action = actionMatch[1].toUpperCase();
        
        const tpMatch = rawText.match(/"targetProfit"\s*:\s*([\d.]+)/i);
        if (tpMatch) result.targetProfit = parseFloat(tpMatch[1]);
        
        const slMatch = rawText.match(/"stopLoss"\s*:\s*([\d.]+)/i);
        if (slMatch) result.stopLoss = parseFloat(slMatch[1]);
        
        const reasoningMatch = rawText.match(/"reasoning"\s*:\s*"([\s\S]*?)"(?=\n\s*\}|\r\n\s*\}|,\s*"targetProfit"|,\s*"stopLoss"|,\s*"action"|$)/i);
        if (reasoningMatch) {
            result.reasoning = reasoningMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        } else {
            let stripped = rawText.replace(/\{[\s\S]*"reasoning"\s*:\s*"/i, '');
            stripped = stripped.replace(/"\s*\}[\s\S]*$/i, '');
            result.reasoning = stripped.trim() ? stripped : rawText;
        }
        
        return result;
    }
}

async function callAIModel(engine, prompt, keys) {
    const parts = engine.split('_');
    const baseEngine = parts[0] || 'Gemini';
    const tier = parts[1] || 'Pay';

    logger.info(`[AI Iteration] Starting analysis with engine: ${engine}`);
    logger.info(`[AI Prompt] \n${prompt}`);
    if (baseEngine === 'OR1' || baseEngine === 'OR2' || baseEngine === 'OR3') {
        const apiKey = keys.openrouterApiKey || keys.openrouterApiKeyPay || process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error(`OpenRouter API Key mancante.`);
        
        let orModel = '';
        if (baseEngine === 'OR1') orModel = keys.openrouterModel1;
        if (baseEngine === 'OR2') orModel = keys.openrouterModel2;
        if (baseEngine === 'OR3') orModel = keys.openrouterModel3;
        
        if (!orModel) throw new Error(`Nessun modello configurato per ${baseEngine}. Selezionalo nei Settings dell'amministratore.`);
        
        let res;
        try {
            res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: orModel,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1
            }, {
                headers: { 
                    'Authorization': `Bearer ${apiKey}`, 
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/celtix72/foliotrack', 
                    'X-Title': 'FolioTrack'
                }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (OpenRouter)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {}, modelUsed: orModel };
    } else {
        const apiKey = keys.geminiApiKeyFree || keys.geminiApiKeyPay || keys.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error(`Gemini API Key mancante.`);
        const geminiModel = await getBestGeminiModel(apiKey);
        let res;
        try {
            res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                { 
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1 }
                },
                { headers: { 'Content-Type': 'application/json' } }
            );
        } catch (apiErr) {
            logger.error('[AI API Error (Gemini)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        logger.info(`[AI Response (${engine})] \n${content}`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 }, modelUsed: geminiModel };
    }
}

module.exports = {
    getBestGeminiModel,
    fetchOpenRouterModels,
    getOpenRouterModels,
    parseAIResponse,
    callAIModel
};
