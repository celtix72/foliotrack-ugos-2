const axios = require('axios');
const { aiLogger } = require('../utils/logger');

let _cachedGeminiModel = null;
let _geminiModelCachedAt = 0;
const GEMINI_MODEL_CACHE_MS = 60 * 60 * 1000; // 1 hour

// Cache per la lista completa dei modelli Gemini disponibili (per la UI admin)
let _cachedGeminiModels = [];
let _geminiModelsCachedAt = 0;
const GEMINI_MODELS_CACHE_MS = 60 * 60 * 1000; // 1 hour

// Modelli statici di fallback — aggiornati agosto 2026
// Questi vengono usati se la fetch da OpenRouter API fallisce
let _cachedOpenRouterModels = [
    // --- TOP 4 RECOMMENDED FREE ---
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Google: Gemini 2.0 Flash', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek: R1 Reasoning', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'qwen/qwq-32b:free', name: 'Qwen: QwQ 32B Reasoning', priceLabel: 'Free', isFree: true, recommended: true },
    // --- OTHER FREE ---
    { id: 'google/gemini-3.8-flash:free', name: 'Google: Gemini 3.8 Flash', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'google/gemini-2.8-flash:free', name: 'Google: Gemini 2.8 Flash', priceLabel: 'Free', isFree: true, recommended: false },
    { id: 'google/gemini-2.7-flash:free', name: 'Google: Gemini 2.7 Flash', priceLabel: 'Free', isFree: true, recommended: false },
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
        let apiKey = process.env.REQUESTY_API_KEY || '';
        try {
            const db = require('../db');
            if (db && db.getSettings) {
                const settings = db.getSettings(1) || {};
                apiKey = settings.requestyApiKey || settings.requestyApiKeyPay || settings.requestyApiKeyFree || apiKey;
            }
        } catch(e) {}
        
        const config = {};
        if (apiKey) {
            config.headers = { 'Authorization': `Bearer ${apiKey}` };
        }
        
        const res = await axios.get('https://router.requesty.ai/v1/models', config);
        if (res.data && res.data.data) {
            // Check if Requesty injects an approval/routed flag when auth is provided
            const hasApprovalFlags = res.data.data.some(m => m.approved === true || m.is_approved === true || m.status === 'approved' || m.routed === true);

            let filtered = res.data.data.filter(m => {
                const id = m.id.toLowerCase();
                
                // If the user has configured an Approved Models list in Requesty, strictly adhere to it
                if (hasApprovalFlags) {
                    if (!(m.approved === true || m.is_approved === true || m.status === 'approved' || m.routed === true)) return false;
                }

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
    'gemini-3.8-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.8-flash',
    'gemini-2.7-flash',
];

/**
 * Fallback statico: modelli Gemini free — usato se l'API non è raggiungibile
 */
const STATIC_GEMINI_FREE_MODELS = [
    { id: 'gemini-3.8-flash',      name: 'Gemini 3.8 Flash',       isFree: true },
    { id: 'gemini-2.0-flash',      name: 'Gemini 2.0 Flash',       isFree: true },
    { id: 'gemini-1.5-flash',      name: 'Gemini 1.5 Flash',       isFree: true },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite',  isFree: true },
    { id: 'gemini-1.5-pro',        name: 'Gemini 1.5 Pro',         isFree: false },
    { id: 'gemini-2.5-flash',      name: 'Gemini 2.5 Flash',       isFree: true },
    { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',         isFree: false },
    { id: 'gemini-2.8-flash',      name: 'Gemini 2.8 Flash',       isFree: true },
    { id: 'gemini-2.7-flash',      name: 'Gemini 2.7 Flash',       isFree: true },
];

/**
 * Fetch + caching dei modelli Gemini disponibili dall'API.
 * Richiede la API key (free o pay). Popola _cachedGeminiModels.
 */
async function fetchGeminiModels(apiKey) {
    if (!apiKey) return;
    try {
        const listRes = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
        );
        const raw = (listRes.data.models || []);
        const generateModels = raw.filter(m =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent') &&
            m.name.includes('gemini-') &&
            !m.name.includes('vision') &&
            !m.name.includes('embedding') &&
            !m.name.includes('aqa')
        );

        // Converti in oggetti { id, name, isFree }
        // I modelli Gemini free non hanno costi espliciti nel listModels,
        // ma quelli con 'flash' o 'lite' nel nome sono tipicamente in tier free.
        // Usiamo la lista preferenze per capire se sono "conosciuti come free".
        const knownFreePatterns = /flash|lite/i;
        const mapped = generateModels.map(m => {
            const id = m.name.replace('models/', '');
            const displayName = m.displayName || id;
            const isFree = knownFreePatterns.test(id);
            return { id, name: displayName, isFree };
        });

        // Ordina: prima i flash/lite (free), poi per versione decrescente
        mapped.sort((a, b) => {
            if (a.isFree && !b.isFree) return -1;
            if (!a.isFree && b.isFree) return 1;
            // Estrai il numero versione per ordinamento decrescente
            const verA = parseFloat(a.id.match(/gemini-([\d.]+)/)?.[1] || '0');
            const verB = parseFloat(b.id.match(/gemini-([\d.]+)/)?.[1] || '0');
            if (verB !== verA) return verB - verA;
            return a.id.localeCompare(b.id);
        });

        _cachedGeminiModels = mapped;
        _geminiModelsCachedAt = Date.now();
        aiLogger.info(`[Gemini] Cached ${mapped.length} models from API (${mapped.filter(m => m.isFree).length} free).`);
    } catch (err) {
        aiLogger.warn('[Gemini] Failed to fetch model list for admin cache:', err.message);
        // Mantieni il fallback statico
        if (_cachedGeminiModels.length === 0) {
            _cachedGeminiModels = STATIC_GEMINI_FREE_MODELS;
        }
    }
}

/**
 * Restituisce la lista dei modelli Gemini (per la UI admin).
 * Se non ancora in cache, tenta il fetch; altrimenti usa il fallback statico.
 */
function getGeminiModels() {
    const now = Date.now();
    if (_cachedGeminiModels.length === 0 || (now - _geminiModelsCachedAt) > GEMINI_MODELS_CACHE_MS) {
        // Tenta fetch in background con la chiave salvata
        try {
            const database = require('../db');
            const settings = database.getSettings(1);
            const apiKey = settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY;
            if (apiKey) {
                fetchGeminiModels(apiKey).catch(e => aiLogger.warn('[Gemini] Background model fetch failed:', e.message));
            }
        } catch (e) { /* ignore */ }
        // Ritorna il fallback statico se la cache è vuota
        if (_cachedGeminiModels.length === 0) return STATIC_GEMINI_FREE_MODELS;
    }
    return _cachedGeminiModels;
}

function getGeminiModelPreference() {
    try {
        const database = require('../db');
        const settings = database.getSettings(1);
        // Nuovi campi individuali (geminiModel1/2/3) — priorità massima
        const slots = [settings.geminiModel1, settings.geminiModel2, settings.geminiModel3].filter(Boolean);
        if (slots.length > 0) return slots;
        // Retrocompatibilità: vecchio JSON array
        if (settings.geminiModelPreferences) {
            const parsed = JSON.parse(settings.geminiModelPreferences);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {
        aiLogger.error('[Gemini] Failed to parse geminiModelPreferences', e);
    }
    return DEFAULT_GEMINI_MODEL_PREFERENCE;
}

async function getGeminiCandidateModels(apiKey) {
    const candidates = [];
    const prefs = getGeminiModelPreference();
    for (const p of prefs) {
        if (p && !candidates.includes(p)) candidates.push(p);
    }

    const defaultFallbacks = [
        'gemini-3.8-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-2.8-flash',
        'gemini-2.7-flash',
        'gemini-2.5-flash',
        'gemini-2.8-pro',
        'gemini-2.7-pro',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash-lite',
        'gemini-2.5-pro',
        'gemini-1.5-pro'
    ];
    for (const d of defaultFallbacks) {
        if (!candidates.includes(d)) candidates.push(d);
    }

    if (apiKey) {
        try {
            const listRes = await axios.get(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`,
                { timeout: 8000 }
            );
            const available = (listRes.data.models || [])
                .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                .map(m => m.name.replace('models/', ''));

            if (available.length > 0) {
                const validCandidates = candidates.filter(c => available.includes(c));
                for (const a of available) {
                    if ((a.includes('flash') || a.includes('lite') || a.includes('pro')) && !validCandidates.includes(a)) {
                        validCandidates.push(a);
                    }
                }
                if (validCandidates.length > 0) return validCandidates;
            }
        } catch (e) {
            // In caso di errore di rete temporaneo per la lista, procedi con i candidati
        }
    }
    return candidates;
}

async function getBestGeminiModel(apiKey) {
    const now = Date.now();
    if (_cachedGeminiModel && (now - _geminiModelCachedAt) < GEMINI_MODEL_CACHE_MS) {
        return _cachedGeminiModel;
    }
    const candidates = await getGeminiCandidateModels(apiKey);
    _cachedGeminiModel = candidates[0] || 'gemini-2.5-flash';
    _geminiModelCachedAt = now;
    return _cachedGeminiModel;
}

// Baseline modelli noti per evitare falsi allarmi alla prima esecuzione del check
const BASELINE_KNOWN_MODELS = [
    'gemini-3.8-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.8-flash',
    'gemini-2.7-flash',
    'gemini-2.0-pro-exp-02-05',
    'gemini-2.0-flash-thinking-exp-01-21',
    'google/gemini-3.8-flash:free',
    'google/gemini-2.0-flash-exp:free',
    'google/gemini-2.8-flash:free',
    'google/gemini-2.7-flash:free',
    'deepseek/deepseek-r1:free',
    'deepseek/deepseek-chat:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'meta-llama/llama-3.1-405b-instruct:free',
    'meta-llama/llama-3.1-70b-instruct:free',
    'meta-llama/llama-3.1-8b-instruct:free',
    'qwen/qwq-32b:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'nvidia/llama-3.1-nemotron-70b-instruct:free',
    'nvidia/nemotron-4-340b-instruct:free',
    'mistralai/mistral-small-24b-instruct-2501:free'
];

/**
 * Check periodico automatico per nuovi modelli gratuiti (Google Gemini & OpenRouter).
 * Rileva nuovi modelli, aggiorna la cache e notifica l'amministratore.
 */
async function checkNewAIModels() {
    try {
        const database = require('../db');
        const { notifyUser } = require('./notificationService');
        const settings = database.getSettings(1) || {};
        
        let knownModels = [];
        let isFirstRun = false;
        if (settings.knownAiModels) {
            try {
                knownModels = JSON.parse(settings.knownAiModels);
            } catch (e) {
                knownModels = [];
            }
        }
        if (!Array.isArray(knownModels) || knownModels.length === 0) {
            knownModels = [...BASELINE_KNOWN_MODELS];
            isFirstRun = true;
        }

        const newlyDiscovered = {
            gemini: [],
            openrouter: []
        };

        // 1. CHECK GOOGLE GEMINI
        const geminiKey = settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY;
        if (geminiKey) {
            try {
                const listRes = await axios.get(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}&pageSize=100`,
                    { timeout: 10000 }
                );
                const available = (listRes.data.models || [])
                    .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                    .map(m => m.name.replace('models/', ''));

                for (const m of available) {
                    if (m.startsWith('gemini-') && !m.includes('vision') && !m.includes('embedding') && !m.includes('aqa')) {
                        if (!knownModels.includes(m)) {
                            newlyDiscovered.gemini.push(m);
                            knownModels.push(m);
                        }
                    }
                }
            } catch (err) {
                aiLogger.warn('[Check AI Models] Errore check Gemini:', err.message);
            }
        }

        // 2. CHECK OPENROUTER FREE MODELS
        try {
            const orRes = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 15000 });
            if (orRes.data && Array.isArray(orRes.data.data)) {
                const preferredProviders = ['openai/', 'anthropic/', 'google/', 'meta-llama/', 'mistralai/', 'deepseek/', 'qwen/', 'xiaomi/', 'nvidia/'];
                
                for (const m of orRes.data.data) {
                    const id = m.id.toLowerCase();
                    const promptPrice = parseFloat(m.pricing?.prompt || 0);
                    const compPrice = parseFloat(m.pricing?.completion || 0);
                    const isFree = (promptPrice === 0 && compPrice === 0) || id.endsWith(':free');

                    if (!isFree) continue;
                    if (/legacy|deprecated|vision|image|roleplay|uncensored|mythomax|nous|openchat|llama-2|gpt-3\.5|claude-2|pixtral|llava|lyria/.test(id)) continue;
                    if (!preferredProviders.some(p => id.startsWith(p))) continue;

                    if (!knownModels.includes(m.id)) {
                        newlyDiscovered.openrouter.push(m.id);
                        knownModels.push(m.id);
                    }
                }
            }
        } catch (err) {
            aiLogger.warn('[Check AI Models] Errore check OpenRouter:', err.message);
        }

        // Se è la prima esecuzione (baseline non salvata), salva lo stato iniziale senza spam
        if (isFirstRun) {
            database.setSetting(1, 'knownAiModels', JSON.stringify(knownModels));
            aiLogger.info(`[Check AI Models] Inizializzato baseline di ${knownModels.length} modelli IA noti.`);
            return [];
        }

        const totalNew = [...newlyDiscovered.gemini, ...newlyDiscovered.openrouter];

        if (totalNew.length > 0) {
            database.setSetting(1, 'knownAiModels', JSON.stringify(knownModels));

            // Ricarica le cache dei modelli
            fetchOpenRouterModels().catch(() => {});
            if (geminiKey) fetchGeminiModels(geminiKey).catch(() => {});

            aiLogger.info(`[Check AI Models] Rilevati ${totalNew.length} nuovi modelli:`, newlyDiscovered);

            const title = "🤖 Nuovi Modelli IA Rilevati";
            let body = "Nuovi modelli IA gratuiti disponibili per l'analisi finanziaria:\n";
            if (newlyDiscovered.gemini.length > 0) {
                body += `\n• Google Gemini: ${newlyDiscovered.gemini.join(', ')}`;
            }
            if (newlyDiscovered.openrouter.length > 0) {
                body += `\n• OpenRouter Free: ${newlyDiscovered.openrouter.join(', ')}`;
            }
            body += "\n\nPuoi abilitarli nel Pannello Admin -> Impostazioni AI.";

            const existing = database.db.prepare(`
                SELECT id FROM notifications 
                WHERE user_id = 1 AND title = ? AND message = ? 
                ORDER BY date DESC LIMIT 1
            `).get(title, body);

            if (!existing) {
                notifyUser(1, 'STATUS', {
                    title,
                    body
                });
            }
        } else {
            aiLogger.info('[Check AI Models] Nessun nuovo modello rilevato.');
        }

        return totalNew;
    } catch (err) {
        aiLogger.error('[Check AI Models] Errore durante il check dei modelli:', err.message);
        return [];
    }
}

// Alias retrocompatibile
const checkNewGeminiModels = checkNewAIModels;


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
            if (keys.openrouterApiKey || keys.openrouterApiKeyPay || keys.openrouterModel1) {
                aiLogger.info('[AI Fallback] Gemini key missing, falling back to OpenRouter (OR1)');
                return callAIModel('OR1', prompt, keys);
            }
            if (keys.requestyApiKey || keys.requestyApiKeyPay || keys.requestyModel1) {
                aiLogger.info('[AI Fallback] Gemini key missing, falling back to Requesty (REQ1)');
                return callAIModel('REQ1', prompt, keys);
            }
            if (keys.aimlapiApiKeyFree || keys.aimlapiApiKeyPay || keys.aimlapiApiKey) {
                aiLogger.info('[AI Fallback] Gemini key missing, falling back to Aimlapi');
                return callAIModel('Aimlapi_Free', prompt, keys);
            }
            throw new Error(`Gemini API Key mancante e nessuna altra chiave IA trovata nelle impostazioni.`);
        }

        let candidateModels = await getGeminiCandidateModels(apiKey);
        if (engine.includes('3.8')) {
            candidateModels = ['gemini-3.8-flash', 'gemini-3.8-pro', ...candidateModels.filter(m => !m.includes('3.8'))];
        } else if (engine.includes('2.8')) {
            candidateModels = ['gemini-2.8-flash', 'gemini-2.8-pro', ...candidateModels.filter(m => !m.includes('2.8'))];
        } else if (engine.includes('2.7')) {
            candidateModels = ['gemini-2.7-flash', 'gemini-2.7-pro', ...candidateModels.filter(m => !m.includes('2.7'))];
        }
        let res = null;
        let lastError = null;
        let modelUsed = null;

        for (let i = 0; i < candidateModels.length; i++) {
            const currentModel = candidateModels[i];
            let attempt = 0;
            const maxModelAttempts = 2;
            let modelSuccess = false;

            while (attempt < maxModelAttempts) {
                attempt++;
                try {
                    aiLogger.info(`[Gemini] Attempting generation with model: ${currentModel} (attempt ${attempt}/${maxModelAttempts})`);
                    res = await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`,
                        { 
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { temperature: 0.1 }
                        },
                        { 
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 120000
                        }
                    );
                    modelUsed = currentModel;
                    modelSuccess = true;
                    _cachedGeminiModel = currentModel;
                    _geminiModelCachedAt = Date.now();
                    break;
                } catch (apiErr) {
                    lastError = apiErr;
                    const status = apiErr.response ? apiErr.response.status : null;
                    const errData = apiErr.response ? apiErr.response.data : null;
                    const errMsg = errData ? JSON.stringify(errData) : apiErr.message;

                    // 503 (High demand/Overloaded), 429 (Resource exhausted / Quota limit), 404 (Model not found)
                    if (status === 503 || status === 429 || status === 404) {
                        aiLogger.warn(`[Gemini] Model ${currentModel} returned HTTP ${status} (High demand / Quota limit): ${errMsg}`);
                        if (_cachedGeminiModel === currentModel) {
                            _cachedGeminiModel = null;
                        }
                        // Non attendere inutilmente lo stesso modello sovraccarico: passa subito al prossimo modello candidato!
                        break;
                    } else {
                        aiLogger.warn(`[AI API Error (Gemini)] Model ${currentModel} attempt ${attempt}/${maxModelAttempts} failed: ${errMsg}`);
                        if (attempt < maxModelAttempts) {
                            await new Promise(resolve => setTimeout(resolve, 1500));
                        }
                    }
                }
            }

            if (modelSuccess && res) {
                break;
            }
        }

        if (!res || !modelUsed) {
            // Cascade to alternative configured AI engines if all Gemini models failed
            if (keys.openrouterApiKey || keys.openrouterApiKeyPay || keys.openrouterModel1) {
                aiLogger.warn('[AI Fallback] All Gemini models overloaded (503/429), automatically falling back to OpenRouter (OR1)...');
                return callAIModel('OR1', prompt, keys);
            }
            if (keys.requestyApiKey || keys.requestyApiKeyPay || keys.requestyModel1) {
                aiLogger.warn('[AI Fallback] All Gemini models overloaded (503/429), automatically falling back to Requesty (REQ1)...');
                return callAIModel('REQ1', prompt, keys);
            }
            if (keys.aimlapiApiKeyFree || keys.aimlapiApiKeyPay || keys.aimlapiApiKey) {
                aiLogger.warn('[AI Fallback] All Gemini models overloaded (503/429), automatically falling back to Aimlapi...');
                return callAIModel('Aimlapi_Free', prompt, keys);
            }

            const finalMsg = lastError?.response?.data?.error?.message || lastError?.message || 'Tutti i modelli Gemini risultano temporaneamente sovraccarichi (503/429).';
            throw new Error(`[Gemini Error] ${finalMsg} Prova a selezionare un modello alternativo (es. Gemini 2.0 Flash o Gemini 1.5 Flash) nelle Impostazioni AI.`);
        }

        const candidate = res.data.candidates?.[0];
        const content = candidate?.content?.parts?.[0]?.text || "{}";
        aiLogger.info(`[AI Response (${engine} - ${modelUsed})] \n${content}`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 }, modelUsed: modelUsed };
    }
}

// Modelli Requesty consigliati (statici)
const RECOMMENDED_REQUESTY_FREE = [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek: V3 Chat', priceLabel: 'Best Value', isFree: true, recommended: true },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1 Reasoning', priceLabel: 'Best Value', isFree: true, recommended: true },
    { id: 'qwen/qwq-32b', name: 'Qwen: QwQ 32B', priceLabel: 'Best Value', isFree: true, recommended: true },
];
const RECOMMENDED_REQUESTY_PAY = [
    { id: 'google/gemini-2.8-pro', name: 'Google: Gemini 2.8 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'google/gemini-2.7-pro', name: 'Google: Gemini 2.7 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Anthropic: Claude 3.5 Sonnet', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'openai/gpt-4o-2024-11-20', name: 'OpenAI: GPT-4o (Nov 2024)', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
];

// Modelli Gemini consigliati (statici)
const RECOMMENDED_GEMINI_FREE = [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', priceLabel: 'Free', isFree: true, recommended: true },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', priceLabel: 'Free', isFree: true, recommended: true },
];
const RECOMMENDED_GEMINI_PAY = [
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', priceLabel: 'Pay', isFree: false, recommended: true },
];

/**
 * Restituisce i modelli consigliati (top free + top pay) per ogni provider.
 * Usato dall'endpoint /api/admin/recommended-models
 */
function getRecommendedModels() {
    // OpenRouter: prendi i primi 4 free e 3 pay dalla cache (o dal fallback statico)
    const orModels = _cachedOpenRouterModels;
    const orFree = orModels.filter(m => m.isFree && m.recommended).slice(0, 4);
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
    getGeminiCandidateModels,
    fetchOpenRouterModels,
    getOpenRouterModels,
    fetchRequestyModels,
    getRequestyModels,
    fetchGeminiModels,
    getGeminiModels,
    getGeminiModelPreference,
    getRecommendedModels,
    checkNewAIModels,
    checkNewGeminiModels,
    parseAIResponse,
    callAIModel
};
