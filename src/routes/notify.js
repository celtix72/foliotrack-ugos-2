const express = require('express');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        database,
        logger,
        notifyUser
    } = dependencies;

    // GET /api/notifications
    router.get('/', requireAuth, (req, res) => {
        try {
            const rows = database.db.prepare(`
                SELECT * FROM notifications 
                WHERE user_id = ?
                ORDER BY date DESC 
                LIMIT 50
            `).all(req.user.id);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/notifications/:id/read
    router.post('/:id/read', requireAuth, (req, res) => {
        try {
            database.db.prepare(`UPDATE notifications SET isRead = 1 WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/notifications/read-all
    router.post('/read-all', requireAuth, (req, res) => {
        try {
            database.db.prepare(`UPDATE notifications SET isRead = 1 WHERE user_id = ?`).run(req.user.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/notifications/:id
    router.delete('/:id', requireAuth, (req, res) => {
        try {
            database.db.prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/notifications
    router.delete('/', requireAuth, (req, res) => {
        try {
            database.db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(req.user.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/notify/test
    router.post('/test', requireAuth, async (req, res) => {
        const { event } = req.body;
        const userId = req.user.id;
        
        const testPayloads = {
            tp: {
                title: '🏆 TP: AAPL',
                body: '260.00 € (Tgt: 250.00)',
                telegramMessage: '*🎯 TARGET PROFIT*\n\nAsset: `AAPL`\nPrezzo: `€260.00`\nTarget: `€250.00`',
                data: { url: '/dashboard' }
            },
            sl: {
                title: '⚠️ SL: TSLA',
                body: '150.00 € (Soglia: 155.00)',
                telegramMessage: '*⚠️ STOP LOSS*\n\nAsset: `TSLA`\nPrezzo: `€150.00`\nSoglia: `€155.00`',
                data: { url: '/dashboard' }
            },
            vol: {
                title: 'ALLERTA VOLATILITÀ 📉',
                body: 'BTC-EUR variazione giornaliera: -8.5%',
                telegramMessage: '*📉 ALLERTA VOLATILITÀ*\n\nAsset: `BTC-EUR`\nVariazione: `-8.5%` (Soglia: 5%)',
                data: { url: '/dashboard' }
            },
            dividend: {
                title: 'DIVIDENDO RICEVUTO 💰',
                body: 'MSFT: +€12.50 (Netto)',
                telegramMessage: '*💰 DIVIDENDO RICEVUTO*\n\nAsset: `MSFT`\nImporto Netto: `€12.50`',
                data: { url: '/dividend' }
            },
            news: {
                title: 'News Alert: AAPL',
                body: 'Apple Inc. announces new AI features for iOS 20.',
                telegramMessage: '📰 *News Alert: AAPL*\n\nApple Inc\\. announces new AI features for iOS 20\\.\n\n[Leggi notizia completa](https://www.apple.com)',
                data: { url: 'https://www.apple.com' }
            },
            status: {
                title: '🔔 OpenUE • NET €150.0K +€320',
                body: '🟢 ETF +€180\n🟢 AZI +€140\n🏆 ENEL +€95',
                telegramMessage: '*🔔 OPENUE*\n\n`NET. :` `€150.000`\n\n*🟢* *`ETF AZ       +€180`*  *`(+€0)`*\n*🔵* *`AZIONI       +€140`*  *`(+€0)`*\n\n🕒 `09:05`',
                data: { url: '/dashboard' }
            },
            daily: {
                title: '📊 Daily • NET €150.0K +€450',
                body: '🟢 ETF +€250\n🟢 AZI +€200\n🏆 ENEL +€120',
                telegramMessage: '*📊 DAILY REPORT*\n\n`NET. :` `€150.000` (+€450)',
                data: { url: '/dashboard' }
            }
        };

        const payload = testPayloads[event] || { 
            title: 'FolioTracker TEST 🚀', 
            body: 'Se ricevi questo messaggio, il sistema di notifiche è configurato correttamente!' 
        };

        try {
            await notifyUser(userId, event || 'STATUS', payload, true); // true = force send
            res.json({ success: true });
        } catch (err) {
            logger.error(`Test notification failed for ${event}`, err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
