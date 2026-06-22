const express = require('express');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        requireAdmin,
        database,
        logger,
        resetTransporter
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
    router.get('/ai/available-engines', requireAuth, (req, res) => {
        try {
            const settings = database.getSettings(1);
            const available = [];
            
            if (settings.geminiApiKeyFree) available.push('Gemini_Free');
            if (settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY) available.push('Gemini_Pay');
            if (settings.qwenApiKeyFree) available.push('Qwen_Free');
            if (settings.qwenApiKeyPay || settings.qwenApiKey || process.env.QWEN_API_KEY) available.push('Qwen_Pay');
            if (settings.openaiApiKeyFree) available.push('OpenAI_Free');
            if (settings.openaiApiKeyPay || settings.openaiApiKey || process.env.OPENAI_API_KEY) available.push('OpenAI_Pay');
            if (settings.agnesApiKeyFree) available.push('Agnes_Free');
            if (settings.agnesApiKeyPay || settings.agnesApiKey || process.env.AGNES_API_KEY) available.push('Agnes_Pay');
            if (settings.aimlapiApiKeyFree) available.push('Aimlapi_Free');
            if (settings.aimlapiApiKeyPay || process.env.AIMLAPI_API_KEY) available.push('Aimlapi_Pay');
            
            const hasGemini = available.some(e => e.startsWith('Gemini'));
            const hasQwen = available.some(e => e.startsWith('Qwen'));
            if (hasGemini && hasQwen) {
                available.push('Both');
            }
            
            res.json({ engines: available, default: settings.aiEngine || 'Gemini_Free' });
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
                qwenApiKeyFree: settings.qwenApiKeyFree || '',
                qwenApiKeyPay: settings.qwenApiKeyPay || settings.qwenApiKey || '',
                openaiApiKeyFree: settings.openaiApiKeyFree || '',
                openaiApiKeyPay: settings.openaiApiKeyPay || settings.openaiApiKey || '',
                agnesApiKeyFree: settings.agnesApiKeyFree || '',
                agnesApiKeyPay: settings.agnesApiKeyPay || '',
                aimlapiApiKeyFree: settings.aimlapiApiKeyFree || '',
                aimlapiApiKeyPay: settings.aimlapiApiKeyPay || '',
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
        const { aiEngine, geminiApiKeyFree, geminiApiKeyPay, qwenApiKeyFree, qwenApiKeyPay, openaiApiKeyFree, openaiApiKeyPay, agnesApiKeyFree, agnesApiKeyPay, aimlapiApiKeyFree, aimlapiApiKeyPay, tavilyApiKey, aiAssetPrompt, aiPortfolioPrompt } = req.body;
        try {
            if (aiEngine !== undefined) database.setSetting(1, 'aiEngine', aiEngine);
            if (geminiApiKeyFree !== undefined) database.setSetting(1, 'geminiApiKeyFree', geminiApiKeyFree);
            if (geminiApiKeyPay !== undefined) database.setSetting(1, 'geminiApiKeyPay', geminiApiKeyPay);
            if (qwenApiKeyFree !== undefined) database.setSetting(1, 'qwenApiKeyFree', qwenApiKeyFree);
            if (qwenApiKeyPay !== undefined) database.setSetting(1, 'qwenApiKeyPay', qwenApiKeyPay);
            if (openaiApiKeyFree !== undefined) database.setSetting(1, 'openaiApiKeyFree', openaiApiKeyFree);
            if (openaiApiKeyPay !== undefined) database.setSetting(1, 'openaiApiKeyPay', openaiApiKeyPay);
            if (agnesApiKeyFree !== undefined) database.setSetting(1, 'agnesApiKeyFree', agnesApiKeyFree);
            if (agnesApiKeyPay !== undefined) database.setSetting(1, 'agnesApiKeyPay', agnesApiKeyPay);
            if (aimlapiApiKeyFree !== undefined) database.setSetting(1, 'aimlapiApiKeyFree', aimlapiApiKeyFree);
            if (aimlapiApiKeyPay !== undefined) database.setSetting(1, 'aimlapiApiKeyPay', aimlapiApiKeyPay);
            if (tavilyApiKey !== undefined) database.setSetting(1, 'tavilyApiKey', tavilyApiKey);
            if (aiAssetPrompt !== undefined) database.setSetting(1, 'aiAssetPrompt', aiAssetPrompt);
            if (aiPortfolioPrompt !== undefined) database.setSetting(1, 'aiPortfolioPrompt', aiPortfolioPrompt);
            
            logger.info(`[ADMIN] AI settings updated by ${req.user.username}`);
            res.json({ ok: true });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    return router;
};
