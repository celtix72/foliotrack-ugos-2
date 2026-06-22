const axios = require('axios');
const https = require('https');
const database = require('../db');
const { logger, telegramLogger, getLastLogLines, LOG_FILE } = require('../utils/logger');
const { APP_VERSION } = require('../utils/version');

function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

async function sendTelegramMessage(message, customChatId = null, userId = null) {
    const settings = database.getSettings(userId || 1); // Fallback to admin settings if no user
    const token = settings.telegramBotToken;
    const chatId = customChatId || settings.telegramChatId;
    const enabled = settings.telegramEnabled === 'true';

    telegramLogger.log(`[ATTEMPT] User: ${userId}, Enabled: ${enabled}, Token set: ${!!token}, ChatID set: ${!!chatId}, Custom: ${!!customChatId}`);

    if (!enabled || !token || !chatId) {
        if (!enabled) telegramLogger.log(`[SKIPPED] Telegram is disabled for user ${userId}.`);
        else telegramLogger.log(`[SKIPPED] Missing Token or ChatID for user ${userId}.`);
        return;
    }

    const payload = {
        chat_id: chatId,
        text: message, // Caller must ensure it is properly escaped for MarkdownV2
        parse_mode: 'MarkdownV2',
        disable_notification: false
    };

    const data = JSON.stringify(payload);

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (d) => body += d);
            res.on('end', () => {
                telegramLogger.log(`[RESPONSE] Status: ${res.statusCode}, Body: ${body}`);
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.ok) resolve(parsed);
                    else {
                        logger.error(`Telegram API error: ${parsed.description}`);
                        reject(new Error(parsed.description));
                    }
                } catch (e) {
                    telegramLogger.log(`[PARSE ERROR] Body: ${body}`);
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            telegramLogger.log(`[REQ ERROR] ${e.message}`);
            logger.error(`Telegram request error: ${e.message}`);
            reject(e);
        });

        req.write(data);
        req.end();
    });
}

async function processTelegramCommand(message) {
    const text = (message.text || '').trim();
    const chatId = message.chat.id;
    const user = database.db.prepare(`SELECT * FROM users WHERE telegram_chat_id = ?`).get(String(chatId));
    
    if (!user) {
        telegramLogger.log(`[SECURITY] Ignored message from unauthorized chat: ${chatId}`);
        return;
    }

    const cmd = text.split(' ')[0].toLowerCase().replace('/', '');
    telegramLogger.log(`[COMMAND] Received: ${cmd}`);

    switch (cmd) {
        case 'help':
        case 'aiuto': {
            const helpMsg = `${escapeV2('ℹ️')} *${escapeV2('Comandi Disponibili')}*\n\n` +
                          `• \`HELP\`: Mostra questo messaggio\n` +
                          `• \`Version\`: Mostra la versione dell'app\n` +
                          `• \`Log\`: Restituisce le ultime 100 righe di log\n`;
            await sendTelegramMessage(helpMsg, null, user.id);
            break;
        }
        case 'version':
        case 'versione': {
            const verMsg = `${escapeV2('🚀')} *${escapeV2('Versione Applicazione')}*\n\n` +
                         `Versione attuale: \`${escapeCodeV2(APP_VERSION)}\``;
            await sendTelegramMessage(verMsg, null, user.id);
            break;
        }
        case 'log':
        case 'logs': {
            const logContent = getLastLogLines(LOG_FILE, 100);
            const header = `${escapeV2('📄')} *${escapeV2('Ultimi Log (100 righe)')}*\n\n`;
            
            const maxLogLen = 3500;
            let finalLog = logContent;
            if (finalLog.length > maxLogLen) {
                finalLog = '... [troncato] ...\n' + finalLog.substring(finalLog.length - maxLogLen);
            }

            const msg = header + `\`\`\`\n${escapeCodeV2(finalLog)}\n\`\`\``;
            await sendTelegramMessage(msg, null, user.id);
            break;
        }
    }
}

let telegramPollingActive = false;
async function startTelegramPolling() {
    if (telegramPollingActive) return;
    telegramPollingActive = true;
    
    telegramLogger.log('[SERVICE] Telegram polling started.');

    while (true) {
        const settings = database.getSettings(1); // Use admin settings for global polling
        const token = settings.telegramBotToken;
        const enabled = settings.telegramEnabled === 'true';

        if (!enabled || !token) {
            await new Promise(r => setTimeout(r, 30000));
            continue;
        }

        try {
            let lastUpdateId = parseInt(settings.telegramLastUpdateId || '0');
            const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
            
            const response = await axios.get(url, { timeout: 30000 });
            const data = response.data;

            if (data.ok && data.result.length > 0) {
                for (const update of data.result) {
                    if (update.message) {
                        await processTelegramCommand(update.message);
                    }
                    lastUpdateId = update.update_id;
                }
                database.setSetting(1, 'telegramLastUpdateId', lastUpdateId);
            }
        } catch (e) {
            telegramLogger.log(`[POLLING ERROR] ${e.message}`);
            await new Promise(r => setTimeout(r, 10000));
        }
        
        await new Promise(r => setTimeout(r, 2000));
    }
}

module.exports = {
    sendTelegramMessage,
    startTelegramPolling,
    escapeV2,
    escapeCodeV2
};
