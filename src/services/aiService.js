const axios = require('axios');
const { aiLogger } = require('../utils/logger');

let _cachedGeminiModel = null;
let _geminiModelCachedAt = 0;
const GEMINI_MODEL_CACHE_MS = 60 * 60 * 1000; // 1 hour

// Modelli statici di fallback — aggiornati agosto 2026
// Questi vengono usati se la fetch da OpenRouter API fallisce
let _cachedOpenRouterModels = [
    // --- FREE ---
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek: R1 Reasoning', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Google: Gemini 2.0 Flash', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'qwen/qwq-32b:free', name: 'Qwen: QwQ 32B', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct:free', name: 'NVIDIA: Llama 3.1 Nemotron 70B', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'meta-llama/llama-3.1-405b-instruct:free', name: 'Meta: Llama 3.1 405B Instruct', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen: 2.5 72B Instruct', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'mistralai/mistral-small-24b-instruct-2501:free', name: 'Mistral: Small 24B', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'nvidia/nemotron-4-340b-instruct:free', name: 'NVIDIA: Nemotron 4 340B', priceLabel: 'Free', isFree: true, recommended: false },
    // --- PAY ---
    { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet', priceLabel: '$3.00 / $15.00', isFree: false, recommended: true },
    { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', priceLabel: '$2.50 / $10.00', isFree: false, recommended: true },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1', priceLabel: '$0.55 / $2.19', isFree: false, recommended: true },
    { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o Mini', priceLabel: '$0.15 / $0.60', isFree: false, recommended: false },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', priceLabel: '$1.25 / $5.00', isFree: false, recommended: false },
    { id: 'anthropic/claude-3-haiku', name: 'Anthropic: Claude 3 Haiku', priceLabel: '$0.25 / $1.25', isFree: false, recommended: false },
];
let _openRouterModelsCachedAt = 0;

