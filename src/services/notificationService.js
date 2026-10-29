const database = require('../db');
const { logger } = require('../utils/logger');
const { sendPushNotification } = require('./pushService');
const { sendTelegramNotification } = require('./telegramService');

/**
 * Unified Notification Center
 * event: 'TP', 'SL', 'VOL', 'DAILY', 'STATUS', 'DIVIDEND', 'NEWS'
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

    // 2. Web Push (Smartphone / Browser / PWA)
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
        sendPushNotification(userId, pushPayload.title, pushPayload.body, pushPayload.data)
            .catch(e => logger.error(`Push notify failed for ${event}`, e));
    }

    // 3. Telegram Private Channel Notification
    const tgGloballyEnabled = (settings.telegramEnabled === 'true' || settings.telegram_enabled === 'true');
    const tgEventSetting = settings[`notify_${eventKey}_telegram`];
    const tgEventEnabled = force || (eventKey === 'status' ? tgEventSetting === 'true' : tgEventSetting !== 'false');
    if (tgGloballyEnabled && tgEventEnabled) {
        sendTelegramNotification(userId, payload, force)
            .catch(e => logger.error(`Telegram notify failed for ${event}:`, e.message));
    }
}

module.exports = {
    notifyUser
};
