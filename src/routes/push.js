const express = require('express');
const database = require('../db');
const { logger } = require('../utils/logger');
const { requireAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', requireAuth, (req, res) => {
    const pubKey = process.env.VAPID_PUBLIC_KEY;
    if (!pubKey) return res.status(500).json({ error: 'VAPID keys not configured' });
    res.json({ publicKey: pubKey });
});

// POST /api/push/subscribe
router.post('/subscribe', requireAuth, (req, res) => {
    const { subscription, device_name } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription data required' });

    try {
        const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
        const endpoint = subscription.endpoint || '';
        
        // Remove existing subscriptions for this endpoint to avoid duplicates
        database.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
        
        database.db.prepare(`
            INSERT INTO push_subscriptions (user_id, subscription, endpoint, device_name)
            VALUES (?, ?, ?, ?)
        `).run(req.user.id, subStr, endpoint, device_name || req.headers['user-agent']);
        
        res.json({ ok: true });
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
        const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
        database.db.prepare(`
            DELETE FROM push_subscriptions WHERE user_id = ? AND subscription = ?
        `).run(req.user.id, subStr);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