async function fetchOpenRouterModels() {
    try {
        const res = await axios.get('https://openrouter.ai/api/v1/models');
        if (res.data && res.data.data) {
            
            const preferredProviders = ['openai/', 'anthropic/', 'google/', 'meta-llama/', 'mistralai/', 'deepseek/', 'qwen/', 'xiaomi/', 'nvidia/', 'cohere/', 'liquid/'];
            
            let filtered = res.data.data.filter(m => {
                const id = m.id.toLowerCase();
                const promptPrice = parseFloat(m.pricing?.prompt || 0) * 1000000;
                
                // Esclude i modelli troppo costosi (> $15 per 1M token in input)
                if (promptPrice > 15) return false;
                
                // Esclude versioni obsolete, vision, roleplay o non adatte ad analisi testuale finanziaria
                if (/legacy|deprecated|vision|image|roleplay|uncensored|mythomax|nous|openchat|llama-2|gpt-3\.5|claude-2|claude-instant|pixtral|llava|lyria/.test(id)) {
                    return false;
                }
                
                // Filtra la maggior parte dei modelli ":free" inaffidabili, salvaguarda Llama, Qwen, DeepSeek, Xiaomi, NVIDIA, Nemotron, Mistral, Gemma
                if (id.endsWith(':free') && !/llama|qwen|deepseek|mistral|xiaomi|nvidia|nemotron|gemma/.test(id)) {
                    return false;
                }
                
                // Seleziona solo provider leader affidabili per compiti di ragionamento
                return preferredProviders.some(p => id.startsWith(p));
            });

            let mappedModels = filtered.map(m => {
                const promptPrice = parseFloat(m.pricing?.prompt || 0);
                const compPrice = parseFloat(m.pricing?.completion || 0);
                const isFree = (promptPrice === 0 && compPrice === 0) || m.id.endsWith(':free');
                
                // Convert to per 1M tokens
                const prompt1M = (promptPrice * 1000000).toFixed(2);
                const comp1M = (compPrice * 1000000).toFixed(2);
                
                let priceLabel = isFree ? 'Free' : `$${prompt1M} / $${comp1M}`;
                
                // Punteggio di rilevanza per ordinamento
                let score = 0;
                const id = m.id.toLowerCase();
                if (isFree) score += 50; 
                
                // Flagships / High reasoning (include NVIDIA Nemotron, GPT-5, Claude 4/5, Gemini Pro, DeepSeek R1, QwQ, MiMo)
                if (/nvidia|nemotron|gpt-5(?!.*mini)|gpt-4o(?!.*mini)|claude-[345]-(sonnet|opus)|gemini-[123]\.[0-9]-pro|llama-3\.[1234]-(70b|405b)|deepseek-chat|deepseek-r1|qwq|mimo|mistral-large|o[134]-pro/.test(id)) score += 200;
                // Fast / Good performance
                else if (/qwen-?[23]|qwen3\.7|gemini-[123]\.[0-9]-flash|claude-[345]-haiku|o[134](?!.*pro)|llama-3\.[123]/.test(id)) score += 100;
                // Minis
                else if (/mini|flash|haiku|8b|nano/.test(id)) score += 30;
                
                // Penalizza modelli troppo vecchi
                if (/llama-3-8b(?!.*3\.[123])|gpt-4-0|claude-3-haiku/.test(id)) score -= 20;

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
            
            // Prendi i primi 80
            _cachedOpenRouterModels = mappedModels.slice(0, 80);
            
            // Riordina i selezionati in modo che i Free stiano in cima, poi ordine alfabetico (migliore UX)
            _cachedOpenRouterModels.sort((a, b) => {
                if (a.isFree && !b.isFree) return -1;
                if (!a.isFree && b.isFree) return 1;
                return a.name.localeCompare(b.name);
            });

            _openRouterModelsCachedAt = Date.now();
            aiLogger.info(`[OpenRouter] Cached ${_cachedOpenRouterModels.length} top models for financial analysis (including NVIDIA free models).`);
        }
    } catch (err) {
        aiLogger.error('[OpenRouter] Failed to fetch models for cache', err.message);
    }
}

// Fetch on startup
fetchOpenRouterModels();

function getOpenRouterModels() {
    const now = Date.now();
    if (_cachedOpenRouterModels.length === 0 || (now - _openRouterModelsCachedAt) > 60 * 60 * 1000) {
        fetchOpenRouterModels().catch(err => aiLogger.error('[OpenRouter] On-demand fetch failed', err.message));
    }
    return _cachedOpenRouterModels;
}

let _cachedRequestyModels = [];
let _requestyModelsCachedAt = 0;

async function fetchRequestyModels() {
    try {
        const res = await axios.get('https://router.requesty.ai/v1/models');
        if (res.data && res.data.data) {
            let filtered = res.data.data.filter(m => {
                const id = m.id.toLowerCase();
                const promptPrice = parseFloat(m.input_price || 0) * 1000000;
                if (promptPrice > 15) return false;
                if (id.includes('@')) return false; // Filtra duplicati specifici per regione/zona
                if (/legacy|deprecated|vision|image|roleplay|uncensored|mythomax|nous|openchat|gemma|llama-2|gpt-3\.5|claude-2|claude-instant|pixtral|llava|lyria/.test(id)) {
                    return false;
                }
                return true;
            });

            let mappedModels = filtered.map(m => {
                const promptPrice = parseFloat(m.input_price || 0);
                const compPrice = parseFloat(m.output_price || 0);
                const isFree = promptPrice === 0 && compPrice === 0;
                const prompt1M = (promptPrice * 1000000).toFixed(2);
                const comp1M = (compPrice * 1000000).toFixed(2);
                let priceLabel = isFree ? 'Free' : `$${prompt1M} / $${comp1M}`;
                
                let score = 0;
                const id = m.id.toLowerCase();
                if (isFree) score += 20; 
                if (/gpt-5|gpt-4o(?!.*mini)|claude-[345]-(sonnet|opus)|gemini-[123]\.[0-9]-pro|llama-3\.[123]-70b|deepseek-chat|deepseek-r1|qwq|mimo|mistral-large|o[134]-pro|deepseek-v4-pro/.test(id)) score += 200;
                else if (/qwen-?[23]|qwen3\.7|gemini-[123]\.[0-9]-flash|claude-[345]-haiku|o[134](?!.*pro)|deepseek-v4-flash/.test(id)) score += 100;
                else if (/mini|flash|haiku|8b|nano/.test(id)) score += 30;

                return {
                    id: m.id,
                    name: m.id,
                    priceLabel: priceLabel,
                    isFree: isFree,
                    score: score,
                    costScore: promptPrice + compPrice
                };
            });

            mappedModels.sort((a, b) => {
                if (a.score !== b.score) return b.score - a.score;
                if (a.costScore !== b.costScore) return a.costScore - b.costScore;
                return a.name.localeCompare(b.name);
            });
            
            _cachedRequestyModels = mappedModels.slice(0, 300);
            _cachedRequestyModels.sort((a, b) => {
                if (a.isFree && !b.isFree) return -1;
                if (!a.isFree && b.isFree) return 1;
                return a.name.localeCompare(b.name);
            });

            _requestyModelsCachedAt = Date.now();
            aiLogger.info(`[Requesty] Cached ${_cachedRequestyModels.length} top models for financial analysis.`);
        }
    } catch (err) {
        aiLogger.error('[Requesty] Failed to fetch models for cache', err.message);
    }
}

fetchRequestyModels();

function getRequestyModels() {
    const now = Date.now();
    if (_cachedRequestyModels.length === 0 || (now - _requestyModelsCachedAt) > 60 * 60 * 1000) {
        fetchRequestyModels().catch(err => aiLogger.error('[Requesty] On-demand fetch failed', err.message));
    }
    return _cachedRequestyModels;
}
const DEFAULT_GEMINI_MODEL_PREFERENCE = [
    'gemini-3.6-flash',
    'gemini-3.6-pro',
    'gemini-3.6-flash-preview',
    'gemini-3.5-flash',
    'gemini-3.5-pro',
    'gemini-3.1-flash-lite',
    'gemini-3.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
];

function getGeminiModelPreference() {
    try {
        const database = require('../db');
        const settings = database.getSettings(1);
        if (settings.geminiModelPreferences) {
            const parsed = JSON.parse(settings.geminiModelPreferences);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {
        aiLogger.error('[Gemini] Failed to parse geminiModelPreferences', e);
    }
    return DEFAULT_GEMINI_MODEL_PREFERENCE;
}

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

        const prefs = getGeminiModelPreference();
        for (const preferred of prefs) {
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

async function checkNewGeminiModels() {
    try {
        const database = require('../db');
        const { notifyUser } = require('./notificationService');
        const settings = database.getSettings(1);
        const apiKey = settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) return;

        const listRes = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
        );
        const available = (listRes.data.models || [])
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));

        const currentPrefs = getGeminiModelPreference();
        
        // Find Gemini models that are NOT in current preferences but seem to be new text/chat models
        const newModels = available.filter(m => 
            m.startsWith('gemini-') && 
            !currentPrefs.includes(m) && 
            !m.includes('vision') && 
            !m.includes('embedding')
        );

        if (newModels.length > 0) {
            aiLogger.info(`[Gemini] Found ${newModels.length} new models not in preferences:`, newModels);
            
            const title = "Nuovi modelli Gemini disponibili";
            const message = `Trovati nuovi modelli Gemini gratuiti:\n${newModels.join(', ')}\nVai nelle Impostazioni AI per aggiungerli alla selezione.`;
            
            // Check if we already notified recently to avoid spam (can check if there's an exact notification in DB)
            const existing = database.db.prepare(`
                SELECT id FROM notifications 
                WHERE user_id = 1 AND title = ? AND message = ? 
                ORDER BY date DESC LIMIT 1
            `).get(title, message);

            if (!existing) {
                notifyUser(1, 'STATUS', {
                    title,
                    body: message
                });
            }
        }
    } catch (err) {
        aiLogger.error('[Gemini] Failed to check for new models:', err.message);
    }
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

    aiLogger.info(`[AI Iteration] Starting analysis with engine: ${engine}`);
    aiLogger.info(`[AI Prompt] \n${prompt}`);
    if (baseEngine === 'OR1' || baseEngine === 'OR2' || baseEngine === 'OR3' || baseEngine === 'OR4' || baseEngine === 'OR5') {
        const apiKey = keys.openrouterApiKey || keys.openrouterApiKeyPay || process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error(`OpenRouter API Key mancante.`);
        
        let orModel = '';
        if (baseEngine === 'OR1') orModel = keys.openrouterModel1;
        if (baseEngine === 'OR2') orModel = keys.openrouterModel2;
        if (baseEngine === 'OR3') orModel = keys.openrouterModel3;
        if (baseEngine === 'OR4') orModel = keys.openrouterModel4;
        if (baseEngine === 'OR5') orModel = keys.openrouterModel5;
        
        if (!orModel) throw new Error(`Nessun modello configurato per ${baseEngine}. Selezionalo nei Settings dell'amministratore.`);
        
        let res;
        let attempt = 0;
        let maxAttempts = 3;
        while (attempt < maxAttempts) {
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
                    },
                    timeout: 180000
                });
                break; // success
            } catch (apiErr) {
                attempt++;
                const errMsg = apiErr.response ? JSON.stringify(apiErr.response.data) : apiErr.message;
                aiLogger.warn(`[AI API Error (OpenRouter)] Attempt ${attempt}/${maxAttempts} failed: ${errMsg}`);
                if (attempt >= maxAttempts) {
                    aiLogger.error('[AI API Error (OpenRouter)] Max attempts reached.');
                    throw apiErr;
                }
                // Wait before retrying (exponential backoff: 2s, 4s...)
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        aiLogger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {}, modelUsed: orModel };
    } else if (baseEngine === 'REQ1' || baseEngine === 'REQ2' || baseEngine === 'REQ3' || baseEngine === 'REQ4' || baseEngine === 'REQ5') {
        const apiKey = keys.requestyApiKey || keys.requestyApiKeyPay || keys.requestyApiKeyFree || process.env.REQUESTY_API_KEY;
        if (!apiKey) throw new Error(`Requesty API Key mancante.`);
        
        let reqModel = '';
        if (baseEngine === 'REQ1') reqModel = keys.requestyModel1;
        if (baseEngine === 'REQ2') reqModel = keys.requestyModel2;
        if (baseEngine === 'REQ3') reqModel = keys.requestyModel3;
        if (baseEngine === 'REQ4') reqModel = keys.requestyModel4;
        if (baseEngine === 'REQ5') reqModel = keys.requestyModel5;
        
        if (!reqModel) throw new Error(`Nessun modello configurato per ${baseEngine}. Selezionalo nei Settings dell'amministratore.`);
        
        let res;
        let attempt = 0;
        let maxAttempts = 3;
        while (attempt < maxAttempts) {
            try {
                res = await axios.post('https://router.requesty.ai/v1/chat/completions', {
                    model: reqModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1
                }, {
                    headers: { 
                        'Authorization': `Bearer ${apiKey}`, 
                        'Content-Type': 'application/json'
                    },
                    timeout: 180000
                });
                break; // success
            } catch (apiErr) {
                attempt++;
                const errMsg = apiErr.response ? JSON.stringify(apiErr.response.data) : apiErr.message;
                aiLogger.warn(`[AI API Error (Requesty)] Attempt ${attempt}/${maxAttempts} failed: ${errMsg}`);
                if (attempt >= maxAttempts) {
                    aiLogger.error('[AI API Error (Requesty)] Max attempts reached.');
                    throw apiErr;
                }
                // Wait before retrying (exponential backoff: 2s, 4s...)
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        aiLogger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {}, modelUsed: reqModel };
    } else if (baseEngine === 'Aimlapi') {
        const apiKey = keys.aimlapiApiKeyFree || keys.aimlapiApiKeyPay || keys.aimlapiApiKey || process.env.AIMLAPI_API_KEY;
        if (!apiKey) throw new Error(`AIML API Key mancante nelle impostazioni.`);
        let res;
        let attempt = 0;
        let maxAttempts = 3;
        while (attempt < maxAttempts) {
            try {
                res = await axios.post('https://api.aimlapi.com/v1/chat/completions', {
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1
                }, {
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    timeout: 180000
                });
                break;
            } catch (apiErr) {
                attempt++;
                const errMsg = apiErr.response ? JSON.stringify(apiErr.response.data) : apiErr.message;
                aiLogger.warn(`[AI API Error (Aimlapi)] Attempt ${attempt}/${maxAttempts} failed: ${errMsg}`);
                if (attempt >= maxAttempts) {
                    aiLogger.error('[AI API Error (Aimlapi)] Max attempts reached.');
                    throw apiErr;
                }
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        aiLogger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {}, modelUsed: 'gpt-4o' };
    } else {
        const apiKey = keys.geminiApiKeyFree || keys.geminiApiKeyPay || keys.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            // Check fallback keys if Gemini is missing
            if (keys.aimlapiApiKeyFree || keys.aimlapiApiKeyPay || keys.aimlapiApiKey) {
                aiLogger.info('[AI Fallback] Gemini key missing, falling back to Aimlapi');
                return callAIModel('Aimlapi_Free', prompt, keys);
            }
            if (keys.openrouterApiKey || keys.openrouterApiKeyPay) {
                aiLogger.info('[AI Fallback] Gemini key missing, falling back to OpenRouter (OR1)');
                return callAIModel('OR1', prompt, keys);
            }
            if (keys.requestyApiKey || keys.requestyApiKeyPay) {
                aiLogger.info('[AI Fallback] Gemini key missing, falling back to Requesty (REQ1)');
                return callAIModel('REQ1', prompt, keys);
            }
            throw new Error(`Gemini API Key mancante e nessuna altra chiave IA trovata nelle impostazioni.`);
        }
        const geminiModel = await getBestGeminiModel(apiKey);
        let res;
        let attempt = 0;
        let maxAttempts = 3;
        while (attempt < maxAttempts) {
            try {
                res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                    { 
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.1 }
                    },
                    { 
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 180000
                    }
                );
                break;
            } catch (apiErr) {
                attempt++;
                const errMsg = apiErr.response ? JSON.stringify(apiErr.response.data) : apiErr.message;
                aiLogger.warn(`[AI API Error (Gemini)] Attempt ${attempt}/${maxAttempts} failed: ${errMsg}`);
                if (attempt >= maxAttempts) {
                    aiLogger.error('[AI API Error (Gemini)] Max attempts reached.');
                    throw apiErr;
                }
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        aiLogger.info(`[AI Response (${engine})] \n${content}`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 }, modelUsed: geminiModel };
    }
}

