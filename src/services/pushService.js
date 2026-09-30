const webpush = require('web-push');
const database = require('../db');
const { logger } = require('../utils/logger');

// Ensure app_config table exists for persistent system settings
try {
    database.db.prepare(`
        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `).run();
} catch (e) {}

let vapidConfig = null;

function initVapid() {
    let pubKey = process.env.VAPID_PUBLIC_KEY;
    let privKey = process.env.VAPID_PRIVATE_KEY;
    let subject = process.env.VAPID_SUBJECT || 'mailto:admin@foliotrack.io';

    if (pubKey && privKey) {
        vapidConfig = { publicKey: pubKey, privateKey: privKey, subject };
        try {
            webpush.setVapidDetails(subject, pubKey, privKey);
            return vapidConfig;
        } catch (e) {
            logger.error('Error setting VAPID details from env:', e.message);
        }
    }

    // Check DB for existing persisted keys
    try {
        const rowPub = database.db.prepare("SELECT value FROM app_config WHERE key = 'vapid_public_key'").get();
        const rowPriv = database.db.prepare("SELECT value FROM app_config WHERE key = 'vapid_private_key'").get();
        const rowSub = database.db.prepare("SELECT value FROM app_config WHERE key = 'vapid_subject'").get();

        if (rowPub && rowPub.value && rowPriv && rowPriv.value) {
            pubKey = rowPub.value;
            privKey = rowPriv.value;
            subject = (rowSub && rowSub.value) || subject;
            process.env.VAPID_PUBLIC_KEY = pubKey;
            process.env.VAPID_PRIVATE_KEY = privKey;
            process.env.VAPID_SUBJECT = subject;
            vapidConfig = { publicKey: pubKey, privateKey: privKey, subject };
            webpush.setVapidDetails(subject, pubKey, privKey);
            logger.info('Loaded existing VAPID keys from database.');
            return vapidConfig;
        }
    } catch (e) {
        logger.warn('Could not query app_config for VAPID keys:', e.message);
    }

    // Auto-generate new VAPID keys if not present anywhere
    try {
        const keys = webpush.generateVAPIDKeys();
        pubKey = keys.publicKey;
        privKey = keys.privateKey;

        database.db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('vapid_public_key', ?)").run(pubKey);
        database.db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('vapid_private_key', ?)").run(privKey);
        database.db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('vapid_subject', ?)").run(subject);

        process.env.VAPID_PUBLIC_KEY = pubKey;
        process.env.VAPID_PRIVATE_KEY = privKey;
        process.env.VAPID_SUBJECT = subject;

        vapidConfig = { publicKey: pubKey, privateKey: privKey, subject };
        webpush.setVapidDetails(subject, pubKey, privKey);
        logger.info('Auto-generated and saved new persistent VAPID keys for Web Push notifications.');
        return vapidConfig;
    } catch (err) {
        logger.error('Failed to initialize or generate VAPID keys:', err);
        return null;
    }
}

// Initialize on module load
initVapid();

function getVapidPublicKey() {
    if (!vapidConfig) initVapid();
    return vapidConfig ? vapidConfig.publicKey : null;
}

/**
 * Sends a web push notification to all subscriptions of a user.
 */
async function sendPushNotification(userId, title, body, data = {}) {
    if (!vapidConfig) initVapid();
    if (!vapidConfig) {
        logger.warn('Cannot send push notification: VAPID keys not configured.');
        return { success: false, error: 'VAPID keys not configured' };
    }

    const subscriptions = database.db.prepare('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (subscriptions.length === 0) {
        logger.info(`No active push subscriptions found in database for user ${userId}.`);
        return { success: false, error: 'Nessun dispositivo registrato. Abilita le notifiche push in Impostazioni su questo dispositivo.', sentCount: 0 };
    }

    const payload = JSON.stringify({
        title: title || 'FolioTrack Alert',
        body: body || 'Nuovo aggiornamento disponibile',
        icon: '/logo.png',
        badge: '/logo_cropped.png',
        tag: (data && data.tag) || 'foliotrack-alert',
        timestamp: Date.now(),
        data: {
            url: '/dashboard',
            ...data
        }
    });

    let sentCount = 0;
    const pushOptions = {
        TTL: 86400, // 24 hours
        urgency: 'high'
    };

    for (const sub of subscriptions) {
        try {
            const pushConfig = JSON.parse(sub.subscription);
            await webpush.sendNotification(pushConfig, payload, pushOptions);
            sentCount++;
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                logger.info(`Push subscription ${sub.id} expired/invalid (status ${err.statusCode}), removing from database.`);
                database.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
            } else {
                logger.error(`Error sending push notification to sub ${sub.id}:`, err.message);
            }
        }
    }

    logger.info(`Sent push notification to ${sentCount}/${subscriptions.length} devices for user ${userId}.`);
    return { success: true, sentCount, totalSubs: subscriptions.length };
}

module.exports = {
    initVapid,
    getVapidPublicKey,
    sendPushNotification
};
