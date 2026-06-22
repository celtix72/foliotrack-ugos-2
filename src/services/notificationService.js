const database = require('../db');
const { logger } = require('../utils/logger');
const { sendTelegramMessage } = require('./telegramService');
const { sendPushNotification } = require('./pushService');

/**
 * Unified Notification Center
 * event: 'TP', 'SL', 'VOL', 'DAILY', 'STATUS', 'DIVIDEND'
 */
async function notifyUser(userId, event, payload, force = false) {
    const settings = database.getSettings(userId);
    const eventKey = event.toLowerCase();
    
    // 1. Log in internal notifications table
    try {
        database.db.prepare(`
            INSERT INTO notifications (type, title, message, ticker, user_id)
            VALUES (?, ?, ?, ?, ?)
        `).run(event, payload.title, payload.body, payload.ticker || null, userId);
    } catch (e) {
        logger.error('Failed to log internal notification', e);
    }

    // 2. Telegram
    const tgEnabled = force || (settings.telegramEnabled === 'true' && settings[`notify_${eventKey}_telegram`] === 'true');
    if (tgEnabled && settings.telegram_chat_id) {
        const tgMsg = payload.telegramMessage || payload.body;
        sendTelegramMessage(tgMsg, null, userId).catch(e => logger.error(`Telegram notify failed for ${event}`, e));
    }

    // 3. Web Push
    const pushEnabled = force || settings[`notify_${eventKey}_push`] === 'true';
    if (pushEnabled) {
        const pushPayload = {
            ...payload,
            tag: eventKey, // Pass event type as tag for Watch grouping
            data: { 
                ...(payload.data || {}), 
                tag: eventKey 
            }
        };
        sendPushNotification(userId, pushPayload.title, pushPayload.body, pushPayload.data).catch(e => logger.error(`Push notify failed for ${event}`, e));
    }
}

module.exports = {
    notifyUser
};