// Modelli Requesty consigliati (statici)
const RECOMMENDED_REQUESTY_FREE = [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek: V3 Chat', priceLabel: 'Best Value', isFree: true, recommended: true },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1 Reasoning', priceLabel: 'Best Value', isFree: true, recommended: true },
    { id: 'qwen/qwq-32b', name: 'Qwen: QwQ 32B', priceLabel: 'Best Value', isFree: true, recommended: true },
];
const RECOMMENDED_REQUESTY_PAY = [
    { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Anthropic: Claude 3.5 Sonnet', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'openai/gpt-4o-2024-11-20', name: 'OpenAI: GPT-4o (Nov 2024)', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
];

// Modelli Gemini consigliati (statici)
const RECOMMENDED_GEMINI_FREE = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', priceLabel: 'Free', isFree: true, recommended: true },
];
const RECOMMENDED_GEMINI_PAY = [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (avanzato)', priceLabel: 'Pay', isFree: false, recommended: true },
];

/**
 * Restituisce i modelli consigliati (top 3 free + top 3 pay) per ogni provider.
 * Usato dall'endpoint /api/admin/recommended-models
 */
function getRecommendedModels() {
    // OpenRouter: prendi i primi 3 free e 3 pay dalla cache (o dal fallback statico)
    const orModels = _cachedOpenRouterModels;
    const orFree = orModels.filter(m => m.isFree && m.recommended).slice(0, 3);
    const orPay = orModels.filter(m => !m.isFree && m.recommended).slice(0, 3);

    // Requesty: statici aggiornati
    const reqFree = RECOMMENDED_REQUESTY_FREE;
    const reqPay = RECOMMENDED_REQUESTY_PAY;

    // Gemini: statici
    const gemFree = RECOMMENDED_GEMINI_FREE;
    const gemPay = RECOMMENDED_GEMINI_PAY;

    return {
        openrouter: { free: orFree, pay: orPay },
        requesty: { free: reqFree, pay: reqPay },
        gemini: { free: gemFree, pay: gemPay }
    };
}

module.exports = {
    getBestGeminiModel,
    fetchOpenRouterModels,
    getOpenRouterModels,
    fetchRequestyModels,
    getRequestyModels,
    getGeminiModelPreference,
    getRecommendedModels,
    checkNewGeminiModels,
    parseAIResponse,
    callAIModel
};
