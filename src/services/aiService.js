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
            _cachedOpenRouterModels = res.data.data.map(m => {
                const promptPrice = parseFloat(m.pricing?.prompt || 0);
                const compPrice = parseFloat(m.pricing?.completion || 0);
                const isFree = promptPrice === 0 && compPrice === 0;
                
                // Convert to per 1M tokens
                const prompt1M = (promptPrice * 1000000).toFixed(2);
                const comp1M = (compPrice * 1000000).toFixed(2);
                
                let priceLabel = isFree ? 'Free' : `$${prompt1M} / $${comp1M}`;
                
                return {
                    id: m.id,
                    name: m.name,
                    priceLabel: priceLabel,
                    isFree: isFree
                };
            });
            // Sort: free first, then by name
            _cachedOpenRouterModels.sort((a, b) => {
                if (a.isFree && !b.isFree) return -1;
                if (!a.isFree && b.isFree) return 1;
                return a.name.localeCompare(b.name);
            });
            _openRouterModelsCachedAt = Date.now();
            logger.info(`[OpenRouter] Cached ${_cachedOpenRouterModels.length} models.`);
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
    if (baseEngine === 'Qwen') {
        const apiKey = tier === 'Free' ? keys.qwenApiKeyFree : (keys.qwenApiKeyPay || keys.qwenApiKey || process.env.QWEN_API_KEY);
        if (!apiKey) throw new Error(`Qwen API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
                model: 'qwen-plus',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Qwen)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'OpenAI') {
        const apiKey = tier === 'Free' ? keys.openaiApiKeyFree : (keys.openaiApiKeyPay || keys.openaiApiKey || process.env.OPENAI_API_KEY);
        if (!apiKey) throw new Error(`OpenAI API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (OpenAI)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'Agnes') {
        const apiKey = tier === 'Free' ? keys.agnesApiKeyFree : (keys.agnesApiKeyPay || keys.agnesApiKey || process.env.AGNES_API_KEY);
        if (!apiKey) throw new Error(`Agnes API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://apihub.agnes-ai.com/v1/chat/completions', {
                model: 'agnes-2.0-flash',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Agnes)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'Aimlapi') {
        const apiKey = tier === 'Free' ? keys.aimlapiApiKeyFree : (keys.aimlapiApiKeyPay || keys.aimlapiApiKey || process.env.AIMLAPI_API_KEY);
        if (!apiKey) throw new Error(`AIML API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://api.aimlapi.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Aimlapi)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'OpenRouter') {
        const apiKey = tier === 'Free' ? keys.openrouterApiKeyFree : (keys.openrouterApiKeyPay || process.env.OPENROUTER_API_KEY);
        if (!apiKey) throw new Error(`OpenRouter API Key (${tier}) mancante.`);
        
        const defaultFreeModel = 'meta-llama/llama-3.2-3b-instruct:free';
        const defaultPayModel = 'google/gemini-1.5-flash';
        const orModel = tier === 'Free' ? (keys.openrouterModelFree || defaultFreeModel) : (keys.openrouterModelPay || defaultPayModel);
        
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
        return { text: content, usage: res.data.usage || {} };
    } else {
        const apiKey = tier === 'Free' ? keys.geminiApiKeyFree : (keys.geminiApiKeyPay || keys.geminiApiKey || process.env.GEMINI_API_KEY);
        if (!apiKey) throw new Error(`Gemini API Key (${tier}) mancante.`);
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
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };
    }
}

module.exports = {
    getBestGeminiModel,
    fetchOpenRouterModels,
    getOpenRouterModels,
    parseAIResponse,
    callAIModel
};
