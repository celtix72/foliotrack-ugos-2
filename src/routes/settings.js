const express = require('express');
const fs = require('fs');
const aiService = require('../services/aiService');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        requireAdmin,
        database,
        logger,
        resetTransporter,
        sendTelegramMessage,
        sendStatusNotification,
        escapeV2,
        escapeCodeV2,
        TELEGRAM_LOG_FILE
    } = dependencies;

    // GET /api/admin/smtp-settings
    router.get('/admin/smtp-settings', requireAuth, requireAdmin, (req, res) => {
        try {
            const settings = database.getSettings(1);
            res.json({
                smtp_host: settings.smtp_host || '',
                smtp_port: settings.smtp_port || '',
                smtp_user: settings.smtp_user || '',
                smtp_from: settings.smtp_from || ''
            });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // POST /api/admin/smtp-settings
    router.post('/admin/smtp-settings', requireAuth, requireAdmin, (req, res) => {
        const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
        try {
            if (smtp_host !== undefined) database.setSetting(1, 'smtp_host', smtp_host);
            if (smtp_port !== undefined) database.setSetting(1, 'smtp_port', smtp_port);
            if (smtp_user !== undefined) database.setSetting(1, 'smtp_user', smtp_user);
            if (smtp_pass !== undefined && smtp_pass !== '') database.setSetting(1, 'smtp_pass', smtp_pass);
            if (smtp_from !== undefined) database.setSetting(1, 'smtp_from', smtp_from);
            
            if (resetTransporter) resetTransporter();
            
            logger.info(`[ADMIN] SMTP settings updated by ${req.user.username}`);
            res.json({ ok: true });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // GET /api/ai/available-engines
    router.get('/ai/available-engines', requireAuth, async (req, res) => {
        try {
            const settings = database.getSettings(1);
            const geminiKey = settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY;
            const orKey = settings.openrouterApiKey || settings.openrouterApiKeyPay || process.env.OPENROUTER_API_KEY;
            const reqKey = settings.requestyApiKey || settings.requestyApiKeyPay || settings.requestyApiKeyFree || process.env.REQUESTY_API_KEY;

            let defaultEngine = settings.aiEngine || 'Gemini_Free';
            if (defaultEngine === 'Gemini_Pay') defaultEngine = 'Gemini_Free';

            const engines = [];

            // 1. Motore Predefinito di Sistema
            engines.push({
                id: defaultEngine,
                label: `⚙️ Predefinito di Sistema (${defaultEngine.replace('_', ' ')})`,
                group: 'Predefinito'
            });

            // 2. Modelli Google Gemini (se chiave configurata)
            if (geminiKey) {
                engines.push({ id: 'gemini-2.0-flash', label: '🥇 Gemini 2.0 Flash (Consigliato Free)', group: 'Google Gemini' });
                engines.push({ id: 'gemini-3.8-flash', label: '⚡ Gemini 3.8 Flash', group: 'Google Gemini' });
                engines.push({ id: 'gemini-1.5-flash', label: '🛡️ Gemini 1.5 Flash (Stabile Fallback)', group: 'Google Gemini' });
                engines.push({ id: 'gemini-2.0-flash-lite', label: '🚀 Gemini 2.0 Flash Lite', group: 'Google Gemini' });
                engines.push({ id: 'gemini-1.5-pro', label: '💎 Gemini 1.5 Pro', group: 'Google Gemini' });
                engines.push({ id: 'Gemini_Free', label: '🔄 Gemini Waterfall Automatico', group: 'Google Gemini' });
            }

            // 3. Modelli OpenRouter Free (se chiave configurata)
            if (orKey) {
                engines.push({ id: 'deepseek/deepseek-r1:free', label: '🧠 DeepSeek R1 Reasoning (Free)', group: 'OpenRouter Free' });
                engines.push({ id: 'meta-llama/llama-3.3-70b-instruct:free', label: '🌐 Meta Llama 3.3 70B (Free)', group: 'OpenRouter Free' });
                engines.push({ id: 'qwen/qwq-32b:free', label: '📐 Qwen QwQ 32B Reasoning (Free)', group: 'OpenRouter Free' });
                engines.push({ id: 'google/gemini-2.0-flash-exp:free', label: '✨ Gemini 2.0 Flash (OpenRouter)', group: 'OpenRouter Free' });
            }

            // 4. Slot Personalizzati OpenRouter (OR1..OR5)
            const orModels = aiService.getOpenRouterModels();
            if (orKey) {
                for (let i = 1; i <= 5; i++) {
                    const slotModel = settings[`openrouterModel${i}`];
                    if (slotModel) {
                        const m = orModels.find(x => x.id === slotModel);
                        const mName = m ? m.name : slotModel.split('/').pop().replace(':free', '');
                        const freeTag = m?.isFree ? ' (Free)' : '';
                        engines.push({
                            id: `OR${i}`,
                            label: `Slot OR${i}: ${mName}${freeTag}`,
                            group: 'Slot Personalizzati OpenRouter'
                        });
                    }
                }
            }

            // 5. Slot Personalizzati Requesty (REQ1..REQ5)
            const reqModels = aiService.getRequestyModels();
            if (reqKey) {
                for (let i = 1; i <= 5; i++) {
                    const slotModel = settings[`requestyModel${i}`];
                    if (slotModel) {
                        const m = reqModels.find(x => x.id === slotModel);
                        const mName = m ? m.name : slotModel.split('/').pop();
                        engines.push({
                            id: `REQ${i}`,
                            label: `Slot REQ${i}: ${mName}`,
                            group: 'Slot Personalizzati Requesty'
                        });
                    }
                }
            }

            res.json({ engines, default: defaultEngine });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/admin/ai-settings
    router.get('/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {
        try {
            const settings = database.getSettings(1);
            res.json({
                aiEngine: settings.aiEngine || 'Gemini_Free',
                geminiApiKeyFree: settings.geminiApiKeyFree || '',
                geminiApiKeyPay: settings.geminiApiKeyPay || settings.geminiApiKey || '',
                geminiModel1: settings.geminiModel1 || '',
                geminiModel2: settings.geminiModel2 || '',
                geminiModel3: settings.geminiModel3 || '',
                openrouterApiKey: settings.openrouterApiKey || settings.openrouterApiKeyPay || '',
                openrouterModel1: settings.openrouterModel1 || '',
                openrouterModel2: settings.openrouterModel2 || '',
                openrouterModel3: settings.openrouterModel3 || '',
                openrouterModel4: settings.openrouterModel4 || '',
                openrouterModel5: settings.openrouterModel5 || '',
                requestyApiKey: settings.requestyApiKey || settings.requestyApiKeyPay || settings.requestyApiKeyFree || '',
                requestyModel1: settings.requestyModel1 || '',
                requestyModel2: settings.requestyModel2 || '',
                requestyModel3: settings.requestyModel3 || '',
                requestyModel4: settings.requestyModel4 || '',
                requestyModel5: settings.requestyModel5 || '',
                tavilyApiKey: settings.tavilyApiKey || '',
                aiAssetPrompt: settings.aiAssetPrompt || '',
                aiAssetPromptGarp: settings.aiAssetPromptGarp || '',
                aiAssetPromptDisruptive: settings.aiAssetPromptDisruptive || '',
                aiAssetPromptTech: settings.aiAssetPromptTech || '',
                aiAssetPromptFin: settings.aiAssetPromptFin || '',
                aiAssetPromptCapital: settings.aiAssetPromptCapital || '',
                aiPortfolioPrompt: settings.aiPortfolioPrompt || '',
                aiReportPrompt: settings.aiReportPrompt || `Sei un analista finanziario esperto. Analizza il seguente portafoglio basandoti sui dati forniti nella sezione ASSET APERTI e nei DATI COMPLETI PORTAFOGLIO.

IMPORTANTE:
1. Rispetta tassativamente la classificazione ed il Tipo di ciascuno strumento indicato in ASSET APERTI (es. XEON.DE è un ETF Monetario, BTP è Obbligazione Governativa, ecc.). NON allucinare o modificare la categoria degli asset.
2. Esegui l'analisi sia sul Valore di Costo (PMC x Quantità) sia sul Valore Attuale di Mercato (Prezzo Attuale x Quantità).
3. Fornisci un report strutturato con:
   - Analisi posizioni aperte (rischio, diversificazione, duration, home bias Italia).
   - Analisi posizioni chiuse e dividendi per anno.
   - Matrice di Rebalancing ed indicazioni operative concrete.`,
                aiReportEngine: settings.aiReportEngine || 'Gemini_Free',
                aiTokensUsedToday: settings.aiTokensUsedToday || '0',
                aiTokensDate: settings.aiTokensDate || '',
                geminiModelPreferences: settings.geminiModelPreferences || ''
            });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // POST /api/admin/ai-settings
    router.post('/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {
        const { aiEngine, geminiApiKeyFree, geminiApiKeyPay, geminiModel1, geminiModel2, geminiModel3, openrouterApiKey, openrouterModel1, openrouterModel2, openrouterModel3, openrouterModel4, openrouterModel5, requestyApiKey, requestyModel1, requestyModel2, requestyModel3, requestyModel4, requestyModel5, tavilyApiKey, aiAssetPrompt, aiAssetPromptGarp, aiAssetPromptDisruptive, aiAssetPromptTech, aiAssetPromptFin, aiAssetPromptCapital, aiPortfolioPrompt, aiReportPrompt, aiReportEngine, geminiModelPreferences } = req.body;
        try {
            if (aiEngine !== undefined) database.setSetting(1, 'aiEngine', aiEngine);
            if (geminiApiKeyFree !== undefined) database.setSetting(1, 'geminiApiKeyFree', geminiApiKeyFree);
            if (geminiApiKeyPay !== undefined) database.setSetting(1, 'geminiApiKeyPay', geminiApiKeyPay);
            if (geminiModel1 !== undefined) database.setSetting(1, 'geminiModel1', geminiModel1);
            if (geminiModel2 !== undefined) database.setSetting(1, 'geminiModel2', geminiModel2);
            if (geminiModel3 !== undefined) database.setSetting(1, 'geminiModel3', geminiModel3);
            if (openrouterApiKey !== undefined) database.setSetting(1, 'openrouterApiKey', openrouterApiKey);
            if (openrouterModel1 !== undefined) database.setSetting(1, 'openrouterModel1', openrouterModel1);
            if (openrouterModel2 !== undefined) database.setSetting(1, 'openrouterModel2', openrouterModel2);
            if (openrouterModel3 !== undefined) database.setSetting(1, 'openrouterModel3', openrouterModel3);
            if (openrouterModel4 !== undefined) database.setSetting(1, 'openrouterModel4', openrouterModel4);
            if (openrouterModel5 !== undefined) database.setSetting(1, 'openrouterModel5', openrouterModel5);
            if (requestyApiKey !== undefined) database.setSetting(1, 'requestyApiKey', requestyApiKey);
            if (requestyModel1 !== undefined) database.setSetting(1, 'requestyModel1', requestyModel1);
            if (requestyModel2 !== undefined) database.setSetting(1, 'requestyModel2', requestyModel2);
            if (requestyModel3 !== undefined) database.setSetting(1, 'requestyModel3', requestyModel3);
            if (requestyModel4 !== undefined) database.setSetting(1, 'requestyModel4', requestyModel4);
            if (requestyModel5 !== undefined) database.setSetting(1, 'requestyModel5', requestyModel5);
            if (tavilyApiKey !== undefined) database.setSetting(1, 'tavilyApiKey', tavilyApiKey);
            if (aiAssetPrompt !== undefined) database.setSetting(1, 'aiAssetPrompt', aiAssetPrompt);
            if (aiAssetPromptGarp !== undefined) database.setSetting(1, 'aiAssetPromptGarp', aiAssetPromptGarp);
            if (aiAssetPromptDisruptive !== undefined) database.setSetting(1, 'aiAssetPromptDisruptive', aiAssetPromptDisruptive);
            if (aiAssetPromptTech !== undefined) database.setSetting(1, 'aiAssetPromptTech', aiAssetPromptTech);
            if (aiAssetPromptFin !== undefined) database.setSetting(1, 'aiAssetPromptFin', aiAssetPromptFin);
            if (aiAssetPromptCapital !== undefined) database.setSetting(1, 'aiAssetPromptCapital', aiAssetPromptCapital);
            if (aiPortfolioPrompt !== undefined) database.setSetting(1, 'aiPortfolioPrompt', aiPortfolioPrompt);
            if (aiReportPrompt !== undefined) database.setSetting(1, 'aiReportPrompt', aiReportPrompt);
            if (aiReportEngine !== undefined) database.setSetting(1, 'aiReportEngine', aiReportEngine);
            if (geminiModelPreferences !== undefined) database.setSetting(1, 'geminiModelPreferences', geminiModelPreferences);
            
            logger.info(`[ADMIN] AI settings updated by ${req.user.username}`);
            res.json({ ok: true });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // GET /api/settings
    router.get('/settings', requireAuth, (req, res) => {
        try {
            res.json(database.getSettings(req.user.id));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // PUT /api/settings
    router.put('/settings', requireAuth, (req, res) => {
        try {
            const userId = req.user.id;
            database.db.transaction(() => {
                for (const [key, value] of Object.entries(req.body)) {
                    database.setSetting(userId, key, value);
                }
            })();
            res.json(database.getSettings(userId));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/settings/notifications
    router.get('/settings/notifications', requireAuth, (req, res) => {
        try {
            const settings = database.getSettings(req.user.id);
            const matrix = {
                tp: { telegram: settings.notify_tp_telegram === 'true', push: settings.notify_tp_push === 'true' },
                sl: { telegram: settings.notify_sl_telegram === 'true', push: settings.notify_sl_push === 'true' },
                vol: { telegram: settings.notify_vol_telegram === 'true', push: settings.notify_vol_push === 'true' },
                daily: { telegram: settings.notify_daily_telegram === 'true', push: settings.notify_daily_push === 'true' },
                status: { telegram: settings.notify_status_telegram === 'true', push: settings.notify_status_push === 'true' },
                dividend: { telegram: settings.notify_dividend_telegram === 'true', push: settings.notify_dividend_push === 'true' },
                news: { telegram: settings.notify_news_telegram === 'true', push: settings.notify_news_push === 'true' }
            };
            res.json(matrix);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/settings/notifications
    router.post('/settings/notifications', requireAuth, (req, res) => {
        const matrix = req.body;
        try {
            const userId = req.user.id;
            const updates = [];
            for (const [event, channels] of Object.entries(matrix)) {
                updates.push({ key: `notify_${event}_telegram`, value: String(channels.telegram) });
                updates.push({ key: `notify_${event}_push`, value: String(channels.push) });
            }
            
            database.db.transaction(() => {
                const stmt = database.db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)');
                for (const u of updates) {
                    stmt.run(userId, u.key, u.value);
                }
            })();
            
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/settings/telegram/test-tp
    router.post('/settings/telegram/test-tp', requireAuth, async (req, res) => {
        try {
            const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            const msg = `${escapeV2('🏆')} *${escapeV2('TARGET PROFIT')}*\n\n` +
                        `\`${escapeCodeV2('AAPL     $ 190,50')}\`\n` +
                        `*${escapeV2('Target:')}* \`${escapeCodeV2('$ 190,00')}\`\n\n` +
                        `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
            await sendTelegramMessage(msg);
            res.json({ success: true, message: 'Test TP sent' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/settings/telegram/test-sl
    router.post('/settings/telegram/test-sl', requireAuth, async (req, res) => {
        try {
            const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            const msg = `${escapeV2('⚠️')} *${escapeV2('STOP LOSS')}*\n\n` +
                        `\`${escapeCodeV2('TSLA     $ 165,20')}\`\n` +
                        `*${escapeV2('Soglia:')}* \`${escapeCodeV2('$ 170,00')}\`\n\n` +
                        `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
            await sendTelegramMessage(msg);
            res.json({ success: true, message: 'Test SL sent' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/settings/telegram/test-volatility
    router.post('/settings/telegram/test-volatility', requireAuth, async (req, res) => {
        try {
            const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            const msg = `${escapeV2('📊')} *${escapeV2('VOLATILITY ALERT')}*\n\n` +
                        `${escapeV2('📈')} \`${escapeCodeV2('BTC.USD  $ 68.340,50')}\`\n` +
                        `*${escapeV2('Var.:')}* \`${escapeCodeV2('+5,20%')}\` ${escapeV2('(Soglia: 5%)')}\n\n` +
                        `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
            await sendTelegramMessage(msg);
            res.json({ success: true, message: 'Test Volatility sent' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/settings/telegram/test-status
    router.post('/settings/telegram/test-status', requireAuth, async (req, res) => {
        try {
            await sendStatusNotification(req.user.id, 'STATUS');
            res.json({ success: true, message: 'Test Status sent' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/settings/telegram/test-news
    router.post('/settings/telegram/test-news', requireAuth, async (req, res) => {
        try {
            const userId = req.user.id;
            const { notifyUser } = require('../services/notificationService');

            // 1. Get last 3 news
            let news = database.db.prepare('SELECT title, link, pubDate, source_name FROM news_articles WHERE user_id = ? ORDER BY pubDate DESC LIMIT 3').all(userId);
            if (news.length === 0) {
                news = database.db.prepare('SELECT title, link, pubDate, publisher AS source_name FROM global_news ORDER BY publishedAt DESC LIMIT 3').all();
            }

            if (news.length === 0) {
                return res.status(404).json({ error: 'Nessuna notizia disponibile nel database per eseguire il test.' });
            }

            // 2. Get user's tickers
            const userTickersRows = database.db.prepare(`
                SELECT DISTINCT assetTicker FROM transactions
                WHERE portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)
                  AND assetTicker IS NOT NULL AND assetTicker != 'CASH' AND assetTicker != ''
            `).all(userId);

            const userTickers = userTickersRows.map(r => r.assetTicker);
            let assets = [];
            if (userTickers.length > 0) {
                const placeholders = userTickers.map(() => '?').join(',');
                assets = database.db.prepare(`
                    SELECT ticker, name FROM assets WHERE ticker IN (${placeholders})
                `).all(...userTickers);
            }

            const escapeV2 = (text) => {
                if (typeof text !== 'string') text = String(text || '');
                return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
            };

            let sentCount = 0;

            for (const item of news) {
                let matchedTicker = 'TEST';
                const titleLower = item.title.toLowerCase();

                // Find a match
                for (const asset of assets) {
                    const cleanT = asset.ticker.split('.')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                    if (cleanT.length >= 3 && titleLower.includes(cleanT)) {
                        matchedTicker = asset.ticker;
                        break;
                    }
                    if (titleLower.includes(asset.ticker.toLowerCase())) {
                        matchedTicker = asset.ticker;
                        break;
                    }
                    if (asset.name) {
                        const cleanName = asset.name.toLowerCase().replace(/inc\.|corp\.|ltd\.|spa|s\.p\.a\./g, '').trim();
                        if (cleanName.length >= 4 && titleLower.includes(cleanName)) {
                            matchedTicker = asset.ticker;
                            break;
                        }
                    }
                }

                if (matchedTicker === 'TEST' && userTickers.length > 0) {
                    matchedTicker = userTickers[0]; // fallback to first ticker of the user
                }

                const cleanTitle = escapeV2(item.title);
                const cleanTicker = escapeV2(matchedTicker);
                const cleanLink = item.link.replace(/([\\)])/g, '\\$1');

                const payload = {
                    title: `News Alert (Test): ${matchedTicker}`,
                    body: `${item.title}`,
                    ticker: matchedTicker,
                    data: {
                        url: item.link
                    },
                    telegramMessage: `📰 *News Alert (Test): ${cleanTicker}*\n\n${cleanTitle}\n\n[Leggi notizia completa](${cleanLink})`
                };

                await notifyUser(userId, 'NEWS', payload, true); // force send
                sentCount++;
            }

            res.json({ success: true, message: `Inviati ${sentCount} test alert di notizie.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/settings/push/test (alias for admin push test)
    router.post('/settings/push/test', requireAuth, async (req, res) => {
        try {
            const { sendPushNotification } = require('../services/pushService');
            const result = await sendPushNotification(
                req.user.id,
                'FolioTrack Push Test 🚀',
                'Se ricevi questo messaggio, le notifiche push del tuo browser sono configurate ed attive!',
                { url: '/dashboard' }
            );
            if (result.success && result.sentCount > 0) {
                res.json({ success: true, message: 'Notifica inviata con successo!', sentCount: result.sentCount });
            } else if (result.success && result.sentCount === 0) {
                res.status(400).json({ error: 'Nessun dispositivo registrato per le notifiche push. Assicurati di abilitare le notifiche su questo dispositivo.' });
            } else {
                res.status(500).json({ error: result.error || 'Errore invio push' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/telegram/send-report
    router.post('/telegram/send-report', requireAuth, async (req, res) => {
        try {
            await sendStatusNotification(req.user.id, 'DAILY');
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/admin/gemini-models
    router.get('/admin/gemini-models', requireAuth, requireAdmin, (req, res) => {
        try {
            const models = aiService.getGeminiModels();
            res.json({ success: true, models: models });
        } catch (err) {
            logger.error('[Gemini Models API Error]', err.message);
            res.status(500).json({ success: false, message: 'Errore interno.' });
        }
    });

    // GET /api/admin/openrouter-models
    router.get('/admin/openrouter-models', requireAuth, requireAdmin, (req, res) => {
        try {
            const models = aiService.getOpenRouterModels();
            res.json({ success: true, models: models });
        } catch (err) {
            logger.error('[OpenRouter Models API Error]', err.message);
            res.status(500).json({ success: false, message: 'Errore interno.' });
        }
    });

    // GET /api/admin/requesty-models
    router.get('/admin/requesty-models', requireAuth, requireAdmin, (req, res) => {
        try {
            const models = aiService.getRequestyModels();
            res.json({ success: true, models: models });
        } catch (err) {
            logger.error('[Requesty Models API Error]', err.message);
            res.status(500).json({ success: false, message: 'Errore interno.' });
        }
    });

    // GET /api/admin/recommended-models
    // Restituisce i top 3 free + top 3 pay per ogni provider
    router.get('/admin/recommended-models', requireAuth, requireAdmin, (req, res) => {
        try {
            const recommended = aiService.getRecommendedModels();
            res.json({ success: true, ...recommended });
        } catch (err) {
            logger.error('[Recommended Models API Error]', err.message);
            res.status(500).json({ success: false, message: 'Errore interno.' });
        }
    });

    // POST /api/admin/refresh-ai-models
    // Forza il refresh manuale dei modelli da OpenRouter, Requesty e Gemini ed esegue il check di nuovi modelli
    router.post('/admin/refresh-ai-models', requireAuth, requireAdmin, async (req, res) => {
        try {
            const settings = database.getSettings(1);
            const geminiKey = settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY;
            const refreshPromises = [aiService.fetchOpenRouterModels(), aiService.fetchRequestyModels()];
            if (geminiKey) refreshPromises.push(aiService.fetchGeminiModels(geminiKey));
            await Promise.allSettled(refreshPromises);

            const newModels = await aiService.checkNewAIModels();
            logger.info(`[ADMIN] AI models refreshed manually by ${req.user.username}`);
            res.json({ 
                success: true, 
                message: 'Modelli aggiornati con successo.',
                newModels: newModels || []
            });
        } catch (err) {
            logger.error('[Refresh AI Models Error]', err.message);
            res.status(500).json({ success: false, message: 'Errore durante il refresh.' });
        }
    });

    // GET /api/debug/telegram-market
    router.get('/debug/telegram-market', requireAuth, requireAdmin, async (req, res) => {
        try {
            const settings = database.getSettings(1);
            if (settings.telegramEnabled !== 'true') {
                return res.json({ success: false, error: 'Telegram is globally disabled in settings.' });
            }
            if (!settings.telegramBotToken || !settings.telegramChatId) {
                return res.json({ success: false, error: 'Missing Bot Token or Chat ID in settings.' });
            }
            await sendStatusNotification(req.user.id, 'STATUS');
            res.json({ success: true, message: 'Notification sent successfully.' });
        } catch (err) {
            logger.error('Debug Telegram failed', err);
            res.json({ success: false, error: err.message || 'Unknown error' });
        }
    });

    // GET /api/logs/telegram
    router.get('/logs/telegram', requireAuth, requireAdmin, (req, res) => {
        try {
            if (!fs.existsSync(TELEGRAM_LOG_FILE)) return res.json([]);
            const content = fs.readFileSync(TELEGRAM_LOG_FILE, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            res.json(lines.slice(-200).reverse()); // Last 200 lines
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/tax-rates
    router.get('/tax-rates', requireAuth, (req, res) => {
        try {
            const rates = database.db.prepare('SELECT asset_type, rate FROM tax_rates WHERE user_id = ?').all(req.user.id);
            res.json(rates);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/tax-rates
    router.post('/tax-rates', requireAuth, (req, res) => {
        const { rates } = req.body;
        if (!rates || !Array.isArray(rates)) return res.status(400).send('rates array required');
        
        try {
            database.db.transaction(() => {
                const stmt = database.db.prepare('INSERT OR REPLACE INTO tax_rates (user_id, asset_type, rate) VALUES (?, ?, ?)');
                for (const r of rates) {
                    stmt.run(req.user.id, r.asset_type, r.rate);
                }
            })();
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
