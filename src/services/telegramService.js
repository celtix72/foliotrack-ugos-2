const axios = require('axios');
const database = require('../db');
const { logger, telegramLogger } = require('../utils/logger');

function escapeHtml(str) {
    if (typeof str !== 'string') str = String(str || '');
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

/**
 * Sends a message to a Telegram chat or private channel.
 * @param {string} text - Message text (HTML or plain)
 * @param {string|null} customChatId - Specific channel/chat ID (e.g. -1001234567890 or @channel)
 * @param {number|null} userId - User ID to read settings from (default 1)
 * @param {object} options - Optional parameters: { token, parseMode: 'HTML', force: false }
 */
async function sendTelegramMessage(text, customChatId = null, userId = 1, options = {}) {
    const settings = database.getSettings(userId || 1);
    const token = options.token || settings.telegramBotToken;
    const chatId = customChatId || options.chatId || settings.telegramChatId;
    const isEnabled = options.force || settings.telegramEnabled === 'true' || settings.telegram_enabled === 'true';

    if (!isEnabled && !options.force) {
        telegramLogger.log(`[SKIPPED] Telegram notifications disabled for user ${userId}.`);
        return { success: false, skipped: true, error: 'Notifiche Telegram disabilitate nelle impostazioni.' };
    }

    if (!token || !chatId) {
        const errMsg = 'Token o ID canale/chat Telegram non configurato.';
        telegramLogger.log(`[SKIPPED] ${errMsg} (User ${userId})`);
        return { success: false, error: errMsg };
    }

    const cleanChatId = String(chatId).trim();
    const cleanToken = String(token).trim();
    const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
    const parseMode = options.parseMode !== undefined ? options.parseMode : 'HTML';

    const payload = {
        chat_id: cleanChatId,
        text: text,
        disable_web_page_preview: true
    };
    if (parseMode) payload.parse_mode = parseMode;

    try {
        telegramLogger.log(`[SEND] To: ${cleanChatId}, Preview: ${text.substring(0, 60).replace(/\n/g, ' ')}...`);
        const res = await axios.post(url, payload, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (res.data && res.data.ok) {
            telegramLogger.log(`[SUCCESS] Message successfully delivered to ${cleanChatId}`);
            return { success: true, result: res.data.result };
        } else {
            const desc = (res.data && res.data.description) || 'Unknown error';
            telegramLogger.log(`[API ERROR] ${desc}`);
            return { success: false, error: desc };
        }
    } catch (err) {
        // If HTML entity parsing fails, retry as plain text without parse_mode
        if (parseMode && err.response && err.response.data && err.response.data.description &&
            err.response.data.description.toLowerCase().includes("can't parse entities")) {
            try {
                telegramLogger.log(`[RETRY] Retrying without parse_mode for ${cleanChatId}...`);
                const retryPayload = { ...payload };
                delete retryPayload.parse_mode;
                const retryRes = await axios.post(url, retryPayload, {
                    timeout: 10000,
                    headers: { 'Content-Type': 'application/json' }
                });
                if (retryRes.data && retryRes.data.ok) {
                    telegramLogger.log(`[SUCCESS] Retry delivered to ${cleanChatId}`);
                    return { success: true, result: retryRes.data.result };
                }
            } catch (retryErr) {
                // fall through to primary error reporting
            }
        }

        let errMsg = err.message;
        if (err.response && err.response.data && err.response.data.description) {
            errMsg = err.response.data.description;
        }

        // Add helpful hints for common channel errors
        if (errMsg.includes('chat not found')) {
            errMsg += ' (Verifica che il bot sia stato aggiunto al canale privato con i permessi di amministratore).';
        } else if (errMsg.includes('not enough rights')) {
            errMsg += ' (Il bot deve avere il permesso di "Pubblicare messaggi" come amministratore del canale).';
        }

        telegramLogger.log(`[ERROR] Send failed to ${cleanChatId}: ${errMsg}`);
        logger.error(`[Telegram] Send failed to ${cleanChatId}: ${errMsg}`);
        return { success: false, error: errMsg };
    }
}

/**
 * Formats and sends a unified notification to the user's Telegram channel.
 * Uses the exact same title & body as the smartphone push notification.
 */
async function sendTelegramNotification(userId, payload, force = false) {
    const settings = database.getSettings(userId || 1);
    const title = payload.title || 'FolioTrack Alert';
    const body = payload.body || '';
    const url = (payload.data && payload.data.url) ? payload.data.url : null;

    let text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
    if (url && String(url).startsWith('http')) {
        text += `\n\n<a href="${escapeHtml(url)}">🔗 Apri Notizia</a>`;
    }

    return await sendTelegramMessage(text, null, userId, { parseMode: 'HTML', force });
}

async function startTelegramPolling() {
    return Promise.resolve();
}

module.exports = {
    sendTelegramMessage,
    sendTelegramNotification,
    startTelegramPolling,
    escapeHtml,
    escapeV2,
    escapeCodeV2
};
