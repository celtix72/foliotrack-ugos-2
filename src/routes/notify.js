const express = require('express');
const { logger } = require('../utils/logger');
const { requireAuth } = require('../middlewares/authMiddleware');
const { notifyUser } = require('../services/notificationService');

// NOTE: sendStatusNotification is currently inside server.js. We need to 
// import it or extract it as well. For now, since we haven't extracted marketScraper, 
// we'll pass it or keep it simple.

const router = express.Router();

router.post('/test', requireAuth, async (req, res) => {
    const { event } = req.body;
    const userId = req.user.id;
    
    // For DAILY and STATUS, we would normally use real data.
    // However, sendStatusNotification is still in server.js.
    // This is just a test endpoint, so we can mock the payload or move sendStatusNotification later.
    
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

module.exports = router;
