const express = require('express');
const database = require('../db');
const { logger } = require('../utils/logger');
const { requireAuth } = require('../middlewares/authMiddleware');
const { getVapidPublicKey, sendPushNotification } = require('../services/pushService');

const router = express.Router();

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', requireAuth, (req, res) => {
    const pubKey = getVapidPublicKey();
    if (!pubKey) return res.status(500).json({ error: 'VAPID keys not configured' });
    res.json({ publicKey: pubKey });
});

// POST /api/push/subscribe
router.post('/subscribe', requireAuth, (req, res) => {
    const { subscription, device_name } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription data required' });

    try {
        const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
        const endpoint = (subscription && subscription.endpoint) || (typeof subscription === 'string' ? JSON.parse(subscription).endpoint : '') || '';
        
        // Remove existing subscriptions for this endpoint to avoid duplicates
        if (endpoint) {
            database.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
        }
        
        database.db.prepare(`
            INSERT INTO push_subscriptions (user_id, subscription, endpoint, device_name)
            VALUES (?, ?, ?, ?)
        `).run(req.user.id, subStr, endpoint, device_name || req.headers['user-agent'] || 'Browser');
        
        logger.info(`Saved push subscription for user ${req.user.id}`);
        res.json({ ok: true, success: true });
    } catch (e) {
        logger.error('Failed to save push subscription', e);
        res.status(500).json({ error: 'Database error: ' + e.message });
    }
});

// POST /api/push/unsubscribe
router.post('/unsubscribe', requireAuth, (req, res) => {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription data required' });

    try {
        const endpoint = (subscription && subscription.endpoint) || (typeof subscription === 'string' ? JSON.parse(subscription).endpoint : '') || '';
        const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
        if (endpoint) {
            database.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
        } else {
            database.db.prepare(`
                DELETE FROM push_subscriptions WHERE user_id = ? AND subscription = ?
            `).run(req.user.id, subStr);
        }
        res.json({ success: true, ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

// POST /api/push/test
router.post('/test', requireAuth, async (req, res) => {
    try {
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
        logger.error('Push test route failed:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
