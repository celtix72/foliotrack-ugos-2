const webpush = require('web-push');
const database = require('../db');
const { logger } = require('../utils/logger');

// ─── Web Push Setup ──────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@foliotrack.io';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    logger.warn('Web Push VAPID keys not fully configured. Push notifications will not work.');
}

/**
 * Sends a web push notification to all subscriptions of a user.
 */
async function sendPushNotification(userId, title, body, data = {}) {
    const subscriptions = database.db.prepare('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({
        title,
        body,
        icon: '/logo.png',
        badge: '/logo_cropped.png',
        data: {
            url: '/dashboard',
            ...data
        }
    });

    for (const sub of subscriptions) {
        try {
            const pushConfig = JSON.parse(sub.subscription);
            await webpush.sendNotification(pushConfig, payload);
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                logger.info(`Push subscription ${sub.id} expired/invalid, removing.`);
                database.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
            } else {
                logger.error(`Error sending push notification to sub ${sub.id}`, err);
            }
        }
    }
}

module.exports = {
    sendPushNotification
};
