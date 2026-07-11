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
            const available = [];
            
            if (settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY) {
                available.push('Gemini_Free');
            }
            
            const orKey = settings.openrouterApiKey || settings.openrouterApiKeyPay || process.env.OPENROUTER_API_KEY;
            if (orKey) {
                if (settings.openrouterModel1) available.push('OR1');
                if (settings.openrouterModel2) available.push('OR2');
                if (settings.openrouterModel3) available.push('OR3');
            }
            
            let geminiModelName = '';
            if (available.includes('Gemini_Free')) {
                const key = settings.geminiApiKeyFree || settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY;
                geminiModelName = await aiService.getBestGeminiModel(key);
            }
            
            const enginesWithLabels = available.map(e => {
                let label = e;
                if (e === 'Gemini_Free') label = `Gemini [${geminiModelName || 'caricamento...'}]`;
                
                if (e === 'OR1') {
                    label = `OpenRouter 1 [${settings.openrouterModel1}]`;
                } else if (e === 'OR2') {
                    label = `OpenRouter 2 [${settings.openrouterModel2}]`;
                } else if (e === 'OR3') {
                    label = `OpenRouter 3 [${settings.openrouterModel3}]`;
                }
                
                return { id: e, label };
            });
            
            // Fix eventual default settings that might still reference Gemini_Pay
            let defaultEngine = settings.aiEngine || 'Gemini_Free';
            if (defaultEngine === 'Gemini_Pay') defaultEngine = 'Gemini_Free';
            
            res.json({ engines: enginesWithLabels, default: defaultEngine });
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
                openrouterApiKey: settings.openrouterApiKey || settings.openrouterApiKeyPay || '',
                openrouterModel1: settings.openrouterModel1 || '',
                openrouterModel2: settings.openrouterModel2 || '',
                openrouterModel3: settings.openrouterModel3 || '',
                tavilyApiKey: settings.tavilyApiKey || '',
                aiAssetPrompt: settings.aiAssetPrompt || '',
                aiPortfolioPrompt: settings.aiPortfolioPrompt || '',
                aiTokensUsedToday: settings.aiTokensUsedToday || '0',
                aiTokensDate: settings.aiTokensDate || ''
            });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // POST /api/admin/ai-settings
    router.post('/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {
        const { aiEngine, geminiApiKeyFree, geminiApiKeyPay, openrouterApiKey, openrouterModel1, openrouterModel2, openrouterModel3, tavilyApiKey, aiAssetPrompt, aiPortfolioPrompt } = req.body;
        try {
            if (aiEngine !== undefined) database.setSetting(1, 'aiEngine', aiEngine);
            if (geminiApiKeyFree !== undefined) database.setSetting(1, 'geminiApiKeyFree', geminiApiKeyFree);
            if (geminiApiKeyPay !== undefined) database.setSetting(1, 'geminiApiKeyPay', geminiApiKeyPay);
            if (openrouterApiKey !== undefined) database.setSetting(1, 'openrouterApiKey', openrouterApiKey);
            if (openrouterModel1 !== undefined) database.setSetting(1, 'openrouterModel1', openrouterModel1);
            if (openrouterModel2 !== undefined) database.setSetting(1, 'openrouterModel2', openrouterModel2);
            if (openrouterModel3 !== undefined) database.setSetting(1, 'openrouterModel3', openrouterModel3);
            if (tavilyApiKey !== undefined) database.setSetting(1, 'tavilyApiKey', tavilyApiKey);
            if (aiAssetPrompt !== undefined) database.setSetting(1, 'aiAssetPrompt', aiAssetPrompt);
            if (aiPortfolioPrompt !== undefined) database.setSetting(1, 'aiPortfolioPrompt', aiPortfolioPrompt);
            
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
            res.json({ ok: true });
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

    // POST /api/telegram/send-report
    router.post('/telegram/send-report', requireAuth, async (req, res) => {
        try {
            await sendStatusNotification(req.user.id, 'DAILY');
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
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
