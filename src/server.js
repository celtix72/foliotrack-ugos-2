'use strict';

const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const dotenv       = require('dotenv');
const YahooFinance = require('yahoo-finance2').default;
const axios        = require('axios');
const fs           = require('fs');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const webpush      = require('web-push');
const { xirr, calculateTWR } = require('./utils/finance');
const Parser = require('rss-parser');
const rssParser = new Parser();

// ─── Application Version ─────────────────────────────────────────────────────
const now = new Date();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const hour = String(now.getHours()).padStart(2, '0');
const min = String(now.getMinutes()).padStart(2, '0');
const APP_VERSION = `v.${month}${day}${hour}:${min}`;

/**
 * Standard ROI calculation used across the app.
 * @param {number} value - Current value (NAV).
 * @param {number} netDeposits - Cumulative net deposits.
 * @param {number} profit - Total profit (including dividends).
 * @returns {number} ROI as a decimal.
 */
function calculateROI(value, netDeposits, profit) {
    if (netDeposits > 0) return (value / netDeposits) - 1;
    // Fallback if netDeposits is 0 or negative (e.g. only profits remain after withdrawals)
    const costBasis = value - profit;
    if (costBasis > 0) return (value / costBasis) - 1;
    return 0;
}

const LOGS_DIR = path.join(__dirname, '../logs');
const LOG_FILE = path.join(LOGS_DIR, 'app.log');
const TELEGRAM_LOG_FILE = path.join(LOGS_DIR, 'telegram.log');

// Daily-rotating log helper
function getRotatedLogFile(date) {
    const d = date || new Date();
    const key = d.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `app-${key}.log`);
}

function writeLog(level, msg) {
    const ts = new Date();
    const line = `${ts.toISOString()} [${level}] ${msg}\n`;
    // Write to today's rotated file
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        fs.appendFileSync(getRotatedLogFile(ts), line);
        fs.appendFileSync(LOG_FILE, line);
        // Trim master log to last 50000 lines to avoid unbounded growth
        try {
            const raw = fs.readFileSync(LOG_FILE, 'utf8');
            const lines = raw.split('\n');
            if (lines.length > 50000) {
                fs.writeFileSync(LOG_FILE, lines.slice(-40000).join('\n') + '\n');
            }
        } catch(_) {}
    } catch(e) { /* ignore if fs not available */ }
}

const logger = {
    info: (msg) => {
        const line = `${new Date().toISOString()} [INFO] ${msg}\n`;
        process.stdout.write(line);
        writeLog('INFO', msg);
    },
    error: (msg, err) => {
        let errStr = err;
        if (err) {
            if (err.message) errStr = err.message;
            else if (typeof err === 'object') {
                try { errStr = JSON.stringify(err); } catch(e) { errStr = String(err); }
            }
        }
        const errMsg = errStr ? ` - ${errStr}` : '';
        const line = `${new Date().toISOString()} [ERROR] ${msg}${errMsg}\n`;
        process.stderr.write(line);
        writeLog('ERROR', `${msg}${errMsg}`);
    },
    warn: (msg) => {
        const line = `${new Date().toISOString()} [WARN] ${msg}\n`;
        process.stdout.write(line);
        writeLog('WARN', msg);
    }
};

const telegramLogger = {
    log: (msg) => {
        const ts = new Date().toISOString();
        const line = `${ts} ${msg}\n`;
        try {
            if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
            fs.appendFileSync(TELEGRAM_LOG_FILE, line);
            // Limit to 5000 lines
            const raw = fs.readFileSync(TELEGRAM_LOG_FILE, 'utf8');
            const lines = raw.split('\n');
            if (lines.length > 5000) {
                fs.writeFileSync(TELEGRAM_LOG_FILE, lines.slice(-4000).join('\n') + '\n');
            }
        } catch (e) { /* ignore */ }
    }
};

dotenv.config();

// ─── Web Push Setup ──────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@foliotrack.io';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    logger.warn('Web Push VAPID keys not fully configured. Push notifications will not work.');
}

const https = require('https');

// ─── Telegram Utility ────────────────────────────────────────────────────────
function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    // MarkdownV2 requires escaping these characters outside of pre/code spans
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Helper to escape text specifically for code blocks in MarkdownV2.
 * In code blocks, only \ and ` need escaping.
 */
function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

/**
 * Efficiently reads the last N lines from a file.
 */
function getLastLogLines(filePath, lineCount = 100) {
    try {
        if (!fs.existsSync(filePath)) return `File non trovato: ${filePath}`;
        const stats = fs.statSync(filePath);
        const bufferSize = 1024 * 64; // 64KB chunks
        const buffer = Buffer.alloc(bufferSize);
        let lines = [];
        let pos = stats.size;
        let fd = fs.openSync(filePath, 'r');

        try {
            while (pos > 0 && lines.length <= lineCount) {
                const readSize = Math.min(pos, bufferSize);
                pos -= readSize;
                fs.readSync(fd, buffer, 0, readSize, pos);
                const chunk = buffer.slice(0, readSize).toString('utf8');
                const chunkLines = chunk.split('\n');
                
                if (lines.length > 0 && chunk[chunk.length - 1] !== '\n') {
                    // Prepend first line of 'lines' to the last line of 'chunkLines'
                    chunkLines[chunkLines.length - 1] += lines[0];
                    lines.shift();
                }
                lines = chunkLines.concat(lines);
            }
        } finally {
            fs.closeSync(fd);
        }

        return lines.slice(-(lineCount + 1)).join('\n').trim();
    } catch (e) {
        return `Errore durante la lettura dei log: ${e.message}`;
    }
}

/**
 * Handles processing of a single Telegram message command.
 */
async function processTelegramCommand(message) {
    const text = (message.text || '').trim();
    const chatId = message.chat.id;
    const user = database.db.prepare(`SELECT * FROM users WHERE telegram_chat_id = ?`).get(String(chatId));
    
    if (!user) {
        telegramLogger.log(`[SECURITY] Ignored message from unauthorized chat: ${chatId}`);
        return;
    }

    const settings = database.getSettings(user.id);

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
            
            // Telegram messages are limited to 4096 chars. Truncate if needed.
            // We use a code block for the log content.
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

/**
 * Background loop to poll for Telegram updates.
 */
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
            await new Promise(r => setTimeout(r, 30000)); // Sleep longer if disabled
            continue;
        }

        try {
            let lastUpdateId = parseInt(settings.telegramLastUpdateId || '0');
            const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
            
            // Note: Using a longer timeout for long polling if possible, 
            // but here we use a standard axios get with a reasonable house-keeping loop.
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
            // Wait a bit before retrying on error
            await new Promise(r => setTimeout(r, 10000));
        }
        
        await new Promise(r => setTimeout(r, 2000)); // Small delay between polls
    }
}


function formatMarketValueV2(value) {
    const num = Number(value);
    if (isNaN(num)) return '0.0';
    if (num > 100) return num.toFixed(1);
    if (num >= 10) return num.toFixed(2);
    if (num >= 1) return num.toFixed(3);
    return num.toFixed(4);
}

function formatVariationV2(value, isPercent = false) {
    const sign = value >= 0 ? '+' : '-';
    const absValue = Math.abs(value);
    if (isPercent) {
        return `${sign}${absValue.toFixed(2)}%`;
    }
    return `${sign}€${absValue.toFixed(0)}`;
}

function getPerformanceIcon(changePct) {
    if (changePct >= 5) return '🚀';
    if (changePct >= 2) return '💰';
    if (changePct >= 1) return '✅';
    if (changePct > 0) return '📈';
    if (changePct === 0) return '⚪';
    if (changePct >= -1) return '📉';
    if (changePct >= -3) return '💣';
    if (changePct > -6) return '💀';
    return '❌';
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
        telegramLogger.log(`[SENDING] Payload: ${data}`);
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

function getNetDeposits(portfolioId) {
    const row = database.db.prepare(`
        SELECT 
            SUM(CASE WHEN type IN ('DEPOSIT', 'BUY') THEN amount ELSE 0 END) -
            SUM(CASE WHEN type IN ('WITHDRAWAL', 'TRANSFER', 'SELL') THEN amount ELSE 0 END) as net
        FROM transactions 
        WHERE portfolioId = ?
    `).get(portfolioId);
    // Note: BUY/SELL amount already includes commissions/taxes if 'amount' is set, 
    // but here we want to know how much cash the user PUT IN vs TOOK OUT.
    // Actually simpler: Net Deposits = SUM(DEPOSIT) - SUM(WITHDRAWAL/TRANSFER)
    const simpleNet = database.db.prepare(`
        SELECT 
            SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) -
            SUM(CASE WHEN type IN ('WITHDRAWAL', 'TRANSFER') THEN amount ELSE 0 END) as net
        FROM transactions 
        WHERE portfolioId = ?
    `).get(portfolioId);
    return simpleNet ? (simpleNet.net || 0) : 0;
}

async function calculateMarketStats(userId) {
    if (!userId) return { totalNetValue: 0, totalChange: 0, totalChangePercent: 0, assets: [] };
    try {
        const liveRate = await getEurUsdRate();
        const stats = await getAllPortfolioStats(userId, liveRate);
        const assets = database.db.prepare(`
            SELECT a.*, 
                   IFNULL(h.netQty, 0) as netQty,
                   CASE WHEN uw.ticker IS NOT NULL THEN 1 ELSE 0 END as inWatchlist
            FROM assets a
            LEFT JOIN (
                SELECT t.assetTicker, 
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as netQty 
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ?
                GROUP BY t.assetTicker
            ) h ON a.ticker = h.assetTicker
            LEFT JOIN user_watchlist uw ON a.ticker = uw.ticker AND uw.user_id = ?
            WHERE h.netQty > 0.001 OR uw.ticker IS NOT NULL
        `).all(userId, userId);

        return {
            totalNetValue: stats.totalNetValue,
            totalChange: stats.totalChange,
            totalChangePercent: stats.changePercent,
            liveRate: liveRate,
            individualPortfolios: stats.portfolios || [], // Added to support granular push info
            assets: assets.map(a => ({
                ticker: a.ticker,
                name: a.name,
                type: a.type,
                currentPrice: a.currentPrice,
                changePercent: a.changePercent,
                preMarketChangePercent: a.preMarketChangePercent,
                quoteDate: a.quoteDate,
                currency: a.currency,
                quantity: a.netQty,
                value: (a.currentPrice * a.netQty) / (a.currency === 'USD' ? liveRate : 1),
                inWatchlist: a.inWatchlist === 1
            }))
        };
    } catch (err) {
        logger.error('calculateMarketStats error', err);
        return { totalNetValue: 0, totalChange: 0, totalChangePercent: 0, assets: [] };
    }
}

// Helper functions from v33.11 for Rich Formatting
function getPerformanceIcon(changePct) {
    if (changePct >= 5) return '🚀';
    if (changePct >= 2) return '💰';
    if (changePct >= 1) return '✅';
    if (changePct > 0) return '📈';
    if (changePct === 0) return '⚪';
    if (changePct >= -1) return '📉';
    if (changePct >= -3) return '💣';
    if (changePct > -6) return '💀';
    return '❌';
}

function getBigEmoji(val) {
    const abs = Math.abs(val);
    if (val > 0) {
        if (abs < 300) return '🟢';
        if (abs < 1000) return '💰';
        return '🚀';
    } else if (val < 0) {
        if (abs < 300) return '🔴';
        if (abs < 1000) return '💣';
        return '☠️';
    }
    return '⚪';
}

// Helper for market detection (global)
const isUSMarket = (a) => {
    const ticker = a.ticker || '';
    const type = a.type || '';
    const isin = a.isin || '';
    // 1. ISIN prefix is the most reliable (US...)
    if (isin.startsWith('US')) return true;
    if (isin.startsWith('IT') || isin.startsWith('IE') || isin.startsWith('LU') || isin.startsWith('DE')) return false;
    // 2. Tickers with dots (.MI, .DE, .AS, etc.) are European/Other
    if (ticker.includes('.')) return false;
    // 3. Bonds and Bond ETFs in this portfolio are primarily European/BTM
    if (type.includes('Bond') || type.includes('Obblig')) return false;
    // 4. Fallback for tickers without dots (AAPL, MSFT) to US
    return true;
};

async function sendStatusNotification(targetUserId = null, eventType = 'STATUS', preCalculatedStats = null) {
    const users = targetUserId 
        ? database.db.prepare(`SELECT id FROM users WHERE id = ?`).all(targetUserId)
        : database.db.prepare(`SELECT id FROM users WHERE telegram_chat_id IS NOT NULL`).all();

    for (const userRow of users) {
        const userId = userRow.id;
        const userSettings = database.getSettings(userId);
        
        // Skip if not forced and disabled for this user
        if (!targetUserId && userSettings.marketStatusTelegramEnabled !== 'true') continue;

        try {
            const escape = escapeV2;
            const stats = preCalculatedStats || await calculateMarketStats(userId);
            const marketStatus = getMarketStatus();
            const overrides = calculateVariationOverrides(marketStatus);

            // 1. FILTERING: Include all assets with open positions
            const activeAssets = stats.assets.filter(a => a.value >= 1);
            if (activeAssets.length === 0) continue;

            const extractSimpleSymbol = (s) => s.split('.')[0].split(':')[0].substring(0, 8);

            const categories = {
                'OBBL': { emoji: '🟠', assets: [], totalVar: 0, totalVarPP: 0 },
                'ETF OBBL': { emoji: '🟣', assets: [], totalVar: 0, totalVarPP: 0 },
                'AZIONI': { emoji: '🔵', assets: [], totalVar: 0, totalVarPP: 0 },
                'ETF AZ': { emoji: '🟢', assets: [], totalVar: 0, totalVarPP: 0 }
            };

            const typeToCat = {
                'Bond': 'OBBL',
                'ETF Obblig': 'OBBL',
                'ETF Monetario': 'ETF OBBL',
                'Deposito Vincolato': 'ETF OBBL',
                'Azioni': 'AZIONI',
                'ETF Azionario': 'ETF AZ'
            };

            let marketChange = 0;
            let prePostChange = 0;

            activeAssets.forEach(a => {
                const catName = typeToCat[a.type] || 'AZIONI';
                const ticker = a.ticker;
                
                let diffReg = 0;
                let diffPP = 0;

                if (overrides.regular && overrides.regular.hasOwnProperty(ticker)) {
                    diffReg = (a.quantity || 0) * overrides.regular[ticker];
                    if (a.currency === 'USD') diffReg /= stats.liveRate;
                }
                if (overrides.prePost && overrides.prePost.hasOwnProperty(ticker)) {
                    diffPP = (a.quantity || 0) * overrides.prePost[ticker];
                    if (a.currency === 'USD') diffPP /= stats.liveRate;
                }

                marketChange += diffReg;
                prePostChange += diffPP;
                
                if (categories[catName]) {
                    categories[catName].assets.push({ ...a, diffReg, diffPP });
                    categories[catName].totalVar += diffReg;
                    categories[catName].totalVarPP += diffPP;
                } else {
                    categories['AZIONI'].assets.push({ ...a, diffReg, diffPP });
                    categories['AZIONI'].totalVar += diffReg;
                    categories['AZIONI'].totalVarPP += diffPP;
                }
            });

            const totalVal = stats.totalNetValue || 0;
            const bigEmoji = getBigEmoji(marketChange + prePostChange);
            
            const tSign = marketChange >= 0 ? '+' : '';
            let msg = `*${eventType === 'DAILY' ? '📊 DAILY REPORT' : '📈 MARKET STATUS'}*\n\n`;
            const totalValStr = Math.round(totalVal).toLocaleString('it-IT');
            msg += `${escapeV2('NET. :')} \`${escapeCodeV2('€' + totalValStr)}\` \n\n`;

            for (const [catName, cat] of Object.entries(categories)) {
                if (cat.assets.length === 0) continue;
                const catPPSign = cat.totalVarPP >= 0 ? '+' : '';
                const catVarStr = Math.round(cat.totalVar).toLocaleString('it-IT');
                const catVarPPStr = Math.round(cat.totalVarPP).toLocaleString('it-IT');
                msg += `*${cat.emoji}* *\`${escapeCodeV2(catName.padEnd(12) + (cat.totalVar >= 0 ? '+' : '') + '€' + catVarStr)}\`*  *\`(${catPPSign + '€' + catVarPPStr})\`*\n`;
                
                cat.assets.sort((a,b) => (b.diffReg + b.diffPP) - (a.diffReg + a.diffPP)).forEach(a => {
                    const combinedPct = a.changePercent + (a.preMarketChangePercent || a.postMarketChangePercent || 0);
                    const mktStatus = marketStatus[isUSMarket(a) ? 'US' : 'EU'];
                    const statusIcon = mktStatus ? (a.diffReg >= 0 ? '🟢' : '🔴') : (a.diffPP !== 0 ? '🟡' : '🔘');
                    const rowData = `${extractSimpleSymbol(a.ticker).padEnd(8)}${(a.currency === 'USD' ? '$' : '€').padStart(2)} ${a.currentPrice.toLocaleString('it-IT', { minimumFractionDigits: a.currentPrice < 10 ? 2 : 1, maximumFractionDigits: a.currentPrice < 10 ? 2 : 1 }).padStart(6)} ${(a.diffReg >= 0 ? '+' : '-') + '€' + Math.round(Math.abs(a.diffReg)).toLocaleString('it-IT').padStart(7)} ${(combinedPct >= 0 ? '+' : '') + Math.abs(combinedPct).toFixed(1) + '%'}`;
                    msg += `${getPerformanceIcon(combinedPct)} \`${escapeCodeV2(rowData)}\` ${statusIcon}\n`;
                });
                msg += '\n';
            }
            
            const tsFormatted = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' ' + 
                               new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            msg += `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\` · \`${escapeCodeV2(APP_VERSION)}\``;

            // Compact Push Notification Body for iOS
            const totalVarEUR = (stats.totalChange || 0) + (stats.totalChangePrePost || 0);
            const totalVarStr = (totalVarEUR >= 0 ? '+' : '') + '€' + Math.round(totalVarEUR).toLocaleString('it-IT');
            const abbreviatedNet = (totalVal / 1000).toFixed(1) + 'K';

            // First line (NET) becomes the Title for maximum compactness
            const pushTitle = `NET: ${abbreviatedNet} (${totalVarStr})`;
            
            // Portfolios for the body: those with variation > 0 (positive or negative)
            let portfoliosForPush = [];
            if (stats.individualPortfolios && stats.individualPortfolios.length > 0) {
                // Sort by absolute EUR variation descending to show most significant moves first
                const sorted = [...stats.individualPortfolios].sort((a, b) => Math.abs(b.changeValueEUR || 0) - Math.abs(a.changeValueEUR || 0));
                
                // Take those with variation != 0, ensuring at least 2 if available
                portfoliosForPush = sorted.filter((p, index) => index < 2 || Math.abs(p.changeValueEUR || 0) >= 0.01);
            }

            let pushBody = '';
            portfoliosForPush.forEach(p => {
                const icon = (p.changeValueEUR || 0) >= 0 ? '🟢' : '🔴';
                const shortName = (p.name || '???').substring(0, 3).toUpperCase();
                const pVarStr = (p.changeValueEUR >= 0 ? '+' : '') + '€' + Math.round(Math.abs(p.changeValueEUR)).toLocaleString('it-IT');
                pushBody += `${icon} ${shortName} (${pVarStr})\n`;
            });

            // Find Top and Worst asset by value delta
            let topAsset = null;
            let worstAsset = null;
            let maxDelta = -Infinity;
            let minDelta = Infinity;

            // Actually, let's just find them from all assets in categories
            for (const cat of Object.values(categories)) {
                cat.assets.forEach(a => {
                    const delta = (a.diffReg || 0) + (a.diffPP || 0);
                    if (delta > maxDelta) { maxDelta = delta; topAsset = a; }
                    if (delta < minDelta) { minDelta = delta; worstAsset = a; }
                });
            }

            if (topAsset && maxDelta > 0) {
                pushBody += `🏆 ${topAsset.ticker} (+€${Math.round(maxDelta).toLocaleString('it-IT')})\n`;
            }
            if (worstAsset && minDelta < 0) {
                pushBody += `📉 ${worstAsset.ticker} (-€${Math.round(Math.abs(minDelta)).toLocaleString('it-IT')})\n`;
            }

            notifyUser(userId, eventType, {
                title: pushTitle,
                body: pushBody.trim(),
                telegramMessage: msg,
                data: { url: '/dashboard' }
            });

        } catch (err) {
            logger.error(`sendStatusNotification failed for user ${userId}`, err);
        }
    }
}

async function sendTelegramDailyReport() {
    await sendMarketStatusTelegram(); // Unify with the new requested format
}

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const database = require('./db');
const backupManager = require('./backup_manager');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// Nodemailer setup
let transporterInstance = null;
function getTransporter() {
    if (transporterInstance) return transporterInstance;
    const settings = database.getSettings(1); // Use admin settings for SMTP
    const smtpHost = settings.smtp_host || process.env.SMTP_HOST || 'smtp.ethereal.email';
    const smtpPort = parseInt(settings.smtp_port) || parseInt(process.env.SMTP_PORT) || 587;
    const smtpUser = settings.smtp_user || process.env.SMTP_USER || '';
    const smtpPass = settings.smtp_pass || process.env.SMTP_PASS || '';
    const smtpFrom = settings.smtp_from || process.env.SMTP_FROM || smtpUser || 'noreply@foliotrack.com';
    
    transporterInstance = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
            user: smtpUser,
            pass: smtpPass
        }
    });
    // Add the from address to the instance for easy access
    transporterInstance.defaultFrom = smtpFrom;
    return transporterInstance;
}

// ─── Security Helpers ────────────────────────────────────────────────────────
function logAudit(userId, action, details, req) {
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ua = req.headers['user-agent'];
        database.db.prepare(`
            INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, action, typeof details === 'string' ? details : JSON.stringify(details), ip, ua);
    } catch (e) {
        logger.error(`[AUDIT] Failed to log ${action}: ${e.message}`);
    }
}


// ─── JWT / Auth configuration ─────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'foliotrack_secret_development_static_12345';
if (!process.env.JWT_SECRET) {
    console.warn('\x1b[31m%s\x1b[0m', 'CRITICAL SECURITY WARNING: JWT_SECRET is not set. Using default development secret!');
}
const JWT_COOKIE = 'ft_token';
const JWT_EXPIRY = '7d';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Auth Middleware ─────────────────────────────────────────────────────────

/**
 * Verifies JWT from cookie or Authorization header.
 * Attaches req.user = { id, username, role, display_name } on success.
 */
function requireAuth(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    
    const token = req.cookies[JWT_COOKIE] || (req.headers.authorization || '').replace('Bearer ', '');
    const isApi = req.originalUrl.startsWith('/api/');

    if (!token) {
        if (isApi) return res.status(401).json({ error: 'Non autenticato' });
        return res.redirect('/login');
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Session Check
        if (decoded.sid) {
            const session = database.db.prepare('SELECT id FROM user_sessions WHERE session_id = ?').get(decoded.sid);
            if (!session) {
                res.clearCookie(JWT_COOKIE);
                if (isApi) return res.status(401).json({ error: 'Sessione revocata o scaduta' });
                return res.redirect('/login?error=session_revoked');
            }
            // Update last seen
            database.db.prepare("UPDATE user_sessions SET last_seen = datetime('now') WHERE session_id = ?").run(decoded.sid);
        }

        req.user = decoded;
        next();
    } catch (e) {
        if (isApi) return res.status(401).json({ error: 'Token non valido o scaduto' });
        return res.redirect('/login');
    }
}


/**
 * Requires admin role after requireAuth.
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        if (req.accepts('html')) return res.redirect('/dashboard');
        return res.status(403).json({ error: 'Accesso negato: richiesto ruolo admin' });
    }
    next();
}

/**
 * Ensures the authenticated user has access to the portfolio.
 * Looks for portfolioId in req.params or req.body.
 */
function requirePortfolioAccess(req, res, next) {
    const portfolioId = req.params.portfolioId || req.params.id || req.body.portfolioId;
    if (!portfolioId) return next();

    try {
        const access = database.db.prepare('SELECT 1 FROM portfolio_users WHERE portfolio_id = ? AND user_id = ?').get(portfolioId, req.user.id);
        if (!access && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Accesso negato a questo portafoglio' });
        }
        next();
    } catch (e) {
        res.status(500).json({ error: 'Errore verifica permessi' });
    }
}

// ─── Auth API Routes ─────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username e password obbligatori' });
    }
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Brute force protection
    const settings = database.getSettings(1);
    const maxAttempts = parseInt(settings.auth_max_attempts || '5');
    const banMinutes = parseInt(settings.auth_ban_duration_minutes || '30');
    
    const failures = database.getLoginFailures(ip);
    if (failures.banned_until && new Date(failures.banned_until) > new Date()) {
        return res.status(403).json({ error: `Troppi tentativi falliti. IP bannato fino a: ${new Date(failures.banned_until).toLocaleString()}` });
    }

    const user = database.verifyUser(username, password);
    if (!user) {
        database.recordLoginFailure(ip, maxAttempts, banMinutes);
        logAudit(null, 'LOGIN_FAIL', { username }, req);
        return res.status(401).json({ error: 'Credenziali non valide' });
    }

    // Success: reset failures
    database.resetLoginFailures(ip);

    if (user.must_change_password === 1) {
        return res.json({ ok: false, require_password_change: true, user_id: user.id });
    }

    // Create session
    const sid = crypto.randomBytes(16).toString('hex');
    const ua = req.headers['user-agent'];
    database.db.prepare('INSERT INTO user_sessions (user_id, session_id, ip_address, user_agent) VALUES (?, ?, ?, ?)').run(user.id, sid, ip, ua);

    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, display_name: user.display_name, sid: sid },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
    res.cookie(JWT_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
    });
    
    logAudit(user.id, 'LOGIN_SUCCESS', { role: user.role }, req);
    logger.info(`[AUTH] Login: ${user.username} (${user.role})`);
    return res.json({ ok: true, user: { username: user.username, email: user.email, role: user.role, display_name: user.display_name } });
});

// ─── Web Push API Routes ─────────────────────────────────────────────────────

// GET /api/push/vapid-public-key
app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
    const pubKey = process.env.VAPID_PUBLIC_KEY;
    if (!pubKey) return res.status(500).json({ error: 'VAPID keys not configured' });
    res.json({ publicKey: pubKey });
});

// POST /api/push/subscribe
app.post('/api/push/subscribe', requireAuth, (req, res) => {
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
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
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

app.post('/api/notify/test', requireAuth, async (req, res) => {
    const { event } = req.body;
    const userId = req.user.id;
    
    // For DAILY and STATUS, use real data generation to verify the format
    if (event === 'daily' || event === 'status') {
        try {
            await sendStatusNotification(userId, event.toUpperCase());
            return res.json({ success: true });
        } catch (err) {
            logger.error(`Test notification failed for ${event}`, err);
            return res.status(500).json({ error: err.message });
        }
    }
    
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

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies[JWT_COOKIE];
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.sid) {
                database.db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(decoded.sid);
            }
        } catch (e) {}
    }
    res.clearCookie(JWT_COOKIE);
    return res.json({ ok: true });
});


// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
    const dbUser = database.db.prepare('SELECT id, username, email, role, display_name, must_change_password FROM users WHERE id = ?').get(req.user.id);
    if (!dbUser) return res.status(404).json({ error: 'Utente non trovato' });
    return res.json({ user: dbUser });
});

// GET /api/auth/permissions
app.get('/api/auth/permissions', requireAuth, (req, res) => {
    try {
        const perms = database.getUserPermissions(req.user.role);
        res.json({ permissions: perms });
    } catch (e) {
        logger.error(`[AUTH] Error fetching permissions: ${e.message}`);
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
    const { username, email } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username ed email obbligatori' });
    
    const existing = database.db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) return res.status(409).json({ error: 'Username o email già in uso' });

    const generatedPassword = crypto.randomBytes(6).toString('hex'); // 12 chars

    try {
        const user = database.createUser(username, generatedPassword, email, 'free', username, 1);
        
        const mailer = getTransporter();
        await mailer.sendMail({
            from: `"M2T Portfolio" <${mailer.defaultFrom}>`,
            to: email,
            subject: 'Il tuo nuovo account M2T Tracker',
            text: `Benvenuto ${username},\n\nIl tuo account è stato creato.\nLa tua password temporanea è: ${generatedPassword}\n\nTi verrà chiesto di cambiarla al primo accesso.\nQuesta password è valida per 24 ore.`
        });

        logger.info(`[AUTH] Registered new user: ${username}`);
        res.json({ ok: true, message: 'Account creato. Controlla l\'email per la password.' });
    } catch (e) {
        logger.error(`[AUTH] Registration error: ${e.message}`);
        res.status(500).json({ error: 'Errore durante la registrazione' });
    }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', async (req, res) => {
    const { user_id, current_password, new_password } = req.body;
    if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'La nuova password deve essere di almeno 4 caratteri' });

    let userId = user_id;
    // se è loggato, usiamo il suo id
    const token = req.cookies[JWT_COOKIE] || (req.headers.authorization || '').replace('Bearer ', '');
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            userId = decoded.id;
        } catch (e) {}
    }

    if (!userId) return res.status(401).json({ error: 'Non autorizzato' });

    const user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    const bcrypt = require('bcryptjs');
    const valid = bcrypt.compareSync(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Password corrente errata' });

    const hash = bcrypt.hashSync(new_password, 10);
    database.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, userId);
    
    logger.info(`[AUTH] User ${user.username} changed password`);
    res.json({ ok: true });
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obbligatoria' });

    const user = database.db.prepare('SELECT id, username FROM users WHERE email = ?').get(email);
    if (!user) return res.json({ ok: true, message: 'Se l\'email esiste riceverai un link di ripristino.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 ora

    database.db.prepare('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?').run(resetToken, expiry, user.id);

    try {
        const resetLink = `http://${req.headers.host}/login?reset_token=${resetToken}`;
        const mailer = getTransporter();
        await mailer.sendMail({
            from: `"M2T Portfolio" <${mailer.defaultFrom}>`,
            to: email,
            subject: 'Ripristino password M2T Tracker',
            text: `Ciao ${user.username},\n\nHai richiesto il ripristino della password.\nClicca qui per impostare una nuova password:\n${resetLink}\n\nIl link è valido per 1 ora.`
        });
    } catch (e) {
        logger.error(`[AUTH] Error sending reset email: ${e.message}`);
    }

    res.json({ ok: true, message: 'Se l\'email esiste riceverai un link di ripristino.' });
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password || new_password.length < 4) return res.status(400).json({ error: 'Token o password non validi' });

    const user = database.db.prepare('SELECT id, reset_token_expiry FROM users WHERE reset_token = ?').get(token);
    if (!user) return res.status(400).json({ error: 'Token non valido o scaduto' });

    if (new Date() > new Date(user.reset_token_expiry)) {
        return res.status(400).json({ error: 'Token scaduto' });
    }

    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(new_password, 10);
    database.db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL, must_change_password = 0 WHERE id = ?').run(hash, user.id);
    
    logger.info(`[AUTH] User reset password via token`);
    res.json({ ok: true });
});

// ─── Admin API Routes ────────────────────────────────────────────────────────

// GET /api/admin/roles
app.get('/api/admin/roles', requireAuth, requireAdmin, (req, res) => {
    try {
        const perms = database.getRolePermissions();
        res.json(perms);
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/roles
app.post('/api/admin/roles', requireAuth, requireAdmin, (req, res) => {
    const { role, resource, is_enabled } = req.body;
    if (!role || !resource) return res.status(400).json({ error: 'role and resource required' });
    try {
        database.updateRolePermission(role, resource, is_enabled ? 1 : 0);
        logger.info(`[ADMIN] Role permission updated: ${role} -> ${resource} = ${is_enabled}`);
        res.json({ ok: true });
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/users
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    try {
        const users = database.getAllUsers();
        res.json(users);
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/smtp-settings
app.get('/api/admin/smtp-settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const settings = database.getSettings(1); // Admin settings are stored under user 1
        res.json({
            smtp_host: settings.smtp_host || '',
            smtp_port: settings.smtp_port || '',
            smtp_user: settings.smtp_user || '',
            smtp_from: settings.smtp_from || ''
        });
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/smtp-settings
app.post('/api/admin/smtp-settings', requireAuth, requireAdmin, (req, res) => {
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
    try {
        if (smtp_host !== undefined) database.setSetting(1, 'smtp_host', smtp_host);
        if (smtp_port !== undefined) database.setSetting(1, 'smtp_port', smtp_port);
        if (smtp_user !== undefined) database.setSetting(1, 'smtp_user', smtp_user);
        if (smtp_pass !== undefined && smtp_pass !== '') database.setSetting(1, 'smtp_pass', smtp_pass);
        if (smtp_from !== undefined) database.setSetting(1, 'smtp_from', smtp_from);
        
        // Invalidate transporter
        transporterInstance = null;
        
        logger.info(`[ADMIN] SMTP settings updated by ${req.user.username}`);
        res.json({ ok: true });
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/ai-settings

// GET /api/ai/available-engines
app.get('/api/ai/available-engines', requireAuth, (req, res) => {
    try {
        const settings = database.getSettings(1);
        const available = [];
        
        if (settings.geminiApiKeyFree) available.push('Gemini_Free');
        if (settings.geminiApiKeyPay || settings.geminiApiKey || process.env.GEMINI_API_KEY) available.push('Gemini_Pay');
        if (settings.qwenApiKeyFree) available.push('Qwen_Free');
        if (settings.qwenApiKeyPay || settings.qwenApiKey || process.env.QWEN_API_KEY) available.push('Qwen_Pay');
        if (settings.openaiApiKeyFree) available.push('OpenAI_Free');
        if (settings.openaiApiKeyPay || settings.openaiApiKey || process.env.OPENAI_API_KEY) available.push('OpenAI_Pay');
        if (settings.agnesApiKeyFree) available.push('Agnes_Free');
        if (settings.agnesApiKeyPay || settings.agnesApiKey || process.env.AGNES_API_KEY) available.push('Agnes_Pay');
        if (settings.aimlapiApiKeyFree) available.push('Aimlapi_Free');
        if (settings.aimlapiApiKeyPay || process.env.AIMLAPI_API_KEY) available.push('Aimlapi_Pay');
        
        const hasGemini = available.some(e => e.startsWith('Gemini'));
        const hasQwen = available.some(e => e.startsWith('Qwen'));
        if (hasGemini && hasQwen) {
            available.push('Both');
        }
        
        res.json({ engines: available, default: settings.aiEngine || 'Gemini_Free' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const settings = database.getSettings(1);
        res.json({
            aiEngine: settings.aiEngine || 'Gemini_Free',
            geminiApiKeyFree: settings.geminiApiKeyFree || '',
            geminiApiKeyPay: settings.geminiApiKeyPay || settings.geminiApiKey || '',
            qwenApiKeyFree: settings.qwenApiKeyFree || '',
            qwenApiKeyPay: settings.qwenApiKeyPay || settings.qwenApiKey || '',
            openaiApiKeyFree: settings.openaiApiKeyFree || '',
            openaiApiKeyPay: settings.openaiApiKeyPay || settings.openaiApiKey || '',
            agnesApiKeyFree: settings.agnesApiKeyFree || '',
            agnesApiKeyPay: settings.agnesApiKeyPay || settings.agnesApiKey || '',
            aimlapiApiKeyFree: settings.aimlapiApiKeyFree || '',
            aimlapiApiKeyPay: settings.aimlapiApiKeyPay || '',
            aiAssetPrompt: settings.aiAssetPrompt || '',
            aiPortfolioPrompt: settings.aiPortfolioPrompt || '',
            aiTokensUsedToday: settings.aiTokensUsedToday || '0',
            aiTokensDate: settings.aiTokensDate || ''
        });
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/ai-settings
app.post('/api/admin/ai-settings', requireAuth, requireAdmin, (req, res) => {
    const { aiEngine, geminiApiKeyFree, geminiApiKeyPay, qwenApiKeyFree, qwenApiKeyPay, openaiApiKeyFree, openaiApiKeyPay, agnesApiKeyFree, agnesApiKeyPay, aimlapiApiKeyFree, aimlapiApiKeyPay, aiAssetPrompt, aiPortfolioPrompt } = req.body;
    try {
        if (aiEngine !== undefined) database.setSetting(1, 'aiEngine', aiEngine);
        if (geminiApiKeyFree !== undefined) database.setSetting(1, 'geminiApiKeyFree', geminiApiKeyFree);
        if (geminiApiKeyPay !== undefined) database.setSetting(1, 'geminiApiKeyPay', geminiApiKeyPay);
        if (qwenApiKeyFree !== undefined) database.setSetting(1, 'qwenApiKeyFree', qwenApiKeyFree);
        if (qwenApiKeyPay !== undefined) database.setSetting(1, 'qwenApiKeyPay', qwenApiKeyPay);
        if (openaiApiKeyFree !== undefined) database.setSetting(1, 'openaiApiKeyFree', openaiApiKeyFree);
        if (openaiApiKeyPay !== undefined) database.setSetting(1, 'openaiApiKeyPay', openaiApiKeyPay);
        if (agnesApiKeyFree !== undefined) database.setSetting(1, 'agnesApiKeyFree', agnesApiKeyFree);
        if (agnesApiKeyPay !== undefined) database.setSetting(1, 'agnesApiKeyPay', agnesApiKeyPay);
        if (aimlapiApiKeyFree !== undefined) database.setSetting(1, 'aimlapiApiKeyFree', aimlapiApiKeyFree);
        if (aimlapiApiKeyPay !== undefined) database.setSetting(1, 'aimlapiApiKeyPay', aimlapiApiKeyPay);
        if (aiAssetPrompt !== undefined) database.setSetting(1, 'aiAssetPrompt', aiAssetPrompt);
        if (aiPortfolioPrompt !== undefined) database.setSetting(1, 'aiPortfolioPrompt', aiPortfolioPrompt);
        
        logger.info(`[ADMIN] AI settings updated by ${req.user.username}`);
        res.json({ ok: true });
    } catch (e) {
        console.error(e); res.status(500).json({ error: e.message });
    }
});

// POST /api/admin/smtp-test
app.post('/api/admin/smtp-test', requireAuth, requireAdmin, async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient email required' });
    
    try {
        const mailer = getTransporter();
        await mailer.sendMail({
            from: `"M2T Admin Test" <${mailer.defaultFrom}>`,
            to,
            subject: 'M2T SMTP Test Message',
            text: 'This is a test email from your FolioTracker Admin Panel. Your SMTP settings are working correctly!',
            html: '<b>This is a test email from your FolioTracker Admin Panel.</b><br><br>Your SMTP settings are working correctly!'
        });
        logger.info(`[ADMIN] SMTP Test email sent to ${to}`);
        res.json({ ok: true });
    } catch (e) {
        logger.error(`[ADMIN] SMTP Test failed: ${e.message}`);
        res.status(500).json({ error: `SMTP Error: ${e.message}` });
    }
});

// POST /api/admin/users — create new user
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role, display_name } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username e password obbligatori' });
    try {
        const user = database.createUser(username, password, null, role || 'free', display_name || username, 0);
        logger.info(`[AUTH] Admin ${req.user.username} created user: ${username} (${role || 'user'})`);
        res.status(201).json(user);
    } catch (e) {
        res.status(409).json({ error: 'Username già esistente' });
    }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) return res.status(400).json({ error: 'Non puoi eliminare il tuo account' });
    database.deleteUser(userId);
    logger.info(`[AUTH] Admin ${req.user.username} deleted user id: ${userId}`);
    res.json({ ok: true });
});

// PATCH /api/admin/users/:id/role
app.patch('/api/admin/users/:id/role', requireAuth, requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    const { role } = req.body;
    if (!['admin', 'user', 'free'].includes(role)) return res.status(400).json({ error: 'Ruolo non valido' });
    database.updateUserRole(userId, role);
    res.json({ ok: true });
});

// PATCH /api/admin/users/:id/password
app.patch('/api/admin/users/:id/password', requireAuth, requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password troppo corta (min 4 caratteri)' });
    database.updateUserPassword(userId, password);
    res.json({ ok: true });
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
    const db = database.db;
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const portfolioCount = db.prepare('SELECT COUNT(*) as c FROM portfolios').get().c;
    const assetCount = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
    const txCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
    const notifCount = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE isRead = 0').get().c;
    res.json({ userCount, portfolioCount, assetCount, txCount, notifCount, version: APP_VERSION });
});

// GET /api/admin/logs — last log lines
app.get('/api/admin/logs', requireAuth, requireAdmin, (req, res) => {
    try {
        const maxLines = parseInt(req.query.lines) || 200;
        const dateParam = req.query.date; // YYYY-MM-DD

        let content = '';
        if (dateParam) {
            const rotatedFile = getRotatedLogFile(new Date(dateParam));
            if (fs.existsSync(rotatedFile)) {
                content = fs.readFileSync(rotatedFile, 'utf8');
            }
        } else {
            if (fs.existsSync(LOG_FILE)) {
                content = fs.readFileSync(LOG_FILE, 'utf8');
            }
        }
        
        if (!content) return res.json({ logs: '' });
        
        const lines = content.trim().split('\n').filter(Boolean);
        const tail = lines.slice(-maxLines).join('\n');
        res.json({ logs: tail });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/logs/dates — available log days
app.get('/api/admin/logs/dates', requireAuth, requireAdmin, (req, res) => {
    try {
        if (!fs.existsSync(LOGS_DIR)) return res.json([]);
        const files = fs.readdirSync(LOGS_DIR);
        const dates = files
            .filter(f => f.startsWith('app.log.'))
            .map(f => f.replace('app.log.', ''))
            .sort((a, b) => b.localeCompare(a));
        
        // Add today
        const today = new Date().toISOString().split('T')[0];
        if (!dates.includes(today)) dates.unshift(today);
        
        res.json(dates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Security & Sessions Endpoints ───

// GET /api/admin/audit-logs
app.get('/api/admin/audit-logs', requireAuth, requireAdmin, (req, res) => {
    try {
        const logs = database.db.prepare(`
            SELECT l.*, u.username 
            FROM audit_logs l 
            LEFT JOIN users u ON l.user_id = u.id 
            ORDER BY l.timestamp DESC LIMIT 100
        `).all();
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/sessions
app.get('/api/admin/sessions', requireAuth, requireAdmin, (req, res) => {
    try {
        const sessions = database.db.prepare(`
            SELECT s.*, u.username, u.display_name
            FROM user_sessions s
            JOIN users u ON s.user_id = u.id
            ORDER BY s.last_seen DESC
        `).all();
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/sessions/:sid
app.delete('/api/admin/sessions/:sid', requireAuth, requireAdmin, (req, res) => {
    try {
        const sid = req.params.sid;
        database.db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(sid);
        logAudit(req.user.id, 'SESSION_REVOKE', { sid }, req);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/security-settings
app.get('/api/admin/security-settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const settings = database.getSettings(1);
        res.json({
            max_attempts: parseInt(settings.auth_max_attempts || '5'),
            ban_duration: parseInt(settings.auth_ban_duration_minutes || '30')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/security-settings
app.post('/api/admin/security-settings', requireAuth, requireAdmin, express.json(), (req, res) => {
    try {
        const { max_attempts, ban_duration } = req.body;
        database.setSetting('auth_max_attempts', max_attempts.toString());
        database.setSetting('auth_ban_duration_minutes', ban_duration.toString());
        logAudit(req.user.id, 'SECURITY_SETTINGS_UPDATE', { max_attempts, ban_duration }, req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/banned-ips
app.get('/api/admin/banned-ips', requireAuth, requireAdmin, (req, res) => {
    try {
        const ips = database.getBannedIps();
        res.json(ips);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/banned-ips/:ip
app.delete('/api/admin/banned-ips/:ip', requireAuth, requireAdmin, (req, res) => {
    try {
        const ip = req.params.ip;
        database.resetLoginFailures(ip);
        logAudit(req.user.id, 'IP_UNBAN', { ip }, req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// GET /api/app-version (public)
app.get('/api/app-version', (req, res) => {
    res.json({ version: APP_VERSION });
});


// ─── CACHING LAYER ──────────────────────────────────────────────────────────
let historicalPricesCache = {}; // { ticker: { date: price } }
let watchlistPerformanceCache = { data: {}, lastUpdated: 0 };
const WATCHLIST_PERF_CACHE_TTL = 3600 * 1000; // 1 hour
let performanceResultsCache = {}; // { cacheKey: { data, timestamp } }
performanceResultsCache = {}; // Clear cache to apply date fix immediately
let eurUsdCache = { rate: 1.08, timestamp: 0 };
const EUR_USD_TTL = 5 * 60 * 1000; // 5 minutes

// ─── MARKET STATUS LOGIC ─────────────────────────────────────────────────────
const MARKET_HOURS = {
    MIL: { open: '09:00', close: '17:30', name: 'Borsa Italiana' },
    GER: { open: '09:00', close: '17:30', name: 'XETRA' },
    USA: { open: '15:30', close: '22:00', name: 'NYSE/NASDAQ' }
};

/**
 * Fetches robust metadata from Yahoo Finance, including Country/Area and Type improvements.
 */
async function fetchAssetMetadata(ticker) {
    if (ticker && ticker.startsWith('CD_')) {
        return {
            ticker: ticker,
            currentPrice: 0, 
            changePercent: 0,
            type: 'Deposito Vincolato', 
            longName: ticker,
            shortName: ticker,
            currency: 'EUR',
            exchange: 'MANUAL',
            country: 'Italy',
            dataSource: 'MANUAL'
        };
    }
    try {
        const quote = await yahooFinance.quote(ticker).catch(err => {
            if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
                throw new Error('YF_RATE_LIMIT');
            }
            return null;
        });
        if (!quote) return null;

        let country = 'N/A';
        // Remap EQUITY to Azioni
        let detailedType = quote.quoteType === 'EQUITY' ? 'Azioni' : (quote.quoteType || 'Altro');
        // Remap BOND to Bond
        if (quote.quoteType === 'BOND') detailedType = 'Bond';

        const summary = await yahooFinance.quoteSummary(ticker, { 
            modules: ["summaryProfile", "assetProfile", "fundProfile", "summaryDetail", "defaultKeyStatistics", "calendarEvents"] 
        }).catch(err => {
            if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
                throw new Error('YF_RATE_LIMIT');
            }
            return {};
        });

        if (summary.summaryProfile && summary.summaryProfile.country) {
            country = summary.summaryProfile.country;
        } else if (summary.assetProfile && summary.assetProfile.country) {
            country = summary.assetProfile.country;
        }

        if (quote.quoteType === 'ETF' || quote.quoteType === 'MUTUALFUND') {
            const fp = summary.fundProfile;
            const nameStr = (quote.longName || quote.shortName || "").toLowerCase();
            
            if (country === 'N/A' || !country) {
                if (fp && fp.categoryName) {
                    const cat = fp.categoryName;
                    if (cat.includes('World') || cat.includes('Global')) country = 'Global';
                    else if (cat.includes('Europe')) country = 'Europe';
                    else if (cat.includes('Emerging')) country = 'Emerging Markets';
                    else if (cat.includes('Asia')) country = 'Asia';
                    else if (cat.includes('US') || cat.includes('America')) country = 'USA';
                    else country = cat;
                } else {
                    if (nameStr.includes('world') || nameStr.includes('global') || nameStr.includes('acwi')) country = 'Global';
                    else if (nameStr.includes('europe') || nameStr.includes('stoxx')) country = 'Europe';
                    else if (nameStr.includes('usa') || nameStr.includes('sp500') || nameStr.includes('s&p 500')) country = 'USA';
                    else if (nameStr.includes('emerging')) country = 'Emerging Markets';
                }
            }

            if (fp && fp.categoryName) {
                const cat = fp.categoryName.toLowerCase();
                if (cat.includes('bond') || cat.includes('obblig')) detailedType = 'ETF Obblig';
                else if (cat.includes('equity') || cat.includes('azion')) detailedType = 'ETF Azionario';
                else if (cat.includes('money') || cat.includes('monet')) detailedType = 'ETF Monetario';
                else detailedType = 'ETF Azionario'; // Default for funds
            } else if (nameStr.includes('bond') || nameStr.includes('obbligazion')) {
                detailedType = 'ETF Obblig';
            } else if (nameStr.includes('equity') || nameStr.includes('azionario') || nameStr.includes('world') || nameStr.includes('stock')) {
                detailedType = 'ETF Azionario';
            } else if (nameStr.includes('monetary') || nameStr.includes('monetario') || nameStr.includes('cash') || nameStr.includes('rate')) {
                detailedType = 'ETF Monetario';
            } else {
                detailedType = 'ETF Azionario';
            }
        }

        return {
            ticker: ticker,
            name: quote.shortName || quote.longName || ticker,
            currency: quote.currency || 'USD',
            exchange: quote.fullExchangeName || quote.exchange || '',
            type: detailedType,
            country: country,
            currentPrice: quote.regularMarketPrice || 0,
            changePercent: quote.regularMarketChangePercent || 0,
            changeValue: quote.regularMarketChange || 0,
            preMarketChangePercent: quote.preMarketChangePercent || 0,
            postMarketChangePercent: quote.postMarketChangePercent || 0,
            pe: quote.trailingPE || (summary.summaryDetail ? summary.summaryDetail.trailingPE : null),
            forwardPE: quote.forwardPE || (summary.summaryDetail ? summary.summaryDetail.forwardPE : null),
            changePercent: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChangePercent !== undefined && quote.regularMarketChangePercent !== null ? quote.regularMarketChangePercent : (summary.price ? summary.price.regularMarketChangePercent : null)),
            changeValue: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChange !== undefined && quote.regularMarketChange !== null ? quote.regularMarketChange : (summary.price ? summary.price.regularMarketChange : null)),
            dividendYield: (function() {
                let y = quote.dividendYield || (summary.summaryDetail ? summary.summaryDetail.dividendYield : null);
                if (y === null || y === undefined) return null;
                // If y > 0.2 (20%), and it's from a standard quote, it's likely already a percentage (e.g. 2.5 meaning 2.5%).
                // Most dividend yields are < 20% (0.2). If it's e.g. 3.0, it's definitely a percentage.
                if (y > 0.2) return y / 100; 
                return y;
            })(),
            eps: quote.epsTrailingTwelveMonths || (summary.defaultKeyStatistics ? summary.defaultKeyStatistics.trailingEps : null),
            beta: quote.beta || (summary.summaryDetail ? summary.summaryDetail.beta : null),
            pegRatio: summary.defaultKeyStatistics ? summary.defaultKeyStatistics.pegRatio : null,
            nextDividendDate: (summary.calendarEvents && summary.calendarEvents.exDividendDate) ? new Date(summary.calendarEvents.exDividendDate).toISOString().split('T')[0] : (quote.dividendDate ? new Date(quote.dividendDate * 1000).toISOString().split('T')[0] : null),
            quoteDate: quote.regularMarketTime ? new Date(quote.regularMarketTime).toISOString().split('T')[0] : null,
            isin: (function() {
                let i = quote.isin || (summary.summaryDetail ? summary.summaryDetail.isin : null) || (summary.defaultKeyStatistics ? summary.defaultKeyStatistics.isin : null);
                if (!i) return null;
                i = String(i).trim().toUpperCase();
                return i.length >= 10 ? i : null;
            })()
        };
    } catch (e) {
        console.error(`Metadata fetch error for ${ticker}:`, e.message);
        return null;
    }
}

function getMarketStatus() {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun, 6=Sat
    const isWeekend = (day === 0 || day === 6);
    
    // Convert current time to CET/CEST (Italy/Germany time)
    const cetNow = new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);

    const checkOpen = (hours) => {
        if (isWeekend) return false;
        return cetNow >= hours.open && cetNow <= hours.close;
    };

    const milOpen = checkOpen(MARKET_HOURS.MIL);
    const gerOpen = checkOpen(MARKET_HOURS.GER);
    const usOpen  = checkOpen(MARKET_HOURS.USA);

    const milHrs = MARKET_HOURS.MIL;
    const usHrs  = MARKET_HOURS.USA;

    const status = {
        EU: milOpen || gerOpen,
        US: usOpen,
        EU_openedToday: !isWeekend && cetNow >= milHrs.open,
        US_openedToday: !isWeekend && cetNow >= usHrs.open,
        US_preMarketActive: !isWeekend && cetNow >= '10:00' && cetNow < usHrs.open,
        US_afterHoursActive: !isWeekend && (cetNow > usHrs.close || cetNow < '02:05'),
        isWeekend,
        anyOpen: milOpen || gerOpen || usOpen
    };

    return status;
}

/**
 * Calculates variation overrides based on current market status.
 * Prevents showing yesterday's variation as "today's" in the morning.
 */
function calculateVariationOverrides(marketStatus) {
    const overrides = { regular: {}, prePost: {} };
    try {
        const assets = database.db.prepare('SELECT ticker, type, currentPrice, changePercent, changeValue, preMarketChangePercent, postMarketChangePercent, quoteDate FROM assets').all();
        const todayStr = new Date().toISOString().split('T')[0];
        
        assets.forEach(a => {
            if (!a.ticker || a.ticker === 'CASH') return;
            const isUS = isUSMarket(a);
            const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
            const preMktActive = isUS ? marketStatus.US_preMarketActive : false;
            const postMktActive = isUS ? marketStatus.US_afterHoursActive : false;
            const isToday = a.quoteDate === todayStr;

            // 1. Regular Session Variation
            if (openedToday && isToday) {
                overrides.regular[a.ticker] = a.changeValue || 0;
            } else {
                overrides.regular[a.ticker] = 0;
            }

            // 2. Pre/Post Market Variation (Safety against Division by Zero)
            let ppVal = 0;
            if (preMktActive && (a.preMarketChangePercent || a.preMarketChangePercent === 0)) {
                const chgPct = a.preMarketChangePercent;
                if (chgPct > -99.9) {
                    ppVal = a.currentPrice - (a.currentPrice / (1 + chgPct/100));
                }
            } else if (postMktActive && (a.postMarketChangePercent || a.postMarketChangePercent === 0)) {
                const chgPct = a.postMarketChangePercent;
                if (chgPct > -99.9) {
                    ppVal = a.currentPrice - (a.currentPrice / (1 + chgPct/100));
                }
            }
            overrides.prePost[a.ticker] = (isNaN(ppVal) || !isFinite(ppVal)) ? 0 : ppVal;
        });
    } catch (err) {
        console.error("[Overrides] Critical error calculating overrides:", err);
    }
    return overrides;
}

/**
 * Centralized helper to refresh all portfolio statistics while applying morning reset overrides.
 */
async function recalculateAllPortfoliosWithOverrides(liveRate = null) {
    if (!liveRate) liveRate = await getEurUsdRate();
    const marketStatus = getMarketStatus();
    const overrides = calculateVariationOverrides(marketStatus);
    database.recalculateAll(liveRate, overrides); // Updated database logic to handle {regular, prePost}
    return { liveRate, marketStatus, overrides };
}

async function getEurUsdRate() {
    if (Date.now() - eurUsdCache.timestamp < EUR_USD_TTL) {
        return eurUsdCache.rate;
    }
    try {
        const quote = await yahooFinance.quote('EURUSD=X');
        if (quote && quote.regularMarketPrice) {
            eurUsdCache = { rate: quote.regularMarketPrice, timestamp: Date.now() };
            
            // Persist to database as a reliable fallback
            try {
                database.db.prepare(`
                    INSERT INTO assets (id, ticker, name, currency, currentPrice, dataSource, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(ticker) DO UPDATE SET 
                        currentPrice = excluded.currentPrice,
                        updatedAt = excluded.updatedAt
                `).run('EURUSD=X', 'EURUSD=X', 'EUR/USD Rate', 'USD', quote.regularMarketPrice, 'YF');
            } catch (dbErr) {
                console.warn('Failed to persist EUR/USD rate to DB:', dbErr.message);
            }

            return eurUsdCache.rate;
        }
    } catch (err) {
        console.warn('Failed to fetch EUR/USD rate from YF:', err.message);
    }

    // Fallback 1: Last known in-memory rate
    if (eurUsdCache.rate > 0) return eurUsdCache.rate;

    // Fallback 2: Last known database rate
    try {
        const saved = database.db.prepare("SELECT currentPrice FROM assets WHERE ticker = 'EURUSD=X'").get();
        if (saved && saved.currentPrice > 0) {
            eurUsdCache.rate = saved.currentPrice;
            return saved.currentPrice;
        }
    } catch (e) {}

    return 1.0; // Ultimate fallback
}

function clearPerformanceCache() {
    performanceResultsCache = {};
    historicalPricesCache = {};
    watchlistPerformanceCache = { data: {}, lastUpdated: 0 };
    if (eurUsdCache) eurUsdCache.timestamp = 0; // Reset currency cache as well
    logger.info('Performance, Historical Prices, and Exchange Rate caches invalidated.');
}

// ─── BORSA ITALIANA SCRAPER ──────────────────────────────────────────────────
 async function B_ITA(isin, assetType = '') {
    let attempts = 0;
    const maxAttempts = 3;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/120.0.0.0',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };
    const finalUrl = `https://www.borsaitaliana.it/borsa/search/scheda.html?code=${isin}&lang=it`;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            // Step 1: Get the Token from the summary-chart page
            let summaryUrl = `https://grafici.borsaitaliana.it/summary-chart/${isin}-MOTX?lang=it`;
            let summaryResp;
            try {
                summaryResp = await axios.get(summaryUrl, { headers, timeout: 10000 });
            } catch (e) {
                // Try fallback without -MOTX suffix
                summaryUrl = `https://grafici.borsaitaliana.it/summary-chart/${isin}?lang=it`;
                summaryResp = await axios.get(summaryUrl, { headers, timeout: 10000 });
            }

            const tokenMatch = summaryResp.data.match(/token="([^"]+)"/);
            if (!tokenMatch) {
                throw new Error("Token not found in B_ITA summary-chart HTML");
            }
            const token = tokenMatch[1];

            // Step 2: Get Current Price using the dynamic token API
            const apiUrl = `https://grafici.borsaitaliana.it/api/instruments/${isin},XMIL,ISIN/history/period?period=1M&adjustment=true&add-last-price=true`;
            
            const resp = await axios.get(apiUrl, {
                headers: {
                    ...headers,
                    'Authorization': `Bearer ${token}`,
                    'Referer': summaryUrl,
                    'Accept': 'application/json, text/plain, */*'
                },
                timeout: 15000
            });

            if (resp.data && resp.data.history && resp.data.history.historyDt && resp.data.history.historyDt.length > 0) {
                const dtArr = resp.data.history.historyDt;
                const price = dtArr[dtArr.length - 1].closePx;
                let variation = null;

                if (dtArr.length > 1) {
                    const prevPrice = dtArr[dtArr.length - 2].closePx;
                    if (price && prevPrice) {
                        variation = ((price - prevPrice) / prevPrice) * 100;
                    }
                }

                if (price !== undefined && price !== null) {
                    const rawDt = dtArr[dtArr.length - 1].dt; // e.g. "20260608"
                    const parsedDate = rawDt ? `${rawDt.substring(0,4)}-${rawDt.substring(4,6)}-${rawDt.substring(6,8)}` : null;
                    return {
                        success: true,
                        price: parseFloat(price),
                        variation: variation !== null ? parseFloat(variation) : null,
                        url: finalUrl,
                        quoteDate: parsedDate,
                        isin
                    };
                }
            }

            if (attempts < maxAttempts) {
                logger.warn(`B_ITA Scraper: No price found for ${isin} on attempt ${attempts}. Retrying...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            return { success: false, error: 'Price not found in API response', url: finalUrl, isin };

        } catch (err) {
            if (attempts < maxAttempts) {
                logger.warn(`B_ITA Scraper attempt ${attempts} failed for ${isin}: ${err.message}. Retrying...`);
                await new Promise(r => setTimeout(r, 2000 * attempts));
                continue;
            }
            console.error(`B_ITA Scraper error for ${isin} after ${maxAttempts} attempts:`, err.message);
            return { success: false, error: err.message, url: finalUrl, isin };
        }
    }
}
// ─── VALIDATION HELPERS ───────────────────────────────────────────────────
function isValidISIN(isin) {
    if (!isin) return true; // Optional field
    return /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin);
}

function sanitizeTicker(ticker) {
    if (!ticker) return '';
    // Allow common ticker symbols and % for encoded characters
    return ticker.replace(/[^A-Z0-9.\-_:=%]/gi, '').toUpperCase();
}
// ────────────────────────────────────────────────────────────────────────────

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// ────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// HISTORY API
// ════════════════════════════════════════════════════════════════════════════



app.get('/api/history', requireAuth, (req, res) => {
    const { portfolioId } = req.query;
    
    // Isolation: Only portfolios the user has access to
    let query = `
        SELECT h.* FROM portfolio_history h
        JOIN portfolio_users pu ON h.portfolioId = pu.portfolio_id
        WHERE pu.user_id = ?
    `;
    let params = [req.user.id];
    
    if (portfolioId && portfolioId !== 'null' && portfolioId !== '') {
        query += ` AND h.portfolioId = ? `;
        params.push(portfolioId);
    }
    
    query += ` ORDER BY date DESC`;
    res.json(database.db.prepare(query).all(...params));
});

app.post('/api/history', requireAuth, requirePortfolioAccess, (req, res) => {
    const { id, portfolioId, date, totalValue, cashValue, assetValue } = req.body;
    const rTotal = Math.round(totalValue || 0);
    const rCash  = Math.round(cashValue || 0);
    const rAsset = Math.round(assetValue || 0);

    try {
        if (id) {
            database.db.prepare(`
                UPDATE portfolio_history 
                SET date = ?, totalValue = ?, cashValue = ?, assetValue = ? 
                WHERE id = ?
            `).run(date, rTotal, rCash, rAsset, id);
        } else {
            const pid = portfolioId === 'null' ? null : portfolioId;
            database.db.prepare(`
                INSERT INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(portfolioId, date) DO UPDATE SET
                    totalValue = excluded.totalValue,
                    cashValue = excluded.cashValue,
                    assetValue = excluded.assetValue
            `).run(pid, date, rTotal, rCash, rAsset);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
    try {
        const row = database.db.prepare(`
            SELECT h.* FROM portfolio_history h
            JOIN portfolio_users pu ON h.portfolioId = pu.portfolio_id
            WHERE h.id = ? AND pu.user_id = ?
        `).get(req.params.id, req.user.id);

        if (!row && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

        database.db.prepare(`DELETE FROM portfolio_history WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// app.use(cors()); // Moved to top
// app.use(express.json()); // Moved to top
// app.use(express.urlencoded({ extended: true })); // Moved to top

// ════════════════════════════════════════════════════════════════════════════
// FUNDAMENTALS API  — PEG Ratio, FCF, indicatori fondamentali
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cache in-memory per i dati fondamentali.
 * TTL: 6 ore (i fondamentali non cambiano spesso).
 */
const fundamentalsCache = new Map();
const FUNDAMENTALS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * GET /api/fundamentals/:ticker
 *
 * Restituisce:
 *  - pegRatio         : Forward PEG (P/E forward / EPS growth 5Y), da defaultKeyStatistics
 *  - pegRatioTrend    : PEG per periodo forward da earningsTrend (0q, +1q, 0y, +1y)
 *  - pegHistorical    : PEG storico calcolato manualmente (prezzo / EPS TTM / crescita EPS)
 *  - fcfTTM           : Free Cash Flow TTM corrente
 *  - operatingCFTTM   : Operating Cash Flow TTM corrente
 *  - fcfAnnual        : Storico FCF annuale (fundamentalsTimeSeries)
 *  - fcfQuarterly     : Storico FCF trimestrale (fundamentalsTimeSeries)
 *  - financialData    : Margini, ROE, ROA, crescita ricavi/utili, target price
 *  - earningsHistory  : Storico EPS effettivi (ultimi 4 quarter)
 */
app.get('/api/fundamentals/:ticker', requireAuth, async (req, res) => {
    const ticker = (req.params.ticker || '').toUpperCase();
    if (!ticker) return res.status(400).json({ error: 'Ticker mancante' });

    // Check cache
    const cached = fundamentalsCache.get(ticker);
    if (cached && (Date.now() - cached.ts) < FUNDAMENTALS_CACHE_TTL_MS) {
        logger.info(`[Fundamentals] Cache hit: ${ticker}`);
        return res.json(cached.data);
    }

    logger.info(`[Fundamentals] Fetching data for: ${ticker}`);

    const result = {
        ticker,
        fetchedAt: new Date().toISOString(),
        pegRatio: null,
        pegRatioTrend: [],
        pegHistorical: [],
        fcfTTM: null,
        operatingCFTTM: null,
        fcfAnnual: [],
        fcfQuarterly: [],
        financialData: {},
        earningsHistory: [],
        errors: []
    };

    // ── 1. defaultKeyStatistics: PEG forward + FCF TTM ──────────────────────
    try {
        const ks = await yahooFinance.quoteSummary(ticker, {
            modules: ['defaultKeyStatistics']
        });
        const s = ks.defaultKeyStatistics || {};
        result.pegRatio        = s.pegRatio       ?? null;
        result.fcfTTM          = s.freeCashflow   ?? null;
        result.operatingCFTTM  = s.operatingCashflow ?? null;
        result.keyStats = {
            forwardPE:      s.forwardPE       ?? null,
            trailingEps:    s.trailingEps     ?? null,
            forwardEps:     s.forwardEps      ?? null,
            earningsGrowth: s.earningsGrowth  ?? null,
            revenueGrowth:  s.revenueGrowth   ?? null,
            priceToBook:    s.priceToBook     ?? null,
            enterpriseValue:s.enterpriseValue ?? null,
            enterpriseToEbitda:    s.enterpriseToEbitda    ?? null,
            enterpriseToRevenue:   s.enterpriseToRevenue   ?? null,
            '52WeekChange':        s['52WeekChange']        ?? null,
            sharesOutstanding:     s.sharesOutstanding      ?? null,
            bookValue:             s.bookValue              ?? null
        };
    } catch (e) {
        logger.warn(`[Fundamentals] defaultKeyStatistics error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'defaultKeyStatistics', error: e.message });
    }

    // ── 2. financialData: margini, crescita, target price ───────────────────
    try {
        const fd = await yahooFinance.quoteSummary(ticker, {
            modules: ['financialData']
        });
        const f = fd.financialData || {};
        result.fcfTTM         = result.fcfTTM ?? f.freeCashflow ?? null;
        result.operatingCFTTM = result.operatingCFTTM ?? f.operatingCashflow ?? null;
        result.financialData  = {
            currentPrice:        f.currentPrice        ?? null,
            targetMeanPrice:     f.targetMeanPrice      ?? null,
            targetHighPrice:     f.targetHighPrice      ?? null,
            targetLowPrice:      f.targetLowPrice       ?? null,
            recommendationMean:  f.recommendationMean   ?? null,
            recommendationKey:   f.recommendationKey    ?? null,
            numberOfAnalysts:    f.numberOfAnalystOpinions ?? null,
            ebitdaMargins:       f.ebitdaMargins        ?? null,
            profitMargins:       f.profitMargins        ?? null,
            grossMargins:        f.grossMargins         ?? null,
            operatingMargins:    f.operatingMargins     ?? null,
            returnOnAssets:      f.returnOnAssets       ?? null,
            returnOnEquity:      f.returnOnEquity       ?? null,
            totalCash:           f.totalCash            ?? null,
            totalDebt:           f.totalDebt            ?? null,
            totalRevenue:        f.totalRevenue         ?? null,
            revenueGrowth:       f.revenueGrowth        ?? null,
            earningsGrowth:      f.earningsGrowth       ?? null,
            ebitda:              f.ebitda               ?? null,
            debtToEquity:        f.debtToEquity         ?? null,
            currentRatio:        f.currentRatio         ?? null,
            quickRatio:          f.quickRatio           ?? null,
            freeCashflow:        f.freeCashflow         ?? null,
            operatingCashflow:   f.operatingCashflow    ?? null
        };
    } catch (e) {
        logger.warn(`[Fundamentals] financialData error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'financialData', error: e.message });
    }

    // ── 3. earningsTrend: PEG forward per periodo ───────────────────────────
    try {
        const et = await yahooFinance.quoteSummary(ticker, {
            modules: ['earningsTrend']
        });
        const trend = et.earningsTrend?.trend || [];
        result.pegRatioTrend = trend.map(t => ({
            period:          t.period,
            endDate:         t.endDate ? (t.endDate instanceof Date ? t.endDate.toISOString().split('T')[0] : t.endDate) : null,
            pegRatio:        t.pegRatio        ?? null,
            growth:          t.growth?.raw     ?? t.growth   ?? null,
            epsEstimateMean: t.earningsEstimate?.avg?.raw ?? t.earningsEstimate?.avg ?? null,
            epsEstimateHigh: t.earningsEstimate?.high?.raw ?? t.earningsEstimate?.high ?? null,
            epsEstimateLow:  t.earningsEstimate?.low?.raw  ?? t.earningsEstimate?.low  ?? null,
            revenueEstimateMean: t.revenueEstimate?.avg?.raw ?? t.revenueEstimate?.avg ?? null,
        }));
    } catch (e) {
        logger.warn(`[Fundamentals] earningsTrend error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'earningsTrend', error: e.message });
    }

    // ── 4. earningsHistory: storico EPS effettivi ───────────────────────────
    try {
        const eh = await yahooFinance.quoteSummary(ticker, {
            modules: ['earningsHistory']
        });
        const history = eh.earningsHistory?.history || [];
        result.earningsHistory = history.map(h => ({
            period:          h.period,
            date:            h.quarter ? (h.quarter instanceof Date ? h.quarter.toISOString().split('T')[0] : h.quarter) : null,
            epsActual:       h.epsActual?.raw    ?? h.epsActual    ?? null,
            epsEstimate:     h.epsEstimate?.raw  ?? h.epsEstimate  ?? null,
            epsDifference:   h.epsDifference?.raw ?? h.epsDifference ?? null,
            surprisePercent: h.surprisePercent?.raw ?? h.surprisePercent ?? null
        }));
    } catch (e) {
        logger.warn(`[Fundamentals] earningsHistory error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'earningsHistory', error: e.message });
    }

    // ── 5. FCF storico annuale (fundamentalsTimeSeries) ─────────────────────
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 6); // Ultimi 6 anni
        const cfAnnual = await yahooFinance.fundamentalsTimeSeries(ticker, {
            period1: from.toISOString().split('T')[0],
            type: 'annual',
            module: 'cash-flow'
        });
        result.fcfAnnual = (cfAnnual || []).map(item => {
            const fcf  = item.annualFreeCashFlow       ?? item.freeCashFlow       ?? null;
            const ocf  = item.annualOperatingCashFlow  ?? item.operatingCashFlow  ?? item.cashFlowFromContinuingOperatingActivities ?? null;
            const capex = item.annualCapitalExpenditure ?? item.capitalExpenditure ?? null;
            return {
                date:             item.date instanceof Date ? item.date.toISOString().split('T')[0] : (item.date ?? null),
                freeCashFlow:     fcf,
                operatingCashFlow: ocf,
                capitalExpenditure: capex,
                // Se FCF non è disponibile direttamente, calcolalo da OCF - CapEx
                fcfCalculated:    (fcf === null && ocf !== null && capex !== null) ? ocf - capex : null
            };
        }).filter(i => i.date);
    } catch (e) {
        logger.warn(`[Fundamentals] fundamentalsTimeSeries annual cash-flow error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'fundamentalsTimeSeries-annual', error: e.message });
    }

    // ── 6. FCF storico trimestrale (fundamentalsTimeSeries) ─────────────────
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 3); // Ultimi 3 anni
        const cfQuarterly = await yahooFinance.fundamentalsTimeSeries(ticker, {
            period1: from.toISOString().split('T')[0],
            type: 'quarterly',
            module: 'cash-flow'
        });
        result.fcfQuarterly = (cfQuarterly || []).map(item => {
            const fcf   = item.quarterlyFreeCashFlow       ?? item.freeCashFlow       ?? null;
            const ocf   = item.quarterlyOperatingCashFlow  ?? item.operatingCashFlow  ?? item.cashFlowFromContinuingOperatingActivities ?? null;
            const capex = item.quarterlyCapitalExpenditure ?? item.capitalExpenditure ?? null;
            return {
                date:              item.date instanceof Date ? item.date.toISOString().split('T')[0] : (item.date ?? null),
                freeCashFlow:      fcf,
                operatingCashFlow: ocf,
                capitalExpenditure: capex,
                fcfCalculated:     (fcf === null && ocf !== null && capex !== null) ? ocf - capex : null
            };
        }).filter(i => i.date);
    } catch (e) {
        logger.warn(`[Fundamentals] fundamentalsTimeSeries quarterly cash-flow error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'fundamentalsTimeSeries-quarterly', error: e.message });
    }

    // ── 7. PEG storico calcolato manualmente ────────────────────────────────
    // PEG = (Prezzo / EPS_trailing) / crescita_EPS_annua
    // Richiede: storico prezzi annuale + earningsHistory per EPS
    try {
        if (result.earningsHistory.length >= 2) {
            // Calcola crescita EPS annua dagli ultimi quarter disponibili
            const validEps = result.earningsHistory.filter(h => h.epsActual !== null).reverse();
            if (validEps.length >= 2) {
                // EPS TTM = somma ultimi 4 quarter (se disponibili 4)
                const last4 = validEps.slice(0, 4);
                const epsTTM = last4.reduce((sum, h) => sum + (h.epsActual || 0), 0);

                // Crescita EPS Y/Y: confronto last2 vs prev2
                if (validEps.length >= 4) {
                    const epsYoy1 = validEps[0].epsActual;
                    const epsYoy2 = validEps[validEps.length > 4 ? 4 : validEps.length - 1].epsActual;
                    if (epsYoy2 && epsYoy2 > 0 && epsYoy1 > 0) {
                        const epsGrowthRate = (epsYoy1 - epsYoy2) / Math.abs(epsYoy2); // decimale
                        const currentPrice = result.financialData.currentPrice;
                        if (currentPrice && epsTTM > 0 && epsGrowthRate > 0) {
                            const peTrailing = currentPrice / epsTTM;
                            const pegCalc    = peTrailing / (epsGrowthRate * 100); // crescita in %
                            result.pegHistorical.push({
                                date:           new Date().toISOString().split('T')[0],
                                peTrailing:     Math.round(peTrailing * 100) / 100,
                                epsTTM:         Math.round(epsTTM * 100) / 100,
                                epsGrowthRate:  Math.round(epsGrowthRate * 10000) / 100, // in %
                                pegCalculated:  Math.round(pegCalc * 100) / 100,
                                note:           'Calcolato da EPS trailing 4Q e crescita Y/Y'
                            });
                        }
                    }
                }
            }
        }
    } catch (e) {
        logger.warn(`[Fundamentals] PEG historical calc error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'peg-historical-calc', error: e.message });
    }

    // Salva in cache
    fundamentalsCache.set(ticker, { ts: Date.now(), data: result });

    logger.info(`[Fundamentals] Done for ${ticker}: PEG=${result.pegRatio}, FCF TTM=${result.fcfTTM}, FCF annual records=${result.fcfAnnual.length}, quarterly=${result.fcfQuarterly.length}`);
    res.json(result);
});

/**
 * DELETE /api/fundamentals/:ticker/cache
 * Invalida la cache per un ticker specifico (utile per forzare refresh).
 */
app.delete('/api/fundamentals/:ticker/cache', requireAuth, (req, res) => {
    const ticker = (req.params.ticker || '').toUpperCase();
    const deleted = fundamentalsCache.delete(ticker);
    res.json({ ticker, cacheCleared: deleted });
});

// ════════════════════════════════════════════════════════════════════════════
// ASSETS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/assets', requireAuth, async (req, res) => {
    const userId = req.user.id;
    // Return all assets except CASH, with a flag indicating if they have an active position for THIS user
    const rows = database.db.prepare(`
        SELECT a.id, a.ticker, a.name, a.type, a.exchange, a.currency, a.currentPrice, 
               a.changePercent, a.changeValue, a.pe, a.country, a.isManual, a.updatedAt, 
               a.dataSource, a.isin, a.lastUpdateError, a.quoteDate, a.forwardPE, 
               a.dividendYield, a.eps, a.beta, a.nextDividendDate, 
               a.preMarketChangePercent, a.postMarketChangePercent, a.isMonitored,
               CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition,
               IFNULL(t.balance, 0) as totalQuantity,
               IFNULL(t.totalCostAsset, 0) as totalCostAssetCurr,
               CASE WHEN uw.user_id IS NOT NULL THEN 1 ELSE 0 END as inWatchlist,
               uw.targetPrice as userTargetPrice,
               uw.stopLoss as userStopLoss,
               uw.volatilityAlert as userVolatilityAlert,
               a.ai_action as aiAction,
               a.ai_reasoning as aiReasoning,
               a.ai_updated_at as aiUpdatedAt,
               (SELECT COUNT(*) FROM asset_ai_history ah WHERE ah.ticker = a.ticker) as aiHistoryCount
        FROM assets a
        LEFT JOIN (
            SELECT t.assetTicker, 
                   SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance,
                   SUM(CASE 
                        WHEN t.type = 'BUY' THEN (t.quantity * t.price + t.commission + t.tax)
                        WHEN t.type = 'SELL' THEN -(t.quantity * (SELECT AVG(t2.price) FROM transactions t2 JOIN portfolio_users pu2 ON t2.portfolioId = pu2.portfolio_id WHERE t2.assetTicker = t.assetTicker AND t2.type = 'BUY' AND pu2.user_id = ?))
                        ELSE 0 
                   END) as totalCostAsset
            FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE pu.user_id = ?
            GROUP BY t.assetTicker
        ) t ON a.ticker = t.assetTicker
        LEFT JOIN user_watchlist uw ON a.ticker = uw.ticker AND uw.user_id = ?
        WHERE a.ticker != 'CASH' AND (a.type != 'Cash' OR a.type IS NULL) 
        -- Only show what matters to the user in Market Overview: positions they own OR assets in their specific watchlist
        AND (hasPosition = 1 OR (uw.user_id IS NOT NULL))
        ORDER BY a.name ASC
    `).all(userId, userId, userId);

    // 1. Calculate holdings per portfolio to get specific PMCs (Filtered by user)
    const portfolioHoldings = {}; 
    const allP = database.db.prepare(`
        SELECT p.id, p.name, p.color, p.currency 
        FROM portfolios p
        JOIN portfolio_users pu ON p.id = pu.portfolio_id
        WHERE pu.user_id = ?
    `).all(userId);
    for (const p of allP) {
        const txs = database.db.prepare(`
            SELECT type, assetTicker, quantity, price, commission, tax, exchangeRate, amount 
            FROM transactions 
            WHERE portfolioId = ? 
            ORDER BY date ASC
        `).all(p.id);
        
        const pOpenMap = {};
        for (const t of txs) {
            if (!t.assetTicker || t.assetTicker === 'CASH') continue;
            const ticker = t.assetTicker;
            if (t.type === 'BUY') {
                if (!pOpenMap[ticker]) pOpenMap[ticker] = { qty: 0, cost: 0, costBase: 0 };
                const fx = t.exchangeRate || 1;
                const costBase = t.amount ? Math.abs(t.amount) : ((t.quantity * t.price + t.commission + t.tax) / fx);

                pOpenMap[ticker].qty += t.quantity;
                pOpenMap[ticker].cost += (t.quantity * t.price + t.commission + t.tax);
                pOpenMap[ticker].costBase += costBase;
            } else if (t.type === 'SELL') {
                if (pOpenMap[ticker] && pOpenMap[ticker].qty > 0) {
                    const pmc = pOpenMap[ticker].cost / pOpenMap[ticker].qty;
                    const pmcBase = pOpenMap[ticker].costBase / pOpenMap[ticker].qty;
                    pOpenMap[ticker].qty -= t.quantity;
                    pOpenMap[ticker].cost -= t.quantity * pmc;
                    pOpenMap[ticker].costBase -= t.quantity * pmcBase;
                    if (pOpenMap[ticker].qty <= 0.0001) delete pOpenMap[ticker];
                }
            }
        }
        for (const [ticker, data] of Object.entries(pOpenMap)) {
            if (!portfolioHoldings[ticker]) portfolioHoldings[ticker] = [];
            portfolioHoldings[ticker].push({
                name: p.name,
                color: p.color,
                currency: p.currency,
                qty: data.qty,
                costBase: data.costBase,
                pmc: data.cost / data.qty
            });
        }
    }

    const liveRate = await getEurUsdRate();
    const today = new Date().toISOString().split('T')[0];

    // Add sparkline data (last 7 days from cache)
    
        const aiHistoryStmt = database.db.prepare(`
            SELECT engine, action as aiAction, targetPrice as aiTargetPrice, created_at
            FROM asset_ai_history
            WHERE ticker = ? AND engine IS NOT NULL
            ORDER BY created_at DESC LIMIT 5
        `);
        const marketStatus = getMarketStatus();
        const result = rows.map(a => {
            const aiBadges = aiHistoryStmt.all(a.ticker);

        let sparkline = [];
        if (historicalPricesCache[a.ticker]) {
            const history = historicalPricesCache[a.ticker];
            const dates = Object.keys(history).sort();
            sparkline = dates.slice(-7).map(d => history[d]);
        }
        const isToday = a.quoteDate === today;
        const isUS = isUSMarket(a);
        const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
        const showVariation = isToday && openedToday;

        let totalGainEUR = 0;
        
        // Attach portfoliosInfo and compute totalGainEUR
        const portfoliosInfo = (portfolioHoldings[a.ticker] || []).map(ph => {
            const roi = (a.currentPrice > 0 && ph.pmc > 0) ? ((a.currentPrice - ph.pmc) / ph.pmc) * 100 : 0;
            
            const currentValAsset = ph.qty * (a.currentPrice || 0);
            let currentValBase = currentValAsset;
            if (a.currency === 'USD' && ph.currency === 'EUR') {
                currentValBase = currentValAsset / liveRate;
            } else if (a.currency === 'EUR' && ph.currency === 'USD') {
                currentValBase = currentValAsset * liveRate;
            }
            
            const gainBase = currentValBase - ph.costBase;
            
            let gainEUR = gainBase;
            if (ph.currency === 'USD') {
                gainEUR = gainBase / liveRate;
            }
            
            totalGainEUR += gainEUR;
            
            return {
                name: ph.name,
                color: ph.color,
                roi: roi
            };
        });

        return { 
            ...a, 
            sparkline,
            changePercent: showVariation ? a.changePercent : 0,
            changeValue: showVariation ? a.changeValue : 0,
            // Override global alert settings with user-specific ones
            targetPrice: a.userTargetPrice !== null ? a.userTargetPrice : a.targetPrice,
            stopLoss: a.userStopLoss !== null ? a.userStopLoss : a.stopLoss,
            volatilityAlert: a.userVolatilityAlert !== null ? a.userVolatilityAlert : a.volatilityAlert,
            portfoliosInfo,
            totalGainEUR,
            aiBadges
        };
    });

    res.json(result);
});

// Historical quotes for a specific asset (for chart popup)
app.get('/api/asset-quotes/:ticker', (req, res) => {
    const { ticker } = req.params;
    const { from, to } = req.query;
    try {
        let sql = `SELECT date, price FROM asset_quotes WHERE UPPER(ticker) = UPPER(?) ORDER BY date ASC`;
        const params = [ticker];
        if (from && to) {
            sql = `SELECT date, price FROM asset_quotes WHERE UPPER(ticker) = UPPER(?) AND date >= ? AND date <= ? ORDER BY date ASC`;
            params.push(from, to);
        }
        const rows = database.db.prepare(sql).all(...params);
        res.json(rows);
    } catch (err) {
        logger.error('Error fetching asset quotes', err);
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/assets/manual-update', async (req, res) => {
    const { ticker, price, date, type, country, dataSource, isin } = req.body;
    if (!ticker) return res.status(400).send('Ticker is required');
    const sanitizedTicker = sanitizeTicker(ticker);
    if (!isValidISIN(isin)) return res.status(400).send('Invalid ISIN format (must be 12 chars e.g. IT000...)');

    database.db.prepare(`
        UPDATE assets 
        SET currentPrice = ?, updatedAt = ?, isManual = 1, changePercent = 0,
            type = COALESCE(?, type), country = COALESCE(?, country),
            dataSource = COALESCE(?, dataSource), isin = COALESCE(?, isin),
            lastUpdateError = NULL
        WHERE ticker = ?
    `).run(
        parseFloat(price), 
        date || new Date().toISOString().split('T')[0], 
        type || null,
        country || null,
        dataSource || 'YF',
        isin ? isin.toUpperCase().trim() : null,
        sanitizedTicker
    );
    
    const liveRate = await getEurUsdRate();
    await recalculateAllPortfoliosWithOverrides(liveRate);
    clearPerformanceCache();
    res.json({ success: true });
});

app.post('/api/assets/toggle-manual', (req, res) => {
    const { ticker, isManual } = req.body;
    database.db.prepare(`UPDATE assets SET isManual = ? WHERE ticker = ?`).run(isManual ? 1 : 0, ticker);
    res.json({ success: true });
});

app.get('/api/assets/:id', (req, res) => {
    const row = database.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Asset not found');
    res.json(row);
});

// Borsa Italiana Debug Endpoint
app.post('/api/debug/borsa-italiana', async (req, res) => {
    const { isin, assetType } = req.body;
    if (!isin) return res.status(400).send('ISIN is required');
    const result = await B_ITA(isin, assetType);
    res.json(result);
});

// Import historical data (usually from frontend scraper)
app.post('/api/assets/import-history', (req, res) => {
    const { ticker, history } = req.body; // history: [{dt, closePx}, ...]
    if (!ticker || !history || !Array.isArray(history)) {
        return res.status(400).send('Ticker and history array are required');
    }

    try {
        const insert = database.db.prepare('INSERT OR REPLACE INTO asset_quotes (ticker, date, price) VALUES (?, ?, ?)');
        database.db.transaction(() => {
            for (const entry of history) {
                // Handle different date formats (YYYYMMDD from Bitaly or YYYY-MM-DD)
                let dateStr = entry.dt || entry.date;
                if (dateStr.length === 8 && !dateStr.includes('-')) {
                    dateStr = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
                }
                const price = parseFloat(entry.closePx || entry.price);
                if (dateStr && !isNaN(price)) {
                    insert.run(ticker, dateStr, price);
                }
            }
        })();
        
        logger.info(`Imported ${history.length} historical quotes for ${ticker}`);
        clearPerformanceCache();
        res.json({ success: true, count: history.length });
    } catch (err) {
        logger.error(`Failed to import history for ${ticker}`, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/assets', requireAuth, async (req, res) => {
    try {
        let { ticker, name, type, currency, exchange, pe, currentPrice, changePercent, isin, dataSource } = req.body;
        ticker = sanitizeTicker(ticker);
        if (!ticker) return res.status(400).send('Invalid Ticker');
        if (!isValidISIN(isin)) return res.status(400).send('Invalid ISIN format');

        let assetData = {
            id:           ticker || `MANUAL-${Date.now()}`,
            ticker:       ticker || '',
            name:         name   || ticker || 'Unknown',
            type:         type   || 'Other',
            exchange:     exchange || 'Unknown',
            currency:     currency || 'USD',
            currentPrice: parseFloat(currentPrice || 0),
            changePercent:parseFloat(changePercent || 0),
            pe:           pe ? parseFloat(pe) : null,
            dataSource:   req.body.dataSource || 'YF',
            isin:         req.body.isin || null
        };

        if (ticker) {
            const metadata = await fetchAssetMetadata(ticker);
            if (metadata) {
                assetData = {
                    id:           ticker,
                    ticker,
                    name:         name || metadata.name,
                    type:         type || metadata.type,
                    exchange:     exchange || metadata.exchange,
                    currency:     currency || metadata.currency,
                    currentPrice: parseFloat(currentPrice || metadata.currentPrice),
                    changePercent:parseFloat(changePercent || metadata.changePercent),
                    pe:           pe ? parseFloat(pe) : metadata.pe,
                    forwardPE:    metadata.forwardPE,
                    dividendYield:metadata.dividendYield,
                    eps:          metadata.eps,
                    beta:         metadata.beta,
                    nextDividendDate: metadata.nextDividendDate,
                    country:      metadata.country,
                    dataSource:   dataSource || 'YF',
                    isin:         isin || metadata.isin || null
                };
            }
        }

        const existing = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(assetData.ticker);
        if (existing && assetData.ticker) return res.status(400).send('Asset already in monitoring list');

        database.db.prepare(`
            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, forwardPE, dividendYield, eps, beta, pegRatio, nextDividendDate, country, dataSource, isin, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            assetData.id, assetData.ticker, assetData.name, assetData.type,
            assetData.exchange, assetData.currency, assetData.currentPrice,
            assetData.changePercent, assetData.pe, assetData.forwardPE || null,
            assetData.dividendYield || null, assetData.eps || null, assetData.beta || null,
            assetData.pegRatio || null, assetData.nextDividendDate || null, assetData.country,
            assetData.dataSource || 'YF', assetData.isin || null
        );

        res.status(201).json(assetData);
    } catch (err) {
        console.error('Add asset error:', err);
        res.status(500).send('Failed to add asset: ' + err.message);
    }
});

app.put('/api/assets/:id', requireAuth, (req, res) => {
    const { targetPrice, stopLoss, volatilityAlert, isMonitored, dataSource, isin, name, type, exchange, currency, currentPrice, changePercent, pe } = req.body;
    
    // 1. Update Asset Metadata (Global)
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (type !== undefined) { updates.push("type = ?"); params.push(type); }
    if (exchange !== undefined) { updates.push("exchange = ?"); params.push(exchange); }
    if (currency !== undefined) { updates.push("currency = ?"); params.push(currency); }
    if (currentPrice !== undefined) { updates.push("currentPrice = ?"); params.push(currentPrice); }
    if (changePercent !== undefined) { updates.push("changePercent = ?"); params.push(changePercent); }
    if (pe !== undefined) { updates.push("pe = ?"); params.push(pe); }
    if (isMonitored !== undefined) { updates.push("isMonitored = ?"); params.push(isMonitored); }
    if (dataSource !== undefined) { updates.push("dataSource = ?"); params.push(dataSource); }
    if (isin !== undefined) { updates.push("isin = ?"); params.push(isin); }
    
    if (updates.length > 0) {
        params.push(req.params.id);
        params.push(req.params.id);
        database.db.prepare(`UPDATE assets SET ${updates.join(', ')} WHERE id = ? OR ticker = ?`).run(...params);
    }

    // 2. Update User Alerts (Private)
    const tickerParam = req.params.id; 
    const watchUpdates = [];
    const watchParams = [];
    if (targetPrice !== undefined) { watchUpdates.push("targetPrice = ?"); watchParams.push(targetPrice); }
    if (stopLoss !== undefined) { watchUpdates.push("stopLoss = ?"); watchParams.push(stopLoss); }
    if (volatilityAlert !== undefined) { watchUpdates.push("volatilityAlert = ?"); watchParams.push(volatilityAlert); }
    
    if (watchUpdates.length > 0) {
        try {
            // First ensure the row exists
            const actualTickerRow = database.db.prepare(`SELECT ticker FROM assets WHERE id = ? OR ticker = ?`).get(tickerParam, tickerParam);
            if (actualTickerRow) {
                const ticker = actualTickerRow.ticker;
                database.db.prepare(`INSERT OR IGNORE INTO user_watchlist (user_id, ticker) VALUES (?, ?)`).run(req.user.id, ticker);
                database.db.prepare(`
                    UPDATE user_watchlist 
                    SET ${watchUpdates.join(', ')} 
                    WHERE user_id = ? AND ticker = ?
                `).run(...watchParams, req.user.id, ticker);
            }
        } catch (e) {
            logger.error('Error updating user watchlist in PUT /api/assets', e);
        }
    }

    res.json({ success: true });
});
app.post('/api/assets/split', requireAuth, async (req, res) => {
    const { oldTicker, newTicker, ratio, splitDate } = req.body;
    
    if (!oldTicker || !ratio || !splitDate) {
        return res.status(400).json({ error: 'oldTicker, ratio and splitDate are required' });
    }

    const r = parseFloat(ratio);
    if (isNaN(r) || r <= 0) {
        return res.status(400).json({ error: 'Invalid ratio' });
    }

    const targetTicker = newTicker && newTicker.trim() !== '' ? newTicker.trim() : oldTicker;
    
    try {
        // Find existing asset
        const asset = database.db.prepare('SELECT * FROM assets WHERE ticker = ?').get(oldTicker);
        if (!asset) return res.status(404).json({ error: 'Asset not found' });

        database.db.transaction(() => {
            // 1. Rename Ticker if provided
            if (targetTicker !== oldTicker) {
                // Insert new asset if not exists
                database.db.prepare(`
                    INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `).run(targetTicker, targetTicker, asset.name, asset.type, asset.exchange, asset.currency, asset.currentPrice, asset.changePercent, asset.pe, asset.country, asset.isManual, asset.dataSource, asset.isin);
                
                // Update all relations
                database.db.prepare('UPDATE transactions SET assetTicker = ? WHERE assetTicker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_quotes SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE user_watchlist SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE dividend_projections SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_ai_analyses SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_ai_history SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                
                // Try deleting old asset if it has no remaining relations
                try {
                    database.db.prepare('DELETE FROM assets WHERE ticker = ?').run(oldTicker);
                } catch (e) {
                    // Ignore foreign key constraints if it's still linked somewhere unexpected
                }
            }

            // 2. Adjust Transactions
            // Multiply quantity, divide price for dates <= splitDate
            database.db.prepare(`
                UPDATE transactions 
                SET quantity = quantity * ?, price = price / ?
                WHERE assetTicker = ? AND date <= ? AND type != 'SPLIT'
            `).run(r, r, targetTicker, splitDate);

            // 3. Adjust Asset Quotes
            database.db.prepare(`
                UPDATE asset_quotes
                SET price = price / ?
                WHERE ticker = ? AND date <= ?
            `).run(r, targetTicker, splitDate);
            
            // 4. Insert Audit Split Transaction in all portfolios containing the asset
            const portfolios = database.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
            const insertTx = database.db.prepare(`
                INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
                VALUES (?, 'SPLIT', ?, ?, ?, 0, 0)
            `);
            for (const p of portfolios) {
                insertTx.run(p.portfolioId, targetTicker, splitDate, r);
            }
        })();

        // Re-fetch current price if possible (background)
        if (asset.dataSource !== 'MANUAL') {
            fetchAssetMetadata(targetTicker).then(m => {
                if (m && m.currentPrice) {
                    database.db.prepare('UPDATE assets SET currentPrice = ? WHERE ticker = ?').run(m.currentPrice, targetTicker);
                }
            }).catch(e => logger.error('Error refreshing split asset metadata:', e));
        }

        // Rebuild portfolios and clear cache
        const portfolios = database.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
        const liveRate = await getEurUsdRate();
        for (const p of portfolios) {
            database.recalculatePortfolio(p.portfolioId, liveRate);
            triggerHistoryRebuild(p.portfolioId);
        }
        clearPerformanceCache();

        res.json({ success: true, newTicker: targetTicker });
    } catch (err) {
        logger.error('Error during asset split:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/assets/:id', requireAuth, (req, res) => {
    // Assets are global, but we can delete from the user's watchlist
    try {
        database.db.prepare(`DELETE FROM user_watchlist WHERE user_id = ? AND ticker = (SELECT ticker FROM assets WHERE id = ? OR ticker = ?)`).run(req.user.id, req.params.id, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── MARKET SEARCH API ───────────────────────────────────────────────────────

app.get('/api/market/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    try {
        const results = await yahooFinance.search(q);
        const suggestions = results.quotes
            .filter(quote => quote.isYahooFinance)
            .map(quote => ({
                ticker: quote.symbol,
                name: quote.shortname || quote.longname || quote.symbol,
                exchange: quote.exchDisp || quote.exch,
                type: quote.quoteType || 'Equity'
            }));
        res.json(suggestions);
    } catch (err) {
        console.error('Search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/market/indices', async (req, res) => {
    const symbols = ['FTSEMIB.MI', 'BTC-USD', '^GSPC', '^IXIC'];
    const names = {
        'FTSEMIB.MI': 'FTSE MIB',
        'BTC-USD': 'Bitcoin',
        '^GSPC': 'S&P 500',
        '^IXIC': 'Nasdaq'
    };
    try {
        const quotes = await Promise.all(symbols.map(s => 
            yahooFinance.quote(s).catch(err => {
                console.error(`Error fetching index ${s}:`, err.message);
                return null;
            })
        ));
        const result = quotes.filter(q => q).map(q => ({
            symbol: q.symbol,
            name: names[q.symbol] || q.symbol,
            price: q.regularMarketPrice,
            changePercent: q.regularMarketChangePercent,
            currency: q.currency
        }));
        res.json(result);
    } catch (err) {
        console.error('Indices fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── WATCHLIST API ──────────────────────────────────────────────────────────

app.get('/api/watchlist', requireAuth, (req, res) => {
    try {
        const rows = database.db.prepare(`
            SELECT a.*, 
                   uw.targetPrice as userTargetPrice,
                   uw.stopLoss as userStopLoss,
                   uw.volatilityAlert as userVolatilityAlert,
                   a.ai_action as aiAction,
                   a.ai_reasoning as aiReasoning,
                   a.ai_updated_at as aiUpdatedAt,
                   a.ai_engine as aiEngine,
                   a.targetPrice as aiTargetPrice,
                   (SELECT COUNT(*) FROM asset_ai_history ah WHERE ah.ticker = a.ticker) as aiHistoryCount,
                   CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition
            FROM assets a
            JOIN user_watchlist uw ON a.ticker = uw.ticker
            LEFT JOIN (
                SELECT assetTicker, 
                       SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
                FROM transactions 
                WHERE portfolioId IN (SELECT portfolio_id FROM portfolio_users WHERE user_id = ?)
                GROUP BY assetTicker
            ) t ON a.ticker = t.assetTicker
            WHERE uw.user_id = ? AND a.ticker != 'CASH'
            ORDER BY a.ticker ASC
        `).all(req.user.id, req.user.id);
        
        const today = new Date().toISOString().split('T')[0];

        const aiHistoryStmt = database.db.prepare(`
            SELECT engine, action as aiAction, targetPrice as aiTargetPrice, created_at
            FROM asset_ai_history
            WHERE ticker = ? AND engine IS NOT NULL
            ORDER BY created_at DESC LIMIT 5
        `);
        const marketStatus = getMarketStatus();
        const result = rows.map(a => {
            const aiBadges = aiHistoryStmt.all(a.ticker);

            let sparkline = [];
            if (historicalPricesCache[a.ticker]) {
                const history = historicalPricesCache[a.ticker];
                const dates = Object.keys(history).sort();
                sparkline = dates.slice(-7).map(d => history[d]);
            }
            const isToday = a.quoteDate === today;
            const isUS = isUSMarket(a);
            const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
            const showVariation = isToday && openedToday;
            
            return { 
                ...a, 
                targetPrice: a.userTargetPrice,
                stopLoss: a.userStopLoss,
                aiEngine: a.aiEngine,
                aiTargetPrice: a.aiTargetPrice,
                aiAction: a.aiAction,
                aiReasoning: a.aiReasoning,
                aiBadges,
                volatilityAlert: a.userVolatilityAlert,
                inWatchlist: 1,
                sparkline,
                changePercent: showVariation ? (a.changePercent || 0) : 0,
                changeValue: showVariation ? (a.changeValue || 0) : 0
            };
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/watchlist', requireAuth, async (req, res) => {
    const { ticker, targetPrice, stopLoss, volatilityAlert } = req.body;
    if (!ticker) return res.status(400).send('Ticker is required');

    try {
        const normalizedTicker = ticker.trim().toUpperCase();
        
        // 1. Check if asset already exists in DB
        let asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
        
        if (!asset) {
            // 2. Fetch robust metadata
            const metadata = await fetchAssetMetadata(normalizedTicker);
            if (metadata) {
                database.db.prepare(`
                    INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, changeValue, pe, country, isin, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `).run(
                    normalizedTicker, normalizedTicker, metadata.name, metadata.type, metadata.exchange, metadata.currency, metadata.currentPrice, metadata.changePercent, metadata.changeValue || 0, metadata.pe, metadata.country, metadata.isin || null
                );
                asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
            } else {
                return res.status(404).send('Ticker not found on Yahoo Finance');
            }
        }

        // 3. Add to user_watchlist
        database.db.prepare(`
            INSERT INTO user_watchlist (user_id, ticker, targetPrice, stopLoss, volatilityAlert)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, ticker) DO UPDATE SET
                targetPrice = COALESCE(excluded.targetPrice, targetPrice),
                stopLoss = COALESCE(excluded.stopLoss, stopLoss),
                volatilityAlert = COALESCE(excluded.volatilityAlert, volatilityAlert)
        `).run(req.user.id, normalizedTicker, targetPrice, stopLoss, volatilityAlert);

        res.json({ ok: true, ticker: normalizedTicker });
        triggerHistoryRebuild(null);
    } catch (err) {
        console.error('Watchlist add error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/watchlist/:ticker', requireAuth, (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const result = database.db.prepare('DELETE FROM user_watchlist WHERE user_id = ? AND ticker = ?').run(req.user.id, ticker);
        logger.info(`Watchlist delete: user ${req.user.id}, ticker ${ticker}, affectedRows: ${result.changes}`);
        res.json({ ok: true, changes: result.changes });
    } catch (err) {
        console.error('Watchlist delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/watchlist/performance', requireAuth, async (req, res) => {
    try {
        const watchlist = database.db.prepare(`
            SELECT a.ticker 
            FROM assets a
            JOIN user_watchlist uw ON a.ticker = uw.ticker
            WHERE uw.user_id = ? 
              AND a.ticker != 'CASH' 
              AND IFNULL(a.type, '') != 'Liquidità' 
              AND a.ticker NOT LIKE 'CD_%'
        `).all(req.user.id);
        const results = {};
        
        const nowDate = new Date();
        const oneWeekAgo = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const oneMonthAgo = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        const oneYearAgo = new Date(nowDate.getTime() - 365 * 24 * 60 * 60 * 1000);

        // Fetch in parallel
        await Promise.all(watchlist.map(async (item) => {
            const ticker = item.ticker;
            try {
                // Fetch historical data from YF
                const historical = await yahooFinance.historical(ticker, {
                    period1: oneYearAgo,
                    period2: nowDate,
                    interval: '1d'
                }).catch(() => []);

                if (historical.length > 0) {
                    const quote = await yahooFinance.quote(ticker).catch(() => null);
                    const currentPrice = quote?.regularMarketPrice || 0;
                    
                    if (currentPrice > 0) {
                        const getPerformance = (pastDate, minDaysDiff) => {
                            // Find the entry closest to the pastDate (first entry that is >= pastDate)
                            const pastEntry = historical.find(h => new Date(h.date) >= pastDate);
                            if (pastEntry && pastEntry.close) {
                                // Validate if the date found is actually "past" enough
                                const diffDays = (nowDate - new Date(pastEntry.date)) / (1000 * 3600 * 24);
                                if (diffDays < minDaysDiff) return null;

                                return ((currentPrice - pastEntry.close) / pastEntry.close) * 100;
                            }
                            return null;
                        };

                        results[ticker] = {
                            perf1W: getPerformance(oneWeekAgo, 4),   // 1W needs at least 4 days back (handles weekends)
                            perf1M: getPerformance(oneMonthAgo, 20), // 1M needs at least 20 days back
                            perf1Y: getPerformance(oneYearAgo, 300)  // 1Y needs at least 300 days back
                        };
                    }
                }
            } catch (e) {
                console.error(`Error fetching performance for ${ticker}:`, e.message);
            }
        }));

        watchlistPerformanceCache.data = results;
        watchlistPerformanceCache.lastUpdated = now;
        res.json(results);
    } catch (err) {
        console.error('Watchlist performance error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assets/:ticker/history', async (req, res) => {
    const { ticker } = req.params;
    const { range } = req.query;
    
    try {
        const now = new Date();
        const rangeMap = {
            '1W': 7,
            '2W': 14,
            '1M': 30,
            '3M': 90,
            '6M': 180,
            '1Y': 365,
            'ALL': 3650
        };
        const days = rangeMap[range] || 30; // 1M default
        const period1 = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

        const historical = await yahooFinance.historical(ticker, {
            period1: period1,
            period2: now,
            interval: '1d'
        }).catch(() => []);

        // Filter and map for Chart.js
        const result = historical
            .filter(h => h.close !== null && h.close !== undefined)
            .map(h => ({
                date: h.date instanceof Date ? h.date.toISOString().split('T')[0] : h.date,
                price: h.close
            }));

        res.json(result);
    } catch (err) {
        console.error(`Error fetching history for ${ticker}:`, err.message);
        res.json([]);
    }
});

app.get('/api/assets/:ticker/portfolios', requireAuth, (req, res) => {
    const { ticker } = req.params;
    const userId = req.user.id;
    try {
        const rows = database.db.prepare(`
            SELECT DISTINCT p.id, p.name 
            FROM portfolios p
            JOIN transactions t ON p.id = t.portfolioId
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE t.assetTicker = ? AND pu.user_id = ?
        `).all(ticker, userId);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assets/:ticker/details', async (req, res) => {
    const { ticker } = req.params;
    try {
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'calendarEvents', 'fundProfile']
        });
        
        // Enrich with ISIN from DB
        const asset = database.db.prepare(`SELECT isin FROM assets WHERE ticker = ?`).get(ticker);
        const enriched = { 
            ...summary, 
            dbIsin: asset ? asset.isin : null 
        };
        
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/assets/:id', (req, res) => {
    const asset = database.db.prepare(`SELECT * FROM assets WHERE id = ? OR ticker = ?`).get(req.params.id, req.params.id);
    if (!asset) return res.status(404).send('Asset not found');

    // 1. Check for transactions/positions
    // We check if it's used in any transaction
    const txCount = database.db.prepare(`SELECT COUNT(*) as count FROM transactions WHERE assetTicker = ?`).get(asset.ticker).count;
    
    // 2. Check for open positions (simplified: if sum(qty) > 0 in any portfolio)
    // Actually, if we just check if it's used in any transaction, we might want to keep it as "referenced".
    // But the user specifically asked for "remove from monitoring if NO OPEN POSITIONS".

    
    let hasOpenPosition = false;
    const portfolios = database.db.prepare(`SELECT id FROM portfolios`).all();
    for (const p of portfolios) {
        const txs = database.db.prepare(`SELECT type, quantity FROM transactions WHERE portfolioId = ? AND assetTicker = ?`).all(p.id, asset.ticker);
        let qty = 0;
        for (const t of txs) {
            if (t.type === 'BUY') qty += t.quantity;
            if (t.type === 'SELL') qty -= t.quantity;
        }
        if (Math.abs(qty) > 0.000001) {
            hasOpenPosition = true;
            break;
        }
    }

    if (hasOpenPosition) {
        return res.status(400).send('Cannot stop monitoring an asset with active positions.');
    }

    if (txCount > 0) {
        // Just hide from monitoring, keep for historical records
        database.db.prepare(`UPDATE assets SET isMonitored = 0 WHERE id = ?`).run(req.params.id);
        res.json({ ...asset, isMonitored: 0 });
    } else {
        // No transactions at all, safe to hard delete
        database.db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id);
        res.json({ ...asset, deleted: true });
    }
});

// ─── NOTIFICATIONS API ────────────────────────────────────────────────

app.get('/api/notifications', requireAuth, (req, res) => {
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

app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    try {
        database.db.prepare(`UPDATE notifications SET isRead = 1 WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/read-all', requireAuth, (req, res) => {
    try {
        database.db.prepare(`UPDATE notifications SET isRead = 1 WHERE user_id = ?`).run(req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
    try {
        database.db.prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/notifications', requireAuth, (req, res) => {
    try {
        database.db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIOS API
// ════════════════════════════════════════════════════════════════════════════

// ─── Tags APIs ──────────────────────────────────────────────────────────────



async function getAllPortfolioStats(userId = null, liveRateInput = null, tagIds = null) {
    let liveRate = liveRateInput;
    if (!liveRate) {
        liveRate = await getEurUsdRate();
    }
    
    // Determine which portfolios to include based on tags if provided
    let portfolioFilterSql = '';
    let params = [userId];
    if (tagIds && tagIds.length > 0) {
        const placeholders = tagIds.map(() => '?').join(',');
        portfolioFilterSql = ` AND p.id IN (SELECT portfolio_id FROM portfolio_tags WHERE tag_id IN (${placeholders}))`;
        params = [...params, ...tagIds];
    }

    const { overrides, marketStatus } = await recalculateAllPortfoliosWithOverrides(liveRate);
    
    let rows;
    if (userId) {
        rows = database.db.prepare(`
            SELECT p.* FROM portfolios p
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE pu.user_id = ? ${portfolioFilterSql}
            ORDER BY p.createdAt ASC
        `).all(...params);
    } else {
        rows = database.db.prepare(`SELECT * FROM portfolios ORDER BY createdAt ASC`).all();
    }

    // Load tags for each portfolio
    for (const p of rows) {
        p.tags = database.db.prepare(`
            SELECT t.* FROM tags t
            JOIN portfolio_tags pt ON t.id = pt.tag_id
            WHERE pt.portfolio_id = ?
        `).all(p.id);
    }
    
    // Get FX Variation metadata for EURUSD
    const fxData = database.db.prepare("SELECT changePercent FROM assets WHERE ticker='EURUSD=X'").get() || { changePercent: 0 };
    const eurUsdChangePct = fxData.changePercent || 0;
    const rateToday = liveRate;
    const rateYesterday = rateToday / (1 + eurUsdChangePct/100);

    const pIds = rows.map(r => r.id);
    const perfData = await calculatePerformanceHistory(pIds, 'ALL', false, true, null, userId, tagIds);
    const globalPoints = perfData.dataPoints || [];
    const individual = perfData.individual || {};

    let totalValueEUR = 0;
    let totalNetValueEUR = 0;
    let totalTaxEUR = 0;
    let globalChangeEUR = 0;
    let globalChangePrePostEUR = 0;

    const today = new Date();

    for (const p of rows) {
        const rate = (p.currency === 'USD') ? rateToday : 1;
        const prevRate = (p.currency === 'USD') ? rateYesterday : 1;
        
        p.changeValue = (isNaN(p.performance1D) || !isFinite(p.performance1D)) ? 0 : (p.performance1D || 0);
        p.changeValuePrePost = (isNaN(p.performance1DPrePost) || !isFinite(p.performance1DPrePost)) ? 0 : (p.performance1DPrePost || 0);

        // Get accurate real-time details
        const details = await getPortfolioDetails(p.id, rateToday);
        p.totalValue = details.totalValue || 0;
        p.totalTax = details.totalLatentTax || 0;
        p.netValue = p.totalValue - p.totalTax;
        p.currentCash = details.currentCash || 0;
        p.roi = details.roi || 0;
        p.twr = details.twr || 0;
        p.xirr = details.xirr || 0;
        p.minusvalenze = Object.values(details.losses || {}).reduce((s, a) => s + a, 0);

        const vCurr = p.totalValue;
        const vDelta = p.changeValue + p.changeValuePrePost;
        const vPrev = vCurr - vDelta;

        // Calculate real EUR variation including FX move on whole equity
        const vCurrEUR = vCurr / rate;
        const vPrevEUR = vPrev / prevRate;
        const vDeltaEUR_Total = vCurrEUR - vPrevEUR;
        p.changeValueEUR = vDeltaEUR_Total;
        p.netValue = p.totalValue - p.totalTax;
        
        // Split between regular/PP for the Hero pill
        const ratioReg = vDelta !== 0 ? (p.performance1D / vDelta) : 1;
        
        // Aggregate totals
        totalValueEUR += vCurrEUR;
        totalTaxEUR += p.totalTax / rate;
        totalNetValueEUR += p.netValue / rate;
        globalChangeEUR += vDeltaEUR_Total * ratioReg;
        globalChangePrePostEUR += vDeltaEUR_Total * (1 - ratioReg);

        const history = individual[p.id] || [];
        if (history.length > 0) {
            const last = history[history.length - 1];
            const d7 = new Date(today); d7.setDate(today.getDate() - 7);
            const d7Str = d7.toISOString().split('T')[0];
            const firstW = history.findLast(h => h.date <= d7Str) || history[0];
            const d30 = new Date(today); d30.setMonth(today.getMonth() - 1);
            const d30Str = d30.toISOString().split('T')[0];
            const firstM = history.findLast(h => h.date <= d30Str) || history[0];
            p.changeValue1W = last.profit - firstW.profit;
            p.changePercent1W = firstW.value > 0 ? (p.changeValue1W / firstW.value) * 100 : 0;
            p.changeValue1M = last.profit - firstM.profit;
            p.changePercent1M = firstM.value > 0 ? (p.changeValue1M / firstM.value) * 100 : 0;
        } else {
            p.changeValue1W = 0; p.changePercent1W = 0;
            p.changeValue1M = 0; p.changePercent1M = 0;
        }
    }


    const heldAssetsRaw = userId ? database.db.prepare(`
        SELECT a.ticker, a.name, a.changePercent, a.currentPrice, a.currency, a.quoteDate, SUM(h.netQty) as totalNetQty
        FROM assets a
        JOIN (
            SELECT t.assetTicker, 
                   SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as netQty 
            FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            JOIN portfolios p ON t.portfolioId = p.id
            WHERE pu.user_id = ? AND p.include_in_totals != 0 AND t.assetTicker IS NOT NULL AND t.assetTicker != 'CASH'
            GROUP BY t.assetTicker 
            HAVING netQty > 0.001
        ) h ON a.ticker = h.assetTicker
        GROUP BY a.ticker
    `).all(userId) : [];

    const todayStr = new Date().toISOString().split('T')[0];
    const heldAssets = heldAssetsRaw.map(a => {
        let changePct = a.changePercent || 0;
        const isUS = isUSMarket(a);
        const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
        const preMktActive = isUS ? marketStatus.US_preMarketActive : false;
        const isToday = a.quoteDate === todayStr;

        if (!(openedToday && isToday)) {
            if (preMktActive && a.preMarketChangePercent) {
                changePct = a.preMarketChangePercent;
            }
        }

        const rate = (a.currency === 'USD') ? rateToday : 1;
        const absChange = (a.currentPrice * changePct / 100) * a.totalNetQty / rate;
        return { ticker: a.ticker, name: a.name, changePercent: changePct, absChange };
    });
    
    const heldAssetsPct = [...heldAssets].sort((a,b) => b.changePercent - a.changePercent);
    const heldAssetsAbs = [...heldAssets].sort((a,b) => (b.absChange || 0) - (a.absChange || 0));

    const lastPoint = globalPoints.at(-1) || { value: 0, profit: 0, netDeposits: 0 };

    const watchlistTickers = userId ? database.db.prepare(`SELECT ticker FROM user_watchlist WHERE user_id = ?`).all(userId).map(r => r.ticker) : [];
    const portfolioTickers = heldAssetsRaw.map(a => a.ticker);
    const uniqueTickers = [...new Set([...watchlistTickers, ...portfolioTickers])];

    return {
        portfolios: rows,
        totalValue: totalValueEUR,
        totalNetValue: totalNetValueEUR,
        totalTax: totalTaxEUR,
        totalChange: globalChangeEUR,
        totalChangePrePost: globalChangePrePostEUR,
        totalGain: lastPoint.profit || 0,
        investedCapital: totalNetValueEUR - (lastPoint.profit || 0),
        changePercent: (totalValueEUR - globalChangeEUR - globalChangePrePostEUR) > 0 
            ? ((globalChangeEUR + globalChangePrePostEUR) / (totalValueEUR - globalChangeEUR - globalChangePrePostEUR)) * 100 
            : 0,
        topWinners: heldAssetsPct.slice(0, 5),
        topLosers: heldAssetsPct.slice(-5).reverse(),
        topWinnersAbs: heldAssetsAbs.slice(0, 5),
        topLosersAbs: heldAssetsAbs.slice(-5).reverse(),
        userTickers: uniqueTickers
    };
}

// ─── Global API Authentication Guard ─────────────────────────────────────────
// Protects ALL /api/* routes except the explicitly public ones
const PUBLIC_API_PATHS = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/app-version'
]);
app.use('/api/', (req, res, next) => {
    const fullPath = req.path === '/' ? '/api/' : `/api${req.path}`;
    // Allow public paths
    if (PUBLIC_API_PATHS.has(req.baseUrl + req.path) || PUBLIC_API_PATHS.has('/api' + req.path)) return next();
    // Apply auth check
    return requireAuth(req, res, next);
});

app.get('/api/portfolios', requireAuth, async (req, res) => {
    try {
        const tagIds = req.query.tagIds ? req.query.tagIds.split(',').map(Number) : null;
        const stats = await getAllPortfolioStats(req.user.id, null, tagIds);
        res.json({
            portfolios: stats.portfolios,
            global: {
                totalValue: stats.totalValue,
                totalNetValue: stats.totalNetValue,
                totalTax: stats.totalTax,
                totalGain: stats.totalGain,
                investedCapital: stats.investedCapital,
                changeValue: stats.totalChange,
                changeValuePrePost: stats.totalChangePrePost,
                changePercent: stats.changePercent,
                topWinners: stats.topWinners,
                topLosers: stats.topLosers,
                topWinnersAbs: stats.topWinnersAbs,
                topLosersAbs: stats.topLosersAbs
            }
        });
    } catch (err) {
        console.error('API Error /api/portfolios:', err);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

app.get('/api/performance', requireAuth, async (req, res) => {
    try {
        const { range, benchmark, tagIds } = req.query;
        const tags = tagIds ? tagIds.split(',').map(Number) : null;
        const data = await calculatePerformanceHistory(null, range || '1Y', false, true, benchmark, req.user.id, tags);
        res.json(data);
    } catch (err) {
        console.error('API Error /api/performance:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper to calculate holdings for a portfolio
/**
 * Helper to calculate ALL details for a portfolio (holdings, taxes, allocation, dividends, etc.)
 * This is the SINGLE SOURCE OF TRUTH for portfolio content.
 */
function getAssetTypeColor(type) {
    const t = (type || 'Other').toUpperCase();
    
    if (t.includes('LIQUID') || t.includes('CASH')) return '#166534'; // Verde Scuro
    if (t.includes('DEPOSITO') || t.includes('CONTO')) return '#15803d'; // Verde Medio
    if (t.includes('MONETARIO')) return '#4ade80'; // Verde Chiaro
    if (t.includes('BOND') || t.includes('OBBLIG')) return '#eab308'; // Giallo
    if (t.includes('ETF AZION') || t.includes('ETF')) return '#f97316'; // Arancio
    if (t.includes('AZION') || t.includes('STOCK') || t.includes('EQUITY')) return '#ef4444'; // Rosso
    if (t.includes('CRYPTO') || t.includes('VALUTA')) return '#8b5cf6'; // Viola
    
    return '#94a3b8'; // Slate
}

async function getPortfolioDetails(portfolioId, liveRate = null) {
    const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) throw new Error('Portfolio non trovato');

    const transactions = database.db.prepare(`
        SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC
    `).all(portfolioId);

    const today = new Date().toISOString().split('T')[0];

    if (!liveRate) {
        liveRate = await getEurUsdRate();
    }

    const openMap     = {};   // { ticker: {shares: 0, totalCostInPCurr: 0, totalCostInAssetCurr: 0} }
    const closedByKey = {};   // key = ticker|year
    const dividends   = [];

    for (const t of transactions) {
        const qty    = t.quantity     || 0;
        const price  = t.price        || 0;
        const comm   = t.commission   || 0;
        const tax    = t.tax          || 0;
        const fx     = t.exchangeRate || 1;
        const amount = t.amount       || 0;
        const year   = (t.date || '').substring(0, 4);

        if (t.type === 'BUY' && t.assetTicker) {
            const totalCostPCurr    = t.amount ? Math.abs(t.amount) : (qty * price + comm + tax) / fx;
            const totalCostAssetCurr = t.amount ? (Math.abs(t.amount) * fx) : (qty * price + comm + tax);
            
            if (!openMap[t.assetTicker]) openMap[t.assetTicker] = { shares: 0, totalCostInPCurr: 0, totalCostInAssetCurr: 0 };
            
            openMap[t.assetTicker].shares              += qty;
            openMap[t.assetTicker].totalCostInPCurr    += totalCostPCurr;
            openMap[t.assetTicker].totalCostInAssetCurr += totalCostAssetCurr;
        }

        if (t.type === 'SELL' && t.assetTicker) {
            const proceeds = t.amount ? Math.abs(t.amount) : (qty * price - comm - tax) / fx;
            const h = openMap[t.assetTicker] || { shares: 0, totalCostInPCurr: 0, totalCostInAssetCurr: 0 };
            
            // Weighted Average Cost (PMC)
            const pmc = h.shares > 0 ? h.totalCostInPCurr / h.shares : 0;
            const pmcAsset = h.shares > 0 ? h.totalCostInAssetCurr / h.shares : 0;
            
            const costBasis = qty * pmc;
            const costBasisAsset = qty * pmcAsset;
            const rGain = proceeds - costBasis;

            if (openMap[t.assetTicker]) {
                openMap[t.assetTicker].shares              -= qty;
                openMap[t.assetTicker].totalCostInPCurr    -= costBasis;
                openMap[t.assetTicker].totalCostInAssetCurr -= costBasisAsset;
                if (openMap[t.assetTicker].shares <= 0.0001) delete openMap[t.assetTicker];
            }

            const ck = t.assetTicker + '|' + year;
            if (!closedByKey[ck]) closedByKey[ck] = { ticker: t.assetTicker, year, totalProceeds: 0, totalCostBasis: 0, realizedGain: 0, sells: 0 };
            closedByKey[ck].totalProceeds  += proceeds;
            closedByKey[ck].totalCostBasis += costBasis;
            closedByKey[ck].realizedGain   += rGain;
            closedByKey[ck].sells++;
        }

        if (t.type === 'DIVIDEND' && t.assetTicker) {
            const net = (qty && price && t.type !== 'DIVIDEND_MANUAL') ? ((qty * price - comm - tax) / fx) : (amount / fx);
            dividends.push({ ticker: t.assetTicker, date: t.date, year, amount: net, tax: tax / fx });
        }
    }

    // Open holdings enriched with current price & unrealized P/L
    const holdings = Object.entries(openMap)
        .filter(([, h]) => h.shares > 0.0001)
        .map(([ticker, h]) => {
            const asset  = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
            let curPx  = asset ? asset.currentPrice : 0;
            
            // FX rate for this specific asset conversion
            const rate = (asset && asset.currency === 'USD' && portfolio.currency === 'EUR') ? liveRate : 1;
            
            const avgCost = h.shares > 0 ? h.totalCostInPCurr / h.shares : 0;
            const avgCostAsset = h.shares > 0 ? h.totalCostInAssetCurr / h.shares : 0;
            
            const aiData = database.db.prepare(`SELECT ai_action as action, ai_reasoning as reasoning, ai_updated_at as updated_at FROM assets WHERE ticker = ?`).get(ticker);

            // For CD_ assets, current price strictly follows cost basis per share (zero unrealized gain)
            if (ticker && ticker.startsWith('CD_')) {
                curPx = avgCostAsset;
            }

            const curPxP = (asset && asset.currency !== portfolio.currency) ? curPx / rate : curPx;
            const curVal = h.shares * curPxP;
            const isToday = asset && asset.quoteDate === today;
            const changePercent = isToday ? (asset.changePercent || 0) : 0;
            const changeValue = isToday ? (asset.changeValue || 0) : 0;
            const uGain  = curVal - h.totalCostInPCurr;
            const uGainPct = h.totalCostInPCurr > 0 ? (uGain / h.totalCostInPCurr) * 100 : 0;

            return {
                ticker, shares: Math.round(h.shares * 10000) / 10000,
                name: asset ? asset.name : ticker,
                isManual: asset ? asset.isManual : 0,
                currentPrice: curPx, currentPriceInPCurr: curPxP,
                currency: asset ? asset.currency : portfolio.currency,
                type: asset ? asset.type : 'Stock',
                totalCostInPCurr: Math.round(h.totalCostInPCurr * 100) / 100,
                avgCost: Math.round(avgCost * 10000) / 10000,
                avgCostAssetCurr: Math.round(avgCostAsset * 10000) / 10000,
                avgCostPortCurr: Math.round(avgCost * 10000) / 10000,
                currentValue: Math.round(curVal * 100) / 100,
                unrealizedGain: Math.round(uGain * 100) / 100,
                unrealizedGainPct: Math.round(uGainPct * 100) / 100,
                changePercent: changePercent,
                changeValue: changeValue,
                changeValuePortfolio: changeValue / rate,
                isin: asset ? asset.isin : null,
                dataSource: asset ? asset.dataSource : 'YF',
                country: asset ? asset.country : 'Global',
                lastUpdateError: asset ? asset.lastUpdateError : null,
                targetPrice: asset ? asset.targetPrice : 0,
                stopLoss: asset ? asset.stopLoss : 0,
                pe: asset ? asset.pe : null,
                dividendYield: asset ? asset.dividendYield : null,
                aiAction: aiData ? aiData.action : null,
                aiReasoning: aiData ? aiData.reasoning : null,
                aiUpdatedAt: aiData ? aiData.updated_at : null
            };
        });

    const taxRates = database.db.prepare(`SELECT asset_type, rate FROM tax_rates`).all();
    const trMap = {};
    taxRates.forEach(r => trMap[r.asset_type] = r.rate);

    const losses = database.db.prepare(`SELECT asset_type, amount FROM portfolio_losses WHERE portfolioId = ?`).all(portfolioId);
    const lossMap = {};
    losses.forEach(l => lossMap[l.asset_type] = l.amount);

    const totalGrossLatentGain = holdings.reduce((s, h) => s + (h.unrealizedGain || 0), 0);

    const aggregateGains = {}; // { type: { unrealized: 0 } }
    holdings.forEach(h => {
        if (!aggregateGains[h.type]) aggregateGains[h.type] = { unrealized: 0 };
        aggregateGains[h.type].unrealized += h.unrealizedGain;
    });

    let totalLatentTax = 0;
    const taxBreakdown = Object.entries(aggregateGains).map(([type, gains]) => {
        const grossGain = gains.unrealized;
        const minusvalenze = lossMap[type] || 0;
        const taxableGain = Math.max(0, grossGain - minusvalenze);
        const rate = trMap[type] || 26;
        const tax = (taxableGain * rate) / 100;
        const netGain = grossGain - tax;
        totalLatentTax += tax;
        return {
            type, grossGain, unrealized: gains.unrealized, realized: 0,
            minusvalenze, taxableGain, rate, tax, netGain
        };
    }).filter(b => b.grossGain !== 0 || b.minusvalenze !== 0);

    const totalAssetsValue = holdings.reduce((s, h) => s + h.currentValue, 0);
    const roundedCash = Math.round((portfolio.currentCash || 0) * 100) / 100;
    
    // For Allocation charts, we use GROSS value (sum of positive items) as denominator
    // to avoid >100% percentages when cash is negative.
    let totalGrossValueForAllocation = totalAssetsValue + Math.max(0, roundedCash);
    
    const typeMap = {};
    if (roundedCash > 0) { typeMap['Liquidity'] = roundedCash; }
    
    const currMap = {};
    if (roundedCash > 0) {
        currMap[portfolio.currency || 'EUR'] = roundedCash;
    }
    
    const counMap = {};
    if (roundedCash > 0) { counMap['Liquidity'] = roundedCash; }

    for (const h of holdings) { 
        const tp = h.type || 'Other'; 
        typeMap[tp] = (typeMap[tp] || 0) + h.currentValue; 
        const cr = h.currency || 'Unknown';
        currMap[cr] = (currMap[cr] || 0) + h.currentValue;
        const asset = database.db.prepare(`SELECT country FROM assets WHERE ticker = ?`).get(h.ticker);
        const co = (asset && asset.country) ? asset.country : 'Unknown';
        counMap[co] = (counMap[co] || 0) + h.currentValue;
    }

    const allocation = Object.entries(typeMap).map(([type, value]) => ({
        type, 
        value, 
        percent: totalGrossValueForAllocation > 0 ? (value / totalGrossValueForAllocation) * 100 : 0
    })).sort((a, b) => b.value - a.value);

    // Closed positions
    const closedPositions = Object.values(closedByKey).map(c => {
        const asset = database.db.prepare(`SELECT name FROM assets WHERE ticker = ?`).get(c.ticker);
        const gPct = c.totalCostBasis > 0 ? (c.realizedGain / c.totalCostBasis) * 100 : 0;
        return { ...c, name: asset ? asset.name : c.ticker, gainPct: gPct };
    }).sort((a, b) => parseInt(b.year) - parseInt(a.year) || b.realizedGain - a.realizedGain);

    const divYearMap = {};
    let totalDividends = 0;
    for (const d of dividends) {
        if (!divYearMap[d.year]) divYearMap[d.year] = { year: d.year, total: 0, items: [] };
        divYearMap[d.year].total += d.amount;
        divYearMap[d.year].items.push(d);
        totalDividends += d.amount;
    }

    const totalValue = portfolio.totalValue || 0;
    const currentCash = portfolio.currentCash || 0;
    const performance1D = portfolio.performance1D || 0;
    
    // Calculate 1D Percent consistently
    const prevValue = totalValue - performance1D;
    const changePercent = prevValue > 0 ? (performance1D / prevValue) * 100 : 0;

    // --- NEW: Performance Metrics ---
    const perfData = await calculatePerformanceHistory(portfolioId, 'ALL', false);
    const pHistory = Array.isArray(perfData) ? perfData : (perfData.dataPoints || []);
    const lastPPoint = pHistory.at(-1) || { value: 0, profit: 0, netDeposits: 0 };
    const roi = calculateROI(lastPPoint.value || 0, lastPPoint.netDeposits || 0, lastPPoint.profit || 0);
    const twr = calculateTWR(pHistory.map((pt, idx) => {
        const prev = pHistory[idx - 1] || { value: 0, netDeposits: 0 };
        return {
            startingValue: prev.value,
            endingValue: pt.value,
            netCashFlow: pt.netDeposits - prev.netDeposits
        };
    }).slice(1));

    const pFlows = transactions.filter(t => ['DEPOSIT', 'WITHDRAWAL'].includes(t.type)).map(t => {
        return {
            date: new Date(t.date),
            amount: t.type === 'DEPOSIT' ? -(t.amount || 0) : (t.amount || 0)
        };
    });
    pFlows.push({ date: new Date(), amount: totalValue });
    pFlows.sort((a,b) => a.date - b.date);
    const xirrValue = pFlows.length >= 2 ? (xirr(pFlows) || 0) : 0;

    return {
        ...portfolio,
        totalValue,
        currentCash,
        performance1D,
        changeValue: performance1D,
        changePercent,
        roi,
        twr,
        xirr: xirrValue,
        totalLatentTax,
        transactions,
        holdings,
        allocation,
        currencyAllocation: Object.entries(currMap).map(([type, value]) => ({ 
            type, value, percent: totalGrossValueForAllocation > 0 ? (value / totalGrossValueForAllocation) * 100 : 0 
        })),
        countryAllocation: Object.entries(counMap).map(([type, value]) => ({ 
            type, value, percent: totalGrossValueForAllocation > 0 ? (value / totalGrossValueForAllocation) * 100 : 0 
        })),
        closedPositions,
        dividendGroups: Object.values(divYearMap).sort((a, b) => b.year - a.year),
        totalDividends,
        totalGrossLatentGain: Math.round(totalGrossLatentGain * 100) / 100,
        totalLatentTax: Math.round(totalLatentTax * 100) / 100,
        taxBreakdown,
        losses: lossMap
    };
}

app.get('/api/portfolios/:id', requireAuth, requirePortfolioAccess, async (req, res) => {
    try {
        const data = await getPortfolioDetails(req.params.id);
        res.json(data);
    } catch (err) {
        res.status(err.message === 'Portfolio non trovato' ? 404 : 500).json({ error: err.message });
    }
});

// --- Gemini Model Resolver ---
// Dynamically picks the best available model so the app survives deprecations.
let _cachedGeminiModel = null;
let _geminiModelCachedAt = 0;
const GEMINI_MODEL_CACHE_MS = 60 * 60 * 1000; // 1 hour

// Preferred model names in priority order (newest first)
const GEMINI_MODEL_PREFERENCE = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
];

async function getBestGeminiModel(apiKey) {
    const now = Date.now();
    if (_cachedGeminiModel && (now - _geminiModelCachedAt) < GEMINI_MODEL_CACHE_MS) {
        return _cachedGeminiModel;
    }
    try {
        const listRes = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
        );
        const available = (listRes.data.models || [])
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));

        // Pick the highest-priority preferred model that is available
        for (const preferred of GEMINI_MODEL_PREFERENCE) {
            if (available.includes(preferred)) {
                _cachedGeminiModel = preferred;
                _geminiModelCachedAt = now;
                console.log(`[Gemini] Selected model: ${preferred}`);
                return preferred;
            }
        }
        // Fallback: pick any flash model that supports generateContent
        const anyFlash = available.find(m => m.includes('flash'));
        if (anyFlash) {
            _cachedGeminiModel = anyFlash;
            _geminiModelCachedAt = now;
            console.log(`[Gemini] Fallback model: ${anyFlash}`);
            return anyFlash;
        }
        // Last resort: first available
        if (available.length > 0) {
            _cachedGeminiModel = available[0];
            _geminiModelCachedAt = now;
            console.log(`[Gemini] Last-resort model: ${available[0]}`);
            return available[0];
        }
    } catch (err) {
        console.warn('[Gemini] Could not fetch model list, using static fallback:', err.message);
    }
    // Static fallback if API list call fails
    return 'gemini-2.5-flash';
}

function parseAIResponse(rawText) {
    let cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleanText);
    } catch (e) {
        console.warn('JSON parse failed, attempting regex extraction. Error:', e.message);
        const result = { action: 'HOLD', targetProfit: 0, stopLoss: 0, reasoning: rawText };
        
        const actionMatch = rawText.match(/"action"\s*:\s*"([^"]+)"/i);
        if (actionMatch) result.action = actionMatch[1].toUpperCase();
        
        const tpMatch = rawText.match(/"targetProfit"\s*:\s*([\d.]+)/i);
        if (tpMatch) result.targetProfit = parseFloat(tpMatch[1]);
        
        const slMatch = rawText.match(/"stopLoss"\s*:\s*([\d.]+)/i);
        if (slMatch) result.stopLoss = parseFloat(slMatch[1]);
        
        // Extract reasoning
        const reasoningMatch = rawText.match(/"reasoning"\s*:\s*"([\s\S]*?)"(?=\n\s*\}|\r\n\s*\}|,\s*"targetProfit"|,\s*"stopLoss"|,\s*"action"|$)/i);
        if (reasoningMatch) {
            result.reasoning = reasoningMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        } else {
            // If we can't find reasoning field, try to strip the json wrapper from raw text
            let stripped = rawText.replace(/\{[\s\S]*"reasoning"\s*:\s*"/i, '');
            stripped = stripped.replace(/"\s*\}[\s\S]*$/i, '');
            result.reasoning = stripped.trim() ? stripped : rawText;
        }
        
        return result;
    }
}

async function callAIModel(engine, prompt, keys) {
    const parts = engine.split('_');
    const baseEngine = parts[0] || 'Gemini';
    const tier = parts[1] || 'Pay';

    logger.info(`[AI Iteration] Starting analysis with engine: ${engine}`);
    logger.info(`[AI Prompt] \n${prompt}`);
    if (baseEngine === 'Qwen') {
        const apiKey = tier === 'Free' ? keys.qwenApiKeyFree : (keys.qwenApiKeyPay || keys.qwenApiKey || process.env.QWEN_API_KEY);
        if (!apiKey) throw new Error(`Qwen API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
                model: 'qwen-plus',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Qwen)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'OpenAI') {
        const apiKey = tier === 'Free' ? keys.openaiApiKeyFree : (keys.openaiApiKeyPay || keys.openaiApiKey || process.env.OPENAI_API_KEY);
        if (!apiKey) throw new Error(`OpenAI API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (OpenAI)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'Agnes') {
        const apiKey = tier === 'Free' ? keys.agnesApiKeyFree : (keys.agnesApiKeyPay || keys.agnesApiKey || process.env.AGNES_API_KEY);
        if (!apiKey) throw new Error(`Agnes API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://apihub.agnes-ai.com/v1/chat/completions', {
                model: 'agnes-2.0-flash',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Agnes)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else if (baseEngine === 'Aimlapi') {
        const apiKey = tier === 'Free' ? keys.aimlapiApiKeyFree : (keys.aimlapiApiKeyPay || keys.aimlapiApiKey || process.env.AIMLAPI_API_KEY);
        if (!apiKey) throw new Error(`AIML API Key (${tier}) mancante.`);
        let res;
        try {
            res = await axios.post('https://api.aimlapi.com/v1/chat/completions', {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
        } catch (apiErr) {
            logger.error('[AI API Error (Aimlapi)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.choices?.[0]?.message?.content || '{}';
        logger.info(`[AI Response (${engine})] \n${content}`);
        return { text: content, usage: res.data.usage || {} };
    } else {
        // Default to Gemini
        const apiKey = tier === 'Free' ? keys.geminiApiKeyFree : (keys.geminiApiKeyPay || keys.geminiApiKey || process.env.GEMINI_API_KEY);
        if (!apiKey) throw new Error(`Gemini API Key (${tier}) mancante.`);
        const geminiModel = await getBestGeminiModel(apiKey);
        let res;
        try {
            res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                { contents: [{ parts: [{ text: prompt }] }] },
                { headers: { 'Content-Type': 'application/json' } }
            );
        } catch (apiErr) {
            logger.error('[AI API Error (Gemini)]', apiErr.response ? apiErr.response.data : apiErr.message);
            throw apiErr;
        }
        const content = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        logger.info(`[AI Response (${engine})] \n${content}`);
        const usage = res.data.usageMetadata || {};
        return { text: content, usage: { totalTokenCount: usage.totalTokenCount || 0 } };
    }
}

app.get('/api/assets/:ticker/ai-analysis', requireAuth, async (req, res) => {
    try {
        const globalSettings = database.getSettings(1) || {};


        // Setup SSE Headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const sendEvent = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const ticker = req.params.ticker;
        sendEvent('progress', { message: 'Recupero informazioni asset...' });

        // Fetch asset info
        const assetRow = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
        if (!assetRow) {
            throw new Error('Asset non trovato.');
        }

        // Fetch recent news
        sendEvent('progress', { message: 'Ricerca news recenti...' });
        const newsRes = await yahooFinance.search(ticker, { newsCount: 3 }).catch(() => ({}));
        const newsTitles = (newsRes.news || []).map(n => n.title).join('; ');
        
        // Fetch earnings/fundamentals
        sendEvent('progress', { message: 'Recupero dati fondamentali...' });
        const summary = await yahooFinance.quoteSummary(ticker, { modules: ['calendarEvents', 'defaultKeyStatistics'] }).catch(() => null);
        let earningsDate = 'Sconosciuta';
        if (summary?.calendarEvents?.earnings?.earningsDate?.[0]) {
            earningsDate = new Date(summary.calendarEvents.earnings.earningsDate[0]).toISOString().split('T')[0];
        }
        
        const contextData = `
- **${assetRow.ticker} (${assetRow.name})**:
  - Asset Type: ${assetRow.type}
  - Exchange: ${assetRow.exchange}
  - Currency: ${assetRow.currency}
  - Current Price: ${assetRow.currentPrice}
  - Prossima Trimestrale (Earnings): ${earningsDate}
  - Ultime News: ${newsTitles || 'Nessuna news rilevante recente'}`;

        sendEvent('progress', { message: 'Generazione responso IA in corso...' });

        let customPromptText = globalSettings.aiAssetPrompt || '';
        if (customPromptText) {
            const assetName = assetRow.name || assetRow.ticker;
            const assetExchange = assetRow.exchange || 'Mercato';
            customPromptText = customPromptText.replace(/\[INSERIRE TICKER E MERCATO\]/gi, `${assetRow.ticker} (${assetExchange})`);
            customPromptText = customPromptText.replace(/\[TICKER\]/gi, assetRow.ticker);
            customPromptText = customPromptText.replace(/\[ASSET\]/gi, assetName);
        }

        const customPrompt = customPromptText ? `\nIstruzioni personalizzate dall'utente:\n${customPromptText}\n` : '';

        const prompt = `
Sei un esperto analista finanziario. Il tuo compito è analizzare questo asset in base ai dati forniti e soddisfare scrupolosamente le istruzioni personalizzate dell'utente.

${customPrompt}

Dati Asset Attuali:
${contextData}

REGOLE DI OUTPUT FONDAMENTALI:
Devi restituire ESATTAMENTE ed ESCLUSIVAMENTE un oggetto JSON valido. NESSUN TESTO al di fuori del JSON. Nessun blocco markdown \`\`\`json.
Tutta la tua analisi discorsiva, comprese le risposte alle istruzioni dell'utente e la scheda tecnica richiesta, DEVONO ESSERE INSERITE ALL'INTERNO del campo testuale "reasoning" formattato in Markdown.
Inoltre, devi estrarre l'indicazione operativa e i prezzi chiave per popolare i campi strutturati "action", "targetProfit" and "stopLoss".

Struttura JSON richiesta:
{
  "action": "BUY",
  "reasoning": "INSERISCI QUI TUTTA L'ANALISI COMPLETA E LA SCHEDA TECNICA RICHIESTA (in formato Markdown).",
  "targetProfit": 150.50,
  "stopLoss": 90.00
}

NB: 
- "action" deve essere una singola parola in maiuscolo (es. BUY, SELL, HOLD, INCREASE, DECREASE). 
- "targetProfit" e "stopLoss" devono essere numeri (usa il punto per i decimali, es. 10.50). Se non hai un target o stop loss definito, inserisci 0.
- IMPORTANTE: Per i ritorni a capo all'interno di "reasoning", devi ASSOLUTAMENTE USARE il carattere di escape "\n" e non andare mai a capo fisicamente. Fai l'escape anche delle eventuali virgolette interne con \" per non invalidare il JSON.
`;

        const engine = req.query.engine || globalSettings.aiEngine || 'Gemini';
        let parsedResponse = null;
        let tokensUsed = 0;
        let usage = {};

        try {
            if (engine === 'Both') {
                sendEvent('progress', { message: 'Generazione in corso (Gemini + Qwen)...' });
                const [geminiRes, qwenRes] = await Promise.allSettled([
                    callAIModel('Gemini', prompt, globalSettings),
                    callAIModel('Qwen', prompt, globalSettings)
                ]);

                let geminiText = "{}";
                if (geminiRes.status === 'fulfilled') {
                    geminiText = geminiRes.value.text;
                    tokensUsed += (geminiRes.value.usage.totalTokenCount || 0);
                }

                let qwenText = "{}";
                if (qwenRes.status === 'fulfilled') {
                    qwenText = qwenRes.value.text;
                    // Qwen tokens approximation or tracking if provided
                    tokensUsed += (qwenRes.value.usage.total_tokens || 0);
                }

                let parsedGemini = {};
                let parsedQwen = {};
                
                parsedGemini = parseAIResponse(geminiText);
                
                parsedQwen = parseAIResponse(qwenText);

                parsedResponse = {
                    action: parsedGemini.action || parsedQwen.action || 'HOLD',
                    targetProfit: parsedGemini.targetProfit || parsedQwen.targetProfit || 0,
                    stopLoss: parsedGemini.stopLoss || parsedQwen.stopLoss || 0,
                    reasoning: `### Analisi prodotta da Gemini\n\n${parsedGemini.reasoning || 'Nessuna risposta valida da Gemini.'}\n\n---\n\n### Analisi prodotta da Qwen\n\n${parsedQwen.reasoning || 'Nessuna risposta valida da Qwen.'}`
                };

            } else {
                sendEvent('progress', { message: `Generazione responso IA in corso tramite ${engine}...` });
                const res = await callAIModel(engine, prompt, globalSettings);
                const rawText = res.text;
                tokensUsed = res.usage.totalTokenCount || res.usage.total_tokens || 0;
                usage = res.usage;
                
                parsedResponse = parseAIResponse(rawText);
                parsedResponse.reasoning = `### Analisi prodotta da ${engine}\n\n` + (parsedResponse.reasoning || '');
            }
        } catch (e) {
            console.error('Failed to parse AI JSON response:', e);
            throw new Error("Errore durante la generazione o parsing del responso IA.");
        }
        
        database.db.transaction(() => {
            // Aggiorna token count
            const today = new Date().toISOString().split('T')[0];
            let currentTokens = parseInt(globalSettings.aiTokensUsedToday) || 0;
            let tokenDate = globalSettings.aiTokensDate || today;
            
            if (tokenDate !== today) {
                currentTokens = 0;
                database.setSetting(1, 'aiTokensDate', today);
            }
            database.setSetting(1, 'aiTokensUsedToday', (currentTokens + tokensUsed).toString());

            // Aggiorna asset con targetPrice, stopLoss e info IA
            const targetPrice = parsedResponse.targetProfit > 0 ? parsedResponse.targetProfit : assetRow.targetPrice;
            const stopLoss = parsedResponse.stopLoss > 0 ? parsedResponse.stopLoss : assetRow.stopLoss;
            const action = (parsedResponse.action || 'HOLD').toUpperCase();
            const reasoning = parsedResponse.reasoning || '';

            database.db.prepare(`
                UPDATE assets 
                SET targetPrice = ?, stopLoss = ?, ai_action = ?, ai_reasoning = ?, ai_engine = ?, ai_updated_at = CURRENT_TIMESTAMP
                WHERE ticker = ?
            `).run(targetPrice, stopLoss, action, reasoning, engine, ticker);

            // Se l'utente ha una watchlist per questo asset, sovrascrivi anche le sue impostazioni personali
            const userId = req.user.id;
            const userWl = database.db.prepare(`SELECT 1 FROM user_watchlist WHERE user_id = ? AND ticker = ?`).get(userId, ticker);
            if (userWl) {
                database.db.prepare(`
                    UPDATE user_watchlist
                    SET targetPrice = ?, stopLoss = ?
                    WHERE user_id = ? AND ticker = ?
                `).run(targetPrice, stopLoss, userId, ticker);
            } else {
                database.db.prepare(`
                    INSERT INTO user_watchlist (user_id, ticker, targetPrice, stopLoss)
                    VALUES (?, ?, ?, ?)
                `).run(userId, ticker, targetPrice, stopLoss);
            }

            // Inserisci nello storico
            database.db.prepare(`
                INSERT INTO asset_ai_history (ticker, action, reasoning, targetPrice, stopLoss, engine)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ticker, action, reasoning, targetPrice, stopLoss, engine);
        })();

        sendEvent('complete', { 
            analysis: parsedResponse,
            usage: usage 
        });
        res.end();
    } catch (err) {
        console.error('AI Analysis Error:', err?.response?.data || err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Errore durante l\'analisi IA: ' + (err?.response?.data?.error?.message || err.message) });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Errore durante l\'analisi IA: ' + (err?.response?.data?.error?.message || err.message) })}\n\n`);
            res.end();
        }
    }
});

app.get('/api/assets/:ticker/ai-history', requireAuth, (req, res) => {
    try {
        const history = database.db.prepare(`
            SELECT id, action, reasoning, targetPrice, stopLoss, engine, created_at 
            FROM asset_ai_history 
            WHERE ticker = ? 
            ORDER BY created_at DESC
        `).all(req.params.ticker);
        res.json(history);
    } catch (err) {
        logger.error('Error fetching asset AI history', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/assets/ai-history/:id', requireAuth, (req, res) => {
    try {
        database.db.prepare('DELETE FROM asset_ai_history WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.error('Error deleting asset AI history', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portfolios/:id/ai-analysis', requireAuth, requirePortfolioAccess, async (req, res) => {
    try {
        const globalSettings = database.getSettings(1) || {};


        // Setup SSE Headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const sendEvent = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const portfolioId = req.params.id;
        sendEvent('progress', { message: 'Recupero informazioni portafoglio...' });

        const liveRate = await getEurUsdRate();
        const details = await getPortfolioDetails(portfolioId, liveRate);
        if (!details) {
            throw new Error('Portafoglio non trovato.');
        }

        // Costruisci il testo del contesto
        let contextData = `
- **Nome**: ${details.name}
- **Valuta Base**: ${details.currency}
- **Liquidità**: ${details.currentCash.toFixed(2)} ${details.currency}
- **Valore Lordo Totale (esclusa liquidità)**: ${details.grossValue.toFixed(2)} ${details.currency}
- **Valore Netto Stimato**: ${details.netValue.toFixed(2)} ${details.currency}
- **Profit/Loss Totale (Lordo)**: ${details.totalProfit.toFixed(2)} ${details.currency} (${details.totalProfitPct.toFixed(2)}%)
- **Profit/Loss Totale (Netto)**: ${details.netProfit.toFixed(2)} ${details.currency} (${details.netProfitPct.toFixed(2)}%)

**Composizione Asset**:
`;
        if (details.holdings && details.holdings.length > 0) {
            details.holdings.forEach(h => {
                contextData += `- ${h.ticker} (${h.name}): Quantità ${h.totalQuantity}, Prezzo Attuale ${h.currentPrice} ${h.currency}, Valore ${h.currentValue.toFixed(2)} ${details.currency}, P&L ${h.profit.toFixed(2)} ${details.currency} (${h.profitPct.toFixed(2)}%), Tipo: ${h.type || 'N/D'}, Peso sul tot: ${h.weightPct.toFixed(2)}%\n`;
            });
        } else {
            contextData += `- Nessun asset presente in portafoglio.\n`;
        }

        sendEvent('progress', { message: 'Generazione responso IA in corso...' });

        const customPrompt = globalSettings.aiPortfolioPrompt ? `\nIstruzioni personalizzate dall'utente:\n${globalSettings.aiPortfolioPrompt}\n` : '';

        const prompt = `
Sei un consulente finanziario esperto. Analizza questo portafoglio in base ai dati forniti, concentrandoti sulla diversificazione, sul rischio e sui rendimenti.
${customPrompt}
Dati Portafoglio:
${contextData}

Restituisci l'analisi in formato Markdown chiaro e ben strutturato. Usa titoli, elenchi puntati e testo in grassetto dove necessario per evidenziare i concetti chiave. Metti in risalto i punti di forza e i potenziali rischi o sbilanciamenti del portafoglio. Fornisci anche eventuali suggerimenti strategici (senza che costituiscano consiglio finanziario vincolante).
`;

        const engine = req.query.engine || globalSettings.aiEngine || 'Gemini';
        let rawText = "Nessuna risposta generata.";
        let tokensUsed = 0;
        let usage = {};

        try {
            if (engine === 'Both') {
                sendEvent('progress', { message: 'Generazione in corso (Gemini + Qwen)...' });
                const [geminiRes, qwenRes] = await Promise.allSettled([
                    callAIModel('Gemini', prompt, globalSettings),
                    callAIModel('Qwen', prompt, globalSettings)
                ]);

                let geminiText = "Errore nella generazione con Gemini.";
                if (geminiRes.status === 'fulfilled') {
                    geminiText = geminiRes.value.text;
                    tokensUsed += (geminiRes.value.usage.totalTokenCount || 0);
                }

                let qwenText = "Errore nella generazione con Qwen.";
                if (qwenRes.status === 'fulfilled') {
                    qwenText = qwenRes.value.text;
                    tokensUsed += (qwenRes.value.usage.total_tokens || 0);
                }

                rawText = `### Analisi prodotta da Gemini\n\n${geminiText}\n\n---\n\n### Analisi prodotta da Qwen\n\n${qwenText}`;

            } else {
                sendEvent('progress', { message: `Generazione responso IA in corso tramite ${engine}...` });
                const res = await callAIModel(engine, prompt, globalSettings);
                rawText = `### Analisi prodotta da ${engine}\n\n` + res.text;
                tokensUsed = res.usage.totalTokenCount || res.usage.total_tokens || 0;
                usage = res.usage;
            }
        } catch (e) {
            console.error('Failed to generate portfolio AI response:', e);
            throw new Error("Errore durante la generazione del responso IA.");
        }
        
        database.db.transaction(() => {
            // Aggiorna token count
            const today = new Date().toISOString().split('T')[0];
            let currentTokens = parseInt(globalSettings.aiTokensUsedToday) || 0;
            let tokenDate = globalSettings.aiTokensDate || today;
            
            if (tokenDate !== today) {
                currentTokens = 0;
                database.setSetting(1, 'aiTokensDate', today);
            }
            database.setSetting(1, 'aiTokensUsedToday', (currentTokens + tokensUsed).toString());

            // Inserisci l'analisi nello storico del portafoglio
            database.db.prepare(`
                INSERT INTO ai_analyses (portfolio_id, analysis_text)
                VALUES (?, ?)
            `).run(portfolioId, rawText);
        })();

        sendEvent('complete', { 
            analysis: rawText,
            usage: usage 
        });
        res.end();
    } catch (err) {
        console.error('Portfolio AI Analysis Error:', err?.response?.data || err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Errore durante l\'analisi IA del portafoglio: ' + (err?.response?.data?.error?.message || err.message) });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Errore durante l\'analisi IA: ' + (err?.response?.data?.error?.message || err.message) })}\n\n`);
            res.end();
        }
    }
});

app.get('/api/portfolios/:id/ai-history', requireAuth, requirePortfolioAccess, (req, res) => {
    try {
        const analyses = database.db.prepare(`
            SELECT id, analysis_text, created_at 
            FROM ai_analyses 
            WHERE portfolio_id = ? 
            ORDER BY created_at DESC
        `).all(req.params.id);
        res.json(analyses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/portfolios/:id/ai-history/:analysisId', requireAuth, requirePortfolioAccess, (req, res) => {
    try {
        const result = database.db.prepare(`
            DELETE FROM ai_analyses 
            WHERE id = ? AND portfolio_id = ?
        `).run(req.params.analysisId, req.params.id);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Analisi non trovata' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/global-allocation', requireAuth, async (req, res) => {
    try {
        const { portfolioIds } = req.query;
        let pIdsToUse = (portfolioIds && portfolioIds.trim() !== '') ? portfolioIds.split(',').map(Number) : null;

        let portfolios;
        if (pIdsToUse && pIdsToUse.length > 0) {
            const placeholders = pIdsToUse.map(() => '?').join(',');
            portfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ? AND p.id IN (${placeholders})
            `).all(req.user.id, ...pIdsToUse);
        } else {
            portfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ? AND p.include_in_totals != 0
            `).all(req.user.id);
        }

        const liveRate = await getEurUsdRate();
        const typeMap = {};
        let totalGrossValue = 0;

        for (const { id } of portfolios) {
            const details = await getPortfolioDetails(id, liveRate);
            const holdings = details.holdings;
            for (const h of holdings) {
                const tp = h.type || 'Other';
                typeMap[tp] = (typeMap[tp] || 0) + h.currentValue;
                totalGrossValue += h.currentValue;
            }
            // Inclusion of Cash (only if positive)
            if (details.currentCash > 0) {
                typeMap['Liquidity'] = (typeMap['Liquidity'] || 0) + details.currentCash;
                totalGrossValue += details.currentCash;
            }
        }

        const allocation = Object.entries(typeMap)
            .map(([type, value]) => ({
                type,
                value: Math.round(value * 100) / 100,
                percent: totalGrossValue > 0 ? Math.round((value / totalGrossValue) * 1000) / 10 : 0,
                color: getAssetTypeColor(type)
            })).sort((a, b) => b.value - a.value);

        res.json(allocation);
    } catch (err) {
        console.error('Global allocation error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portfolios/:id/export', (req, res) => {
    const portfolioId = req.params.id;
    const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return res.status(404).send('Portfolio not found');

    const transactions = database.db.prepare(
        `SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`
    ).all(portfolioId);

    if (transactions.length === 0) {
        return res.status(400).send('No transactions to export');
    }

    const headers = ['ID', 'Type', 'Asset', 'Date', 'Quantity', 'Price', 'Commission', 'Tax', 'FX Rate', 'Amount'];
    const rows = transactions.map(t => [
        t.id,
        t.type,
        t.assetTicker || '',
        t.date,
        t.quantity,
        t.price,
        t.commission,
        t.tax,
        t.exchangeRate,
        t.amount
    ]);

    let csvContent = headers.join(',') + '\n';
    rows.forEach(row => {
        csvContent += row.map(value => {
            if (typeof value === 'string') {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        }).join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=transactions_${portfolio.name.replace(/\s+/g, '_')}.csv`);
    res.status(200).send(csvContent);
});

app.get('/api/export-all-transactions', (req, res) => {
    try {
        const transactions = database.db.prepare(`
            SELECT t.*, p.name as portfolioName 
            FROM transactions t
            JOIN portfolios p ON t.portfolioId = p.id
            ORDER BY t.date ASC, t.id ASC
        `).all();

        if (transactions.length === 0) {
            return res.status(400).send('No transactions to export');
        }

        const headers = ['Portfolio', 'Type', 'Asset', 'Date', 'Quantity', 'Price', 'Commission', 'Tax', 'FX Rate', 'Amount'];
        const rows = transactions.map(t => [
            t.portfolioName,
            t.type,
            t.assetTicker || '',
            t.date,
            t.quantity,
            t.price,
            t.commission,
            t.tax,
            t.exchangeRate,
            t.amount
        ]);

        let csvContent = headers.join(',') + '\n';
        rows.forEach(row => {
            csvContent += row.map(value => {
                if (typeof value === 'string') {
                    return `"${value.replace(/"/g, '""')}"`;
                }
                return value;
            }).join(',') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=all_transactions_export_${new Date().toISOString().split('T')[0]}.csv`);
        res.status(200).send(csvContent);
    } catch (err) {
        console.error('Export all error:', err);
        res.status(500).send('Export error: ' + err.message);
    }
});


app.post('/api/portfolios', requireAuth, (req, res) => {
    console.log('POST /api/portfolios:', req.body);
    const { name, type, currency, startDate, initialCash, color, include_in_totals, tags, losses } = req.body;

    if (!name) return res.status(400).json({ error: 'Portfolio name is required' });

    const cash  = parseFloat(initialCash || 0);
    const start = startDate || new Date().toISOString().split('T')[0];
    const pColor = color || '#6366f1';

    database.db.transaction(() => {
        const result = database.db.prepare(`
            INSERT INTO portfolios (name, type, currency, startDate, initialCash, currentCash, totalValue, investedCapital, color, include_in_totals)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(name, type || 'Investimento', currency || 'EUR', start, cash, cash, cash, cash, pColor, include_in_totals !== false ? 1 : 0);

        const portfolioId = result.lastInsertRowid;
        
        // Associate with user
        database.db.prepare(`INSERT INTO portfolio_users (portfolio_id, user_id) VALUES (?, ?)`).run(portfolioId, req.user.id);
        
        triggerHistoryRebuild(portfolioId);
        
        // Handle initial losses if provided
        if (losses && typeof losses === 'object') {
            const stmt = database.db.prepare(`INSERT OR REPLACE INTO portfolio_losses (portfolioId, asset_type, amount) VALUES (?, ?, ?)`);
            for (const [type, amount] of Object.entries(losses)) {
                stmt.run(portfolioId, type, parseFloat(amount) || 0);
            }
        }
    })();

    const created = database.db.prepare(`
        SELECT p.* FROM portfolios p 
        JOIN portfolio_users pu ON p.id = pu.portfolio_id 
        WHERE p.name = ? AND pu.user_id = ?
        ORDER BY p.id DESC LIMIT 1
    `).get(name, req.user.id);

    console.log('Created portfolio:', created);
    clearPerformanceCache();
    res.status(201).json(created);
});

app.put('/api/portfolios/:id', requireAuth, requirePortfolioAccess, async (req, res) => {
    const existing = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Portfolio not found');

    const { name, type, currency, startDate, initialCash, color, include_in_totals, tags, losses } = req.body;
    database.db.prepare(`
        UPDATE portfolios SET name=?, type=?, currency=?, startDate=?, initialCash=?, color=?, include_in_totals=? WHERE id=?
    `).run(
        name       || existing.name,
        type       || existing.type || 'Investimento',
        currency   || existing.currency,
        startDate  || existing.startDate,
        parseFloat(initialCash != null ? initialCash : existing.initialCash),
        color      || existing.color || '#6366f1',
        include_in_totals !== false ? 1 : 0,
        req.params.id
    );

    triggerHistoryRebuild(req.params.id);

    // Update losses
    if (losses && typeof losses === 'object') {
        const stmt = database.db.prepare(`INSERT OR REPLACE INTO portfolio_losses (portfolioId, asset_type, amount) VALUES (?, ?, ?)`);
        for (const [type, amount] of Object.entries(losses)) {
            stmt.run(req.params.id, type, parseFloat(amount) || 0);
        }
    }

    const liveRate = await getEurUsdRate();
    database.recalculatePortfolio(req.params.id, liveRate);
    clearPerformanceCache();
    res.json(database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id));
});

app.delete('/api/portfolios/:id', requireAuth, requirePortfolioAccess, (req, res) => {
    const row = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Portfolio not found');
    
    database.db.prepare(`DELETE FROM portfolios WHERE id = ?`).run(req.params.id);
    console.log(`Deleted portfolio ${req.params.id} by user ${req.user.id}`);
    
    // Trigger global rebuild to update aggregate charts
    triggerHistoryRebuild(null);
    
    clearPerformanceCache();
    res.json(row);
});

app.post('/api/portfolios/:id/reconcile', requireAuth, requirePortfolioAccess, async (req, res) => {
    const { actualCash, date } = req.body;
    const portfolioId = req.params.id;

    if (actualCash == null) return res.status(400).send('actualCash is required');

    // 1. Ensure current data is accurate
    const liveRate = await getEurUsdRate();
    database.recalculatePortfolio(portfolioId, liveRate);
    
    const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return res.status(404).send('Portfolio not found');

    const diff = parseFloat(actualCash) - portfolio.currentCash;

    if (Math.abs(diff) < 0.01) {
        return res.json({ message: 'Balance already reconciled', diff: 0 });
    }

    const type = diff > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
    const amount = Math.abs(diff);

    // 2. Insert reconciliation transaction
    database.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        parseInt(portfolioId), type, 'CASH',
        date || new Date().toISOString().split('T')[0],
        0, 0, 0, 0, 1, amount
    );

    // 3. Update historical snapshots from this date onwards
    const reconciliationDate = date || new Date().toISOString().split('T')[0];
    database.db.prepare(`
        UPDATE portfolio_history 
        SET totalValue = totalValue + ?, 
            cashValue = cashValue + ? 
        WHERE (portfolioId = ? OR portfolioId IS NULL) 
          AND date >= ?
    `).run(diff, diff, parseInt(portfolioId), reconciliationDate);

    // 4. Final recalculation and cache cleanup
    database.recalculatePortfolio(portfolioId, liveRate);
    if (typeof clearPerformanceCache === 'function') clearPerformanceCache();

    res.json({ 
        message: 'Reconciliation successful', 
        diff, 
        newCash: actualCash 
    });
});

app.post('/api/admin/rebuild-history', async (req, res) => {
    try {
        logger.info('Rebuilding performance history: Step 1/4 - Updating market quotes...');
        await updateMarketData();
        
        logger.info('Rebuilding performance history: Step 2/4 - Clearing history tables...');
        database.db.prepare('DELETE FROM portfolio_history').run();
        clearPerformanceCache();
        
        const portfolios = database.db.prepare('SELECT id FROM portfolios').all();
        logger.info(`Rebuilding performance history: Step 3/4 - Recalculating for ${portfolios.length} portfolios...`);
        
        for (const p of portfolios) {
            const uId = database.db.prepare(`SELECT user_id FROM portfolio_users WHERE portfolio_id = ?`).get(p.id)?.user_id;
            const perfData = await calculatePerformanceHistory(p.id, 'ALL', true, true);
            const dataPoints = perfData.dataPoints || [];
            const insert = database.db.prepare(`
                INSERT OR REPLACE INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            
            database.db.transaction(() => {
                for (const pt of dataPoints) {
                    insert.run(p.id, uId, pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                }
            })();
        }
        
        logger.info('Rebuilding performance history: Step 4/4 - Recalculating Global per user...');
        const users = database.db.prepare('SELECT id FROM users').all();
        for (const u of users) {
            const userP = database.db.prepare(`SELECT portfolio_id FROM portfolio_users WHERE user_id = ?`).all(u.id);
            const userPIds = userP.map(r => r.portfolio_id);
            if (userPIds.length > 0) {
                const perfDataGlobal = await calculatePerformanceHistory(userPIds, 'ALL', true, false, null, u.id);
                const globalPoints = Array.isArray(perfDataGlobal) ? perfDataGlobal : (perfDataGlobal.dataPoints || []);
                const insertGlobal = database.db.prepare(`
                    INSERT OR REPLACE INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits)
                    VALUES (NULL, ?, ?, ?, ?, ?, ?)
                `);
                
                database.db.transaction(() => {
                    for (const pt of globalPoints) {
                        insertGlobal.run(u.id, pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                    }
                })();
            }
        }

        logger.info('Performance history rebuilt successfully.');
        res.json({ success: true, message: 'History rebuilt successfully' });
    } catch (err) {
        logger.error('Failed to rebuild history', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS API
// ════════════════════════════════════════════════════════════════════════════


app.get('/api/transactions/audit', async (req, res) => {
    try {
        const portfolios = database.db.prepare(`SELECT id, name, currency FROM portfolios`).all();
        const pMap = Object.fromEntries(portfolios.map(p => [p.id, p]));
        
        const assets = database.db.prepare(`SELECT ticker, name, currency, isVirtualHistory, hasHistoryInconsistency FROM assets`).all();
        const aMap = Object.fromEntries(assets.map(a => [a.ticker, a]));
        
        const transactions = database.db.prepare(`
            SELECT * FROM transactions ORDER BY date ASC, id ASC
        `).all();
        
        const pmcStats = {}; // { portfolioId: { ticker: { shares: 0, costEUR: 0 } } }
        
        const audit = transactions.map(t => {
            const p = pMap[t.portfolioId] || { name: 'Unknown', currency: 'EUR' };
            const a = aMap[t.assetTicker] || { name: t.assetTicker || 'CASH', currency: 'EUR' };
            
            const qty = t.quantity || 0;
            const price = t.price || 0;
            const comm = t.commission || 0;
            const tax = t.tax || 0;
            const fx = t.exchangeRate || 1;
            
            // Fixed Amount Calculation (consistent with the rest of the app)
            const amountEUR = t.amount ? t.amount : (qty * price + (t.type === 'BUY' ? comm + tax : -comm - tax)) / fx;
            
            if (!pmcStats[t.portfolioId]) pmcStats[t.portfolioId] = {};
            if (t.assetTicker && !pmcStats[t.portfolioId][t.assetTicker]) {
                pmcStats[t.portfolioId][t.assetTicker] = { shares: 0, costEUR: 0 };
            }
            
            const stats = t.assetTicker ? pmcStats[t.portfolioId][t.assetTicker] : null;
            let pmcEURBefore = stats && stats.shares > 0 ? stats.costEUR / stats.shares : 0;
            let realizedGainEUR = 0;
            
            if (t.type === 'BUY' && stats) {
                stats.shares += qty;
                stats.costEUR += amountEUR;
            } else if (t.type === 'SELL' && stats) {
                const costBasis = qty * pmcEURBefore;
                realizedGainEUR = amountEUR - costBasis;
                stats.shares -= qty;
                stats.costEUR -= costBasis;
                if (stats.shares <= 0.0001) {
                    stats.shares = 0;
                    stats.costEUR = 0;
                }
            } else if (t.type === 'DIVIDEND') {
                realizedGainEUR = amountEUR;
            }
            
            return {
                ...t,
                portfolioName: p.name,
                assetName: a.name,
                assetCurrency: a.currency,
                amountEUR: amountEUR,
                pmcEURBefore: pmcEURBefore,
                realizedGainEUR: realizedGainEUR,
                isVirtualHistory: a.isVirtualHistory,
                hasHistoryInconsistency: a.hasHistoryInconsistency
            };
        });
        
        res.json(audit);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/transactions', requireAuth, (req, res) => {
    const { portfolioId, assetTicker, id } = req.query;
    
    // Isolation: Filter by portfolios user has access to
    let query = `
        SELECT t.* FROM transactions t
        JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
        WHERE pu.user_id = ?
    `;
    let params = [req.user.id];
    
    if (id) {
        query += `AND t.id = ? `;
        params.push(id);
    }
    if (portfolioId) {
        query += `AND t.portfolioId = ? `;
        params.push(portfolioId);
    }
    if (assetTicker) {
        query += `AND assetTicker = ? `;
        params.push(assetTicker);
    }
    
    query += `ORDER BY date ASC`;
    res.json(database.db.prepare(query).all(...params));
});

app.post('/api/transactions', requireAuth, requirePortfolioAccess, async (req, res) => {
    const { 
        portfolioId, type, assetTicker, date, quantity, price, 
        commission, tax, exchangeRate, amount, destinationPortfolioId, 
        isin, dataSource, assetName, assetCurrency, assetType, assetExchange, assetCountry 
    } = req.body;
    
    if (!portfolioId) return res.status(400).send('portfolioId is required');

    const sanitizedTicker = sanitizeTicker(assetTicker);

    // Auto-create/update asset with ISIN and Data Source
    if (sanitizedTicker && sanitizedTicker !== 'CASH') {
        const existingAsset = database.db.prepare(`SELECT id, dataSource FROM assets WHERE ticker = ?`).get(sanitizedTicker);
        if (existingAsset) {
            database.db.prepare(`
                UPDATE assets SET 
                    isin = COALESCE(?, isin), 
                    dataSource = COALESCE(?, dataSource),
                    name = COALESCE(?, name),
                    currency = COALESCE(?, currency)
                WHERE ticker = ?
            `).run(isin || null, dataSource || null, assetName || null, assetCurrency || null, sanitizedTicker);
        } else {
            let metadata = {};
            // Only fetch metadata if NOT manual
            if (dataSource !== 'MANUAL') {
                try {
                    metadata = await fetchAssetMetadata(sanitizedTicker) || {};
                } catch(e) { metadata = {}; }
            }
            
            database.db.prepare(`
                INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(
                sanitizedTicker, 
                sanitizedTicker, 
                assetName || metadata.name || sanitizedTicker, 
                assetType || metadata.type || (dataSource === 'MANUAL' ? 'Manual' : 'Stock'), 
                assetExchange || metadata.exchange || (dataSource === 'MANUAL' ? 'MANUAL' : 'N/A'), 
                assetCurrency || metadata.currency || 'USD', 
                metadata.currentPrice || price || 0, 
                metadata.changePercent || 0, 
                metadata.pe || null, 
                assetCountry || metadata.country || (dataSource === 'MANUAL' ? 'Manual' : 'N/A'), 
                (dataSource === 'MANUAL' ? 1 : 0),
                dataSource || 'YF', 
                isin || metadata.isin || null
            );
        }
    }


    let finalQty = parseFloat(quantity || 0);
    let finalPrice = parseFloat(price || 0);
    let finalExRate = parseFloat(exchangeRate || 1);

    // Enforcement for CD_ assets: Quantity is always 1, Currency is always EUR
    if (sanitizedTicker && sanitizedTicker.startsWith('CD_')) {
        finalQty = 1.0;
        finalExRate = 1.0;
        // The price input from the user is treated as the total amount deposited
    }

    const result = database.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        parseInt(portfolioId), type, sanitizedTicker || '',
        date || new Date().toISOString().split('T')[0],
        finalQty, finalPrice,
        parseFloat(commission || 0), parseFloat(tax || 0),
        finalExRate, parseFloat(amount || 0)
    );

    // Dividend Notification
    if (type === 'DIVIDEND' && sanitizedTicker) {
        const userId = req.user.id;
        const netAmount = parseFloat(amount || 0) - parseFloat(tax || 0);
        notifyUser(userId, 'DIVIDEND', {
            title: 'DIVIDENDO RICEVUTO 💰',
            body: `${sanitizedTicker}: +€${netAmount.toFixed(2)} (Netto)`,
            telegramMessage: `*💰 DIVIDENDO RICEVUTO*\n\nAsset: \`${sanitizedTicker}\`\nImporto Netto: \`€${netAmount.toFixed(2)}\`\nData: \`${date}\``,
            data: { url: '/dividend' }
        });
    }

    const liveRate = await getEurUsdRate();

    // Automation for TRANSFER: Create a DEPOSIT in the destination portfolio
    if (type === 'TRANSFER' && destinationPortfolioId) {
        database.db.prepare(`
            INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            parseInt(destinationPortfolioId), 'DEPOSIT', 'CASH',
            date || new Date().toISOString().split('T')[0],
            0, 0, 0, 0, 1, parseFloat(amount || 0)
        );
        database.recalculatePortfolio(destinationPortfolioId, liveRate);
    }

    database.recalculatePortfolio(portfolioId, liveRate);
    clearPerformanceCache();
    
    // Auto-rebuild history for this portfolio
    triggerHistoryRebuild(portfolioId);
    
    // Auto-refresh dividend projections (non-blocking)
    refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error:", e));

    res.status(201).json(database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(result.lastInsertRowid));
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
    const row = database.db.prepare(`
        SELECT t.* FROM transactions t
        JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
        WHERE t.id = ? AND pu.user_id = ?
    `).get(req.params.id, req.user.id);
    
    if (!row && req.user.role !== 'admin') return res.status(404).send('Transaction not found or access denied');
    
    const finalRow = row || database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!finalRow) return res.status(404).send('Transaction not found');

    
    database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(req.params.id);
    const liveRate = await getEurUsdRate();
    database.recalculatePortfolio(row.portfolioId, liveRate);
    
    // Check if the ticker has any remaining transactions globally
    if (row.assetTicker && row.assetTicker !== 'CASH') {
        const remainingTxs = database.db.prepare(`SELECT COUNT(*) as count FROM transactions WHERE assetTicker = ?`).get(row.assetTicker);
        if (remainingTxs.count === 0) {
            // Check if it's on the watchlist
            const asset = database.db.prepare(`SELECT inWatchlist FROM assets WHERE ticker = ?`).get(row.assetTicker);
            if (asset && asset.inWatchlist === 0) {
                database.db.prepare(`DELETE FROM assets WHERE ticker = ?`).run(row.assetTicker);
            }
        }
    }

    clearPerformanceCache();
    
    // Auto-rebuild history for this portfolio
    triggerHistoryRebuild(row.portfolioId);

    // Auto-refresh dividend projections (non-blocking)
    refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error:", e));

    res.json(row);
});

app.put('/api/transactions/:id', requireAuth, async (req, res) => {
    const { type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount } = req.body;
    
    // Check ownership
    const existing = database.db.prepare(`
        SELECT t.* FROM transactions t
        JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
        WHERE t.id = ? AND pu.user_id = ?
    `).get(req.params.id, req.user.id);
    
    if (!existing && req.user.role !== 'admin') return res.status(404).send('Transaction not found or access denied');
    
    const finalExisting = existing || database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!finalExisting) return res.status(404).send('Transaction not found');

    database.db.prepare(`
        UPDATE transactions 
        SET type = ?, assetTicker = ?, date = ?, quantity = ?, price = ?, commission = ?, tax = ?, exchangeRate = ?, amount = ?
        WHERE id = ?
    `).run(
        type || finalExisting.type,
        sanitizeTicker(assetTicker) || finalExisting.assetTicker,
        date || finalExisting.date,
        parseFloat(quantity || 0),
        parseFloat(price || 0),
        parseFloat(commission || 0),
        parseFloat(tax || 0),
        parseFloat(exchangeRate || 1),
        parseFloat(amount || 0),
        req.params.id
    );

    database.recalculatePortfolio(finalExisting.portfolioId);
    clearPerformanceCache();

    triggerHistoryRebuild(finalExisting.portfolioId);
    refreshDividendProjections(req.user.id).catch(e => logger.error("Background Dividend Refresh Error:", e));

    res.json({ success: true });
});

// Get market movers (assets with today's quotes, sorted by % change)
app.get('/api/market/movers', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const todayStr = new Date().toISOString().split('T')[0];
        const marketStatus = getMarketStatus();
        
        // Return assets that have open positions for THIS user
        let rows = database.db.prepare(`
            SELECT a.* 
            FROM assets a
            JOIN (
                SELECT t.assetTicker, 
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance 
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ?
                GROUP BY t.assetTicker 
                HAVING balance > 0.0001
            ) t ON a.ticker = t.assetTicker
            WHERE a.ticker != 'CASH' 
              AND IFNULL(a.type, '') != 'Liquidità' 
              AND a.ticker NOT LIKE 'CD_%'
        `).all(userId);

        rows = rows.filter(a => {
            // Always exclude assets whose last quote is not from today
            if (a.quoteDate !== todayStr) return false;
            
            const isUS = isUSMarket(a);
            const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
            
            // Also exclude if the market did not open today (stale intraday data)
            if (!openedToday) return false;
            
            return Math.abs(a.changePercent) > 0;
        })
          .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
          .slice(0, 10);

        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Validate a ticker against Yahoo Finance (used by bulk import)
app.get('/api/validate-ticker', async (req, res) => {
    const ticker = (req.query.ticker || "").trim().toUpperCase();
    const isin = (req.query.isin || "").trim().toUpperCase();
    if (!ticker && !isin) return res.status(400).send('Ticker or ISIN required');

    if (ticker === 'CASH') {
        return res.json({
            valid: true,
            ticker: 'CASH',
            name: 'Asset Cash',
            currency: 'EUR',
            exchange: 'CASH',
            type: 'Cash',
            currentPrice: 1,
            pe: null,
            country: 'Global'
        });
    }

    // BTP* tickers are virtual Italian bond labels — not searchable directly on YF or Borsa Italiana.
    // They are always treated as B_ITA bonds, identified only by their ISIN.
    if (ticker.startsWith('BTP')) {
        return res.json({
            valid: true,
            isBTP: true,
            ticker,
            name: ticker,
            currency: 'EUR',
            exchange: 'XMIL',
            type: 'Bond',
            currentPrice: 0,
            pe: null,
            country: 'Italy',
            dataSource: 'B_ITA'
        });
    }

    try {
        let metadata = await fetchAssetMetadata(ticker);
        
        // Fallback to ISIN if ticker fails or is just a label (like ROM39)
        if ((!metadata || ticker.length < 3) && isin && isin.length >= 10) {
            const isItIsin = /^IT[0-9A-Z]{10}$/.test(isin) || /^XS[0-9]{10}$/.test(isin);
            if (isItIsin) {
                const bResult = await B_ITA(isin);
                if (bResult.success) {
                    metadata = {
                        ticker: ticker || isin,
                        name: bResult.name || ticker || isin,
                        currentPrice: bResult.price,
                        changePercent: bResult.variation,
                        quoteType: 'Bond',
                        exchange: 'XMIL',
                        currency: 'EUR',
                        dataSource: 'B_ITA',
                        isin: isin
                    };
                }
            }
        }

        if (!metadata) return res.json({ valid: false });

        res.json({
            valid: true,
            ...metadata
        });
    } catch {
        // Try search fallback
        try {
            const results = await yahooFinance.search(ticker);
            const first = results.quotes && results.quotes[0];
            if (first) {
                res.json({ valid: false, suggestions: results.quotes.slice(0, 5).map(q => ({
                    symbol: q.symbol,
                    name: q.shortname || q.longname || q.symbol,
                    exchange: q.exchange,
                    type: q.quoteType
                }))});
            }
        } catch {
            res.json({ valid: false, suggestions: [] });
        }
    }
});

// Diagnostic tool: fetch full metadata for a ticker from Yahoo Finance
app.get('/api/test/yahoo-ticker', async (req, res) => {
    const ticker = (req.query.ticker || "").trim().toUpperCase();
    if (!ticker) return res.status(400).send('Ticker required');

    try {
        const quote = await yahooFinance.quote(ticker).catch(() => null);
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'assetProfile', 'financialData', 'defaultKeyStatistics', 'calendarEvents', 'price', "majorDirectHolders", "majorHoldersBreakdown", "insiderTransactions"]
        }).catch(() => null);

        if (!quote && !summary) {
            return res.status(404).json({ error: 'Ticker not found on Yahoo Finance' });
        }

        res.json({
            ticker,
            timestamp: new Date().toISOString(),
            quote,
            summary
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk import: save multiple validated transactions at once
app.post('/api/transactions/bulk', async (req, res) => {
    const { portfolioId, transactions } = req.body;
    logger.info(`Bulk import request received for portfolioId: ${portfolioId} | Rows: ${transactions ? transactions.length : 0}`);
    if (!portfolioId || !transactions || !transactions.length) {
        return res.status(400).json({ error: 'portfolioId and transactions[] required' });
    }

    try {
        const parseItalianDate = (dateStr) => {
            if (!dateStr) return null;
            const s = String(dateStr).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            const match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
            return s;
        };

        const typeMapping = {
            'DIV': 'DIVIDEND', 'DIVIDENDO': 'DIVIDEND',
            'DEPOSITO': 'DEPOSIT', 'PRELIEVO': 'WITHDRAWAL',
            'ACQUISTO': 'BUY', 'VENDITA': 'SELL'
        };

        const insertTx = database.db.prepare(`
            INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const results = [];
        const affectedPortfolios = new Set();
        if (portfolioId !== 'all') {
            const pid = parseInt(portfolioId);
            if (!isNaN(pid)) affectedPortfolios.add(pid);
        }

        const importMany = database.db.transaction((txs) => {
            for (const t of txs) {
                try {
                    let targetId = parseInt(portfolioId);
                    
                    // Multi-portfolio logic: resolve or create by name
                    if (t.portfolioName && t.portfolioName.trim()) {
                        const pName = t.portfolioName.trim();
                        let p = database.db.prepare(`SELECT id FROM portfolios WHERE name = ?`).get(pName);
                        if (!p) {
                            const info = database.db.prepare(`
                                INSERT INTO portfolios (name, currency, startDate, initialCash)
                                VALUES (?, 'EUR', ?, 0)
                            `).run(pName, t.date || new Date().toISOString().split('T')[0]);
                            targetId = info.lastInsertRowid;
                            logger.info(`Auto-created portfolio: ${pName} (ID: ${targetId})`);
                        } else {
                            targetId = p.id;
                        }
                    }
                    
                    if (isNaN(targetId)) {
                        throw new Error(`Invalid portfolio mapping for transaction on ${t.date}. 'portfolioId' is '${portfolioId}' and row 'portfolioName' is '${t.portfolioName || 'Missing'}'.`);
                    }
                    affectedPortfolios.add(targetId);

                    let sanitizedTicker = '';
                    let newSource = (t.assetTicker && t.assetTicker.toUpperCase().startsWith('BTP')) ? 'B_ITA' : 'YF';
                    let newIsin = (t.isin && t.isin.trim()) ? t.isin.trim() : null;

                    if (t.assetTicker) {
                        sanitizedTicker = t.assetTicker.trim();
                        const existingAsset = database.db.prepare(
                            `SELECT id, ticker FROM assets WHERE UPPER(ticker) = UPPER(?)`
                        ).get(sanitizedTicker);

                        if (existingAsset) {
                            database.db.prepare(`
                                UPDATE assets SET 
                                    isin = CASE WHEN ? IS NOT NULL THEN ? ELSE isin END,
                                    dataSource = ?,
                                    name = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE name END
                                WHERE UPPER(ticker) = UPPER(?)
                            `).run(newIsin, newIsin, newSource, 
                                  t.assetName || null, t.assetName || null, t.assetName || null, 
                                  sanitizedTicker);
                        } else {
                            database.db.prepare(`
                                INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, forwardPE, dividendYield, eps, beta, pegRatio, nextDividendDate, country, isManual, dataSource, isin, updatedAt)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                            `).run(
                                t.assetId || sanitizedTicker, 
                                sanitizedTicker, 
                                t.assetName || sanitizedTicker, 
                                sanitizedTicker.startsWith('CD_') ? 'Deposito Vincolato' : (t.assetType || (newSource === 'B_ITA' ? 'Bond' : 'Stock')), 
                                sanitizedTicker.startsWith('CD_') ? 'MANUAL' : (t.assetExchange || (newSource === 'B_ITA' ? 'XMIL' : 'N/A')), 
                                sanitizedTicker.startsWith('CD_') ? 'EUR' : (t.assetCurrency || (newSource === 'B_ITA' ? 'EUR' : 'USD')), 
                                parseFloat(t.assetPrice || 0) || 0,
                                0, 
                                t.assetPe || null,
                                null, null, null, null, null, null, // forwardPE, dividendYield, eps, beta, pegRatio, nextDividendDate
                                sanitizedTicker.startsWith('CD_') ? 'Italy' : (t.assetCountry || (newSource === 'B_ITA' ? 'Italy' : 'N/A')),
                                0,
                                sanitizedTicker.startsWith('CD_') ? 'MANUAL' : newSource,
                                newIsin
                            );
                        }
                    }

                    // Robust parsing helper for common export formats
                    const cleanNum = (val, dflt = 0) => {
                        if (typeof val === 'number') return isFinite(val) ? val : dflt;
                        if (!val) return dflt;
                        // Handle Italian comma decimals and dot thousands
                        const s = String(val).replace(/[€$£\s]/g,'').replace(/\./g,'').replace(',','.');
                        const n = parseFloat(s);
                        return isNaN(n) ? dflt : n;
                    };

                    let finalQty = cleanNum(t.quantity);
                    let finalExRate = cleanNum(t.exchangeRate, 1);
                    if (sanitizedTicker && sanitizedTicker.startsWith('CD_')) {
                        finalQty = 1.0;
                        finalExRate = 1.0;
                    }

                    let finalType = (t.type || '').toUpperCase();
                    if (typeMapping[finalType]) finalType = typeMapping[finalType];

                    let finalDate = parseItalianDate(t.date);

                    insertTx.run(
                        targetId,
                        finalType,
                        sanitizedTicker || null,
                        finalDate,
                        finalQty,
                        cleanNum(t.price),
                        cleanNum(t.commission),
                        cleanNum(t.tax),
                        finalExRate,
                        cleanNum(t.amount)
                    );

                    results.push({ ok: true, ticker: t.assetTicker, date: t.date, portfolioId: targetId });
                } catch (err) {
                    logger.warn(`Failed to process row: ${JSON.stringify(t)} | Error: ${err.message}`);
                    results.push({ ok: false, ticker: t.assetTicker, date: t.date, error: err.message });
                }
            }
        });

        importMany(transactions);

        // Recalculate affected portfolios
        for (const pid of affectedPortfolios) {
            if (!isNaN(pid) && pid > 0) {
                database.recalculatePortfolio(pid);
            }
        }
        
        clearPerformanceCache();
        
        // Auto-refresh dividend projections after bulk import
        // Auto-refresh dividend projections (non-blocking)
        refreshDividendProjections().catch(e => logger.error("Background Dividend Refresh Error (Bulk):", e));

        res.json({ 
            success: true, 
            imported: results.filter(r => r.ok).length,
            errors: results.filter(r => !r.ok),
            details: results 
        });
    } catch (err) {
        logger.error('Bulk import crash:', err);
        res.status(500).json({ error: 'Internal Server Error during bulk processing: ' + err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// EXCHANGE RATE API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/fx-rate', async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).send('from and to are required');
    if (from === to)  return res.json({ rate: 1.0 });

    try {
        const quote = await yahooFinance.quote(`${from}${to}=X`);
        res.json({ rate: quote.regularMarketPrice || 1.0 });
    } catch {
        res.json({ rate: 1.0 });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS API
// ════════════════════════════════════════════════════════════════════════════

// ─── Taxation Rates API ──────────────────────────────────────────────────
app.get('/api/tax-rates', requireAuth, (req, res) => {
    try {
        const rates = database.db.prepare(`SELECT * FROM tax_rates WHERE user_id = ? ORDER BY asset_type ASC`).all(req.user.id);
        res.json(rates);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tax-rates', requireAuth, (req, res) => {
    try {
        const { rates } = req.body;
        if (!Array.isArray(rates)) return res.status(400).json({ error: 'Formato non valido' });
        
        database.db.transaction(() => {
            database.db.prepare(`DELETE FROM tax_rates WHERE user_id = ?`).run(req.user.id);
            const stmt = database.db.prepare(`INSERT INTO tax_rates (user_id, asset_type, rate) VALUES (?, ?, ?)`);
            for (const r of rates) if (r.asset_type) stmt.run(req.user.id, r.asset_type, parseFloat(r.rate) || 0);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', requireAuth, (req, res) => {
    res.json(database.getSettings(req.user.id));
});

app.put('/api/settings', requireAuth, (req, res) => {
    if (req.user.id === 'admin') {
        // Prevent database foreign key error if the special admin user tries to save user settings
        return res.json({});
    }
    for (const [key, value] of Object.entries(req.body)) {
        database.setSetting(req.user.id, key, value);
    }
    res.json(database.getSettings(req.user.id));
});

app.post('/api/telegram/send-report', async (req, res) => {
    try {
        await sendTelegramDailyReport();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ASSET SEARCH
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/asset-search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).send('query is required');
    try {
        const results = await yahooFinance.search(query);
        // Filter out any result that has "CASH" as symbol to avoid confusion
        const filtered = (results.quotes || []).filter(q => q.symbol !== 'CASH');
        res.json(filtered);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/market/exchange-rate', async (req, res) => {
    try {
        const rate = await getEurUsdRate();
        res.json({ pair: 'EURUSD', rate, timestamp: eurUsdCache.timestamp });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch rate' });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS & GLOBAL DATA
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Shared helper to calculate performance data points for one or more portfolios.
 */
async function calculatePerformanceHistory(portfolioIds, range = '1Y', forceRefresh = false, includeIndividual = false, benchmarkTicker = null, userId = null, tagIds = null, includeDefaults = false) {
    const pIdsInput = portfolioIds === null ? null : (Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds]);
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const marketStatus = getMarketStatus();
    const overrides = calculateVariationOverrides(marketStatus);
    const rangeKey = range || 'ALL';
    const cacheKey = `history_${pIdsInput ? pIdsInput.sort().join(',') : 'global'}_${userId || 'none'}_${rangeKey}_${includeIndividual}_${benchmarkTicker || 'none'}_${tagIds ? tagIds.sort().join(',') : 'all'}`;

    // 1. Check Cache (1 minute TTL for dashboard-level history)
    const CACHE_SHORT_TTL = 60 * 1000; 
    if (!forceRefresh && performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < CACHE_SHORT_TTL)) {
        return performanceResultsCache[cacheKey].data;
    }

    const isGlobal = pIdsInput === null;
    let portfolios;
    if (isGlobal) {
        let tagFilter = '';
        let params = [userId];
        if (tagIds && tagIds.length > 0) {
            const placeholders = tagIds.map(() => '?').join(',');
            tagFilter = ` AND p.id IN (SELECT portfolio_id FROM portfolio_tags WHERE tag_id IN (${placeholders}))`;
            params = [...params, ...tagIds];
        }

        if (userId) {
            portfolios = database.db.prepare(`
                SELECT p.* FROM portfolios p 
                JOIN portfolio_users pu ON p.id = pu.portfolio_id 
                WHERE pu.user_id = ? ${tagFilter}
            `).all(...params);
        } else {
            portfolios = database.db.prepare('SELECT * FROM portfolios').all();
        }
    } else {
        let tagFilter = '';
        let params = [];
        if (tagIds && tagIds.length > 0) {
            const placeholders = tagIds.map(() => '?').join(',');
            tagFilter = ` AND id IN (SELECT portfolio_id FROM portfolio_tags WHERE tag_id IN (${placeholders}))`;
            params = [...tagIds];
        }
        portfolios = pIdsInput.length > 0 
            ? database.db.prepare(`SELECT * FROM portfolios WHERE id IN (${pIdsInput.join(',')}) ${tagFilter}`).all(...params)
            : [];
    }

    const pIds = portfolios.map(p => p.id);
    const allTransactions = pIds.length > 0 ? database.db.prepare(`
        SELECT * FROM transactions 
        WHERE portfolioId IN (${pIds.join(',')}) 
        ORDER BY date ASC
    `).all() : [];

    const assetMetadataCache = {};
    const allAssets = database.db.prepare('SELECT ticker, currency, currentPrice, type, isin, dataSource FROM assets').all();
    for (const a of allAssets) assetMetadataCache[a.ticker] = a;

    const portfolioTickers = allTransactions.map(t => t.assetTicker);
    const watchlistTickers = userId 
        ? database.db.prepare('SELECT ticker FROM user_watchlist WHERE user_id = ?').all(userId).map(a => a.ticker)
        : (isGlobal ? database.db.prepare('SELECT ticker FROM assets WHERE isMonitored = 1').all().map(a => a.ticker) : []);
    const rawTickers = [...new Set([...portfolioTickers, ...watchlistTickers].filter(t => t && t !== 'CASH'))];
    
    logger.info(`Performance history sync: processing ${rawTickers.length} tickers (Portfolios: ${portfolioTickers.length}, Watchlist: ${watchlistTickers.length})`);

    if (portfolios.length === 0 && watchlistTickers.length === 0) {
        return includeIndividual ? { dataPoints: [], individual: {} } : [];
    }

    const hasNonEur = isGlobal || portfolios.some(p => p.currency !== 'EUR') || rawTickers.some(t => assetMetadataCache[t]?.currency === 'USD');
    const uniqueTickers = [...rawTickers];
    if (benchmarkTicker && !uniqueTickers.includes(benchmarkTicker)) {
        uniqueTickers.push(benchmarkTicker);
    }
    if (includeDefaults) {
        if (!uniqueTickers.includes('^GSPC')) uniqueTickers.push('^GSPC');
        if (!uniqueTickers.includes('FTSEMIB.MI')) uniqueTickers.push('FTSEMIB.MI');
    }
    if (hasNonEur && !uniqueTickers.includes('EURUSD=X')) {
        uniqueTickers.push('EURUSD=X');
    }

    let startDate;
    let endSimulationDate = new Date(today);


    // 1. Support specific years (e.g. "2024")
    if (/^\d{4}$/.test(range)) {
        const y = parseInt(range);
        startDate = new Date(y, 0, 1);
        endSimulationDate = new Date(y, 11, 31);
        if (endSimulationDate > today) endSimulationDate = new Date(today);
    } else {
        switch (range) {
            case '1D':  startDate = new Date(today); startDate.setDate(today.getDate() - 1); break;
            case '1W':  startDate = new Date(today); startDate.setDate(today.getDate() - 7); break;
            case '1M':  startDate = new Date(today); startDate.setMonth(today.getMonth() - 1); break;
            case '3M':  startDate = new Date(today); startDate.setMonth(today.getMonth() - 3); break;
            case '6M':  startDate = new Date(today); startDate.setMonth(today.getMonth() - 6); break;
            case '1Y':  startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 1); break;
            case '2Y':  startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 2); break;
            case '3Y':  startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 3); break;
            case '5Y':  startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 5); break;
            case 'YTD': startDate = new Date(today.getFullYear(), 0, 1); break;
            default: {
                const firstDate = allTransactions.length > 0 ? allTransactions[0].date : null;
                startDate = firstDate ? new Date(firstDate) : new Date(today);
                if (startDate > today) startDate = new Date(today);
            }
        }
    }

    const historicalPrices = {};
    const fxRates = {};

    // 2. Fetch historical data for all involved tickers (with parallelization and DB cache)
    const fetchBorsaItalianaHistory = async (ticker, isin) => {
        let attempts = 0;
        const maxAttempts = 2;
        
        // Dynamic Token Extraction Strategy
        // We fetch the summary-chart component which contains the JWT token for the session
        // Suffix -MOTX is common for bonds on MOT, while -MTAI or similar is for stocks.
        // We'll try with and without suffix if needed, but for now we'll stick to a robust derivation.
        let summaryUrl = `https://grafici.borsaitaliana.it/summary-chart/${isin}-MOTX?lang=it`;
        const apiUrl = `https://grafici.borsaitaliana.it/api/instruments/${isin},XMIL,ISIN/history/period?period=5Y&adjustment=true&add-last-price=true`;
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/120.0.0.0',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
        };

        while (attempts < maxAttempts) {
            attempts++;
            try {
                // Step 1: Get the Token from the summary-chart page
                let summaryResp;
                try {
                    summaryResp = await axios.get(summaryUrl, { headers, timeout: 10000 });
                } catch (e) {
                    // Try fallback without -MOTX suffix
                    summaryUrl = `https://grafici.borsaitaliana.it/summary-chart/${isin}?lang=it`;
                    summaryResp = await axios.get(summaryUrl, { headers, timeout: 10000 });
                }

                const tokenMatch = summaryResp.data.match(/token="([^"]+)"/);
                if (!tokenMatch) {
                    throw new Error("Token not found in B_ITA summary-chart HTML");
                }
                const token = tokenMatch[1];

                // Step 2: Get History using the dynamic token
                const resp = await axios.get(apiUrl, {
                    headers: {
                        ...headers,
                        'Authorization': `Bearer ${token}`,
                        'Referer': summaryUrl,
                        'Accept': 'application/json, text/plain, */*'
                    },
                    timeout: 15000
                });

                if (resp.data && resp.data.history && resp.data.history.historyDt) {
                    const map = {};
                    resp.data.history.historyDt.forEach(h => {
                        if (h.dt && h.closePx) {
                            const d = h.dt.toString();
                            const dateStr = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
                            map[dateStr] = h.closePx;
                        }
                    });
                    logger.info(`Successfully scraped B_ITA history for ${ticker}: ${Object.keys(map).length} points`);
                    return map;
                }
            } catch (err) {
                if (attempts < maxAttempts) {
                    logger.warn(`B_ITA history fetch attempt ${attempts} failed for ${isin}: ${err.message}. Retrying...`);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                logger.error(`B_ITA history fetch failed for ${ticker} (${isin}) after ${maxAttempts} attempts: ${err.message}`);
            }
        }
        return null;
    };

    const fetchTickerData = async (ticker) => {
        const reqStart = startDate.toISOString().split('T')[0];
        
        // Ensure historicalPrices entry exists to avoid "Cannot read properties of undefined"
        if (!historicalPrices[ticker]) historicalPrices[ticker] = {};

        // Special handling for Savings Accounts (CD_) - completely fall back to transaction history prices
        if (ticker.startsWith('CD_')) {
            return;
        }

        const assetMeta = assetMetadataCache[ticker];
        
        // 1. Check DB Cache unless forced
        const dbQuotes = !forceRefresh ? database.db.prepare(`SELECT date, price FROM asset_quotes WHERE ticker = ? AND date >= ? ORDER BY date ASC`).all(ticker, reqStart) : [];
        if (!forceRefresh && dbQuotes.length > 0) {
            const latestDate = dbQuotes.at(-1).date;
            const firstTxDate = allTransactions.find(t => t.assetTicker === ticker)?.date || reqStart;
            // Check if we have data up to today (or last business day approx)
            if (latestDate >= todayStr || (new Date(latestDate) >= new Date(today.getTime() - 3*24*60*60*1000))) {
                historicalPrices[ticker] = Object.fromEntries(dbQuotes.map(q => [q.date, q.price]));
                return;
            }
        }

        // 2. Fetch from External Sources
        logger.info(`Fetching EOD history for ${ticker} (forceRefresh: ${forceRefresh})...`);
        let pricesMap = null;
        const isItIsin = assetMeta && assetMeta.isin && /^IT[0-9A-Z]{10}$/.test(assetMeta.isin);
        
        // Attempt Borsa Italiana first if ISIN present
        if (isItIsin || (assetMeta && assetMeta.dataSource === 'B_ITA')) {
            pricesMap = await fetchBorsaItalianaHistory(ticker, (assetMeta && assetMeta.isin) || ticker);
        }

        // Fallback to Yahoo Finance
        if (!pricesMap) {
            const firstTxDate = allTransactions.find(t => t.assetTicker === ticker)?.date;
            const fiveYearsAgo = new Date(); fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
            const fiveYearsAgoStr = fiveYearsAgo.toISOString().split('T')[0];
            const qStart = [firstTxDate, fiveYearsAgoStr, reqStart].filter(Boolean).sort()[0];
            
            const chartResult = await yahooFinance.chart(ticker, { period1: qStart, period2: todayStr, interval: '1d' }).catch(() => null);
            if (chartResult && chartResult.quotes) {
                pricesMap = Object.fromEntries(
                    chartResult.quotes
                        .filter(h => h.date && (h.adjclose || h.close))
                        .map(h => [new Date(h.date).toISOString().split('T')[0], h.adjclose || h.close])
                );
            }
        }

        let isVirtual = 0;
        let isInconsistent = 0;

        // 3. Virtual Data Fallback (Universal Fallback for ANY ticker)
        if (!pricesMap || Object.keys(pricesMap).length === 0) {
            // Find any transaction with a price
            const lastBuy = allTransactions.filter(t => t.assetTicker === ticker && t.price > 0).sort((a,b) => b.date.localeCompare(a.date))[0];
            if (lastBuy) {
                isVirtual = 1;
                pricesMap = {};
                const start = new Date(lastBuy.date);
                for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
                    pricesMap[d.toISOString().split('T')[0]] = lastBuy.price;
                }
                logger.info(`Universal Fallback: Created virtual history for ${ticker} from transaction price ${lastBuy.price}`);
            }
        }

        // 4. Forward-filling & Sanitization
        if (pricesMap && Object.keys(pricesMap).length > 0) {
            const dates = Object.keys(pricesMap).sort();
            let lastValid = pricesMap[dates[0]];
            const fullMap = {};
            const startDateObj = new Date(dates[0]);
            
            // Generate continuous daily data
            for (let d = new Date(startDateObj); d <= today; d.setDate(d.getDate() + 1)) {
                const ds = d.toISOString().split('T')[0];
                let p = pricesMap[ds];
                if (!p || p <= 0) { 
                    p = lastValid;
                    if (d.getDay() !== 0 && d.getDay() !== 6) isInconsistent = 1;
                } else {
                    lastValid = p;
                }
                fullMap[ds] = p;
            }
            
            pricesMap = fullMap;
            historicalPrices[ticker] = pricesMap;

            // Save to DB
            const insertQuote = database.db.prepare(`INSERT OR REPLACE INTO asset_quotes (ticker, date, price) VALUES (?, ?, ?)`);
            database.db.transaction(() => {
                for (const [date, price] of Object.entries(pricesMap)) {
                    insertQuote.run(ticker, date, price);
                }
            })();

            // Update Asset Tags and currentPrice from history
            const sortedDates = Object.keys(pricesMap).sort();
            const latestHistoryDate = sortedDates[sortedDates.length - 1];
            const latestHistoryPrice = pricesMap[latestHistoryDate];

            if (latestHistoryPrice > 0) {
                database.db.prepare(`
                    UPDATE assets 
                    SET currentPrice = ?, quoteDate = ?, isVirtualHistory = ?, hasHistoryInconsistency = ?, updatedAt = datetime('now') 
                    WHERE ticker = ?
                `).run(latestHistoryPrice, latestHistoryDate, isVirtual, isInconsistent, ticker);
                logger.info(`Sync assets: updated [${ticker}] currentPrice to ${latestHistoryPrice} (as of ${latestHistoryDate})`);
            } else {
                database.db.prepare(`
                    UPDATE assets SET isVirtualHistory = ?, hasHistoryInconsistency = ? WHERE ticker = ?
                `).run(isVirtual, isInconsistent, ticker);
            }
        }
    };


    await Promise.all(uniqueTickers.map(ticker => fetchTickerData(ticker)));
    
    // Update global cache for sparklines and other lookups
    historicalPricesCache = { ...historicalPricesCache, ...historicalPrices };

    // Post-process EURUSD=X into the special fxRates['USD'] map for simulation efficiency
    if (historicalPrices['EURUSD=X']) {
        fxRates['USD'] = historicalPrices['EURUSD=X'];
    }

    const formatDate = (date) => {
        const d = new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const dataPoints = [];
    let currentDate = new Date(startDate);
    
    // Benchmark tracking variables
    const benchmarksToTrack = [];
    if (benchmarkTicker) benchmarksToTrack.push({ ticker: benchmarkTicker, label: 'benchmark' });
    if (includeDefaults) {
        benchmarksToTrack.push({ ticker: '^GSPC', label: 'sp500' });
        benchmarksToTrack.push({ ticker: 'FTSEMIB.MI', label: 'ftsemib' });
    }

    const benchmarkStates = benchmarksToTrack.map(b => ({
        ticker: b.ticker,
        label: b.label,
        data: historicalPrices[b.ticker],
        shadowValue: null,
        lastPrice: null,
        firstPrice: null
    }));

    let previousDayNetDeposits = null;
    let portfolioFirstRatio = null;

    // Initial state and metadata caching per portfolio
    const portfolioStates = {};
    const individualHistories = {};
    if (includeIndividual) {
        portfolios.forEach(p => individualHistories[p.id] = []);
    }

    const startDateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

    for (const p of portfolios) {
        // Reduced logging - only log if it's a heavy calculation (many assets or long range)
        if (uniqueTickers.length > 10 || (range !== '1W' && range !== '1M')) {
            logger.info(`Calculating history for ${p.name}...`);
        }
        portfolioStates[p.id] = {
            cash: p.initialCash || 0,
            netDeposits: p.initialCash || 0,
            netDepositsEUR: (p.initialCash || 0) / (p.currency === 'USD' ? (fxRates['USD']?.[startDateStr] || liveRate) : 1), // Track invested capital in base currency
            dividends: 0,
            holdings: {},
            holdingsTotalCost: {}, // Added fix for PMC tracking in simulation
            lastBuyPrices: {} 
        };
        
        // Fast-forward initial state to startDate
        const initialTx = allTransactions.filter(t => t.portfolioId === p.id && t.date < startDateStr);
        for (const t of initialTx) {
            const qty = t.quantity || 0, price = t.price || 0, comm = t.commission || 0, tax = t.tax || 0, fx = t.exchangeRate || 1, amount = t.amount || 0;
            const effectAmt = amount ? Math.abs(amount) : (qty * price) / fx;
            if (t.type === 'BUY' && t.assetTicker && price > 0) {
                portfolioStates[p.id].lastBuyPrices[t.assetTicker] = price;
            }
            switch (t.type) {
                case 'DEPOSIT': {
                    portfolioStates[p.id].cash += effectAmt; 
                    portfolioStates[p.id].netDeposits += effectAmt; 
                    const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
                    portfolioStates[p.id].netDepositsEUR += effectAmt / rateOnDate;
                    break;
                }
                case 'WITHDRAWAL': {
                    portfolioStates[p.id].cash -= effectAmt; 
                    portfolioStates[p.id].netDeposits -= effectAmt; 
                    const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
                    portfolioStates[p.id].netDepositsEUR -= effectAmt / rateOnDate;
                    break;
                }
                case 'TAX':        portfolioStates[p.id].cash -= effectAmt; break;
                case 'TRANSFER':   portfolioStates[p.id].cash -= effectAmt; portfolioStates[p.id].netDeposits -= effectAmt; break;
                case 'DIVIDEND': {
                    const divAmt = amount ? amount : (Math.abs(amount || (qty * price - comm - tax))) / fx;
                    portfolioStates[p.id].cash += divAmt; 
                    portfolioStates[p.id].dividends += divAmt;
                    break;
                }
                case 'BUY': {
                    const cost = amount ? Math.abs(amount) : (qty * price + comm + tax) / fx;
                    portfolioStates[p.id].cash -= cost;
                    if (t.assetTicker && t.assetTicker !== 'CASH') {
                        portfolioStates[p.id].holdings[t.assetTicker] = (portfolioStates[p.id].holdings[t.assetTicker] || 0) + qty;
                        portfolioStates[p.id].holdingsTotalCost[t.assetTicker] = (portfolioStates[p.id].holdingsTotalCost[t.assetTicker] || 0) + cost;
                    }
                    break;
                }
                case 'SELL': {
                    const proceeds = amount ? Math.abs(amount) : (qty * price - comm - tax) / fx;
                    portfolioStates[p.id].cash += proceeds;
                    if (t.assetTicker && t.assetTicker !== 'CASH') {
                        const oldQty = portfolioStates[p.id].holdings[t.assetTicker] || 0;
                        const oldCost = portfolioStates[p.id].holdingsTotalCost[t.assetTicker] || 0;
                        const avgCost = oldQty > 0 ? oldCost / oldQty : 0;
                        portfolioStates[p.id].holdings[t.assetTicker] = oldQty - qty;
                        portfolioStates[p.id].holdingsTotalCost[t.assetTicker] = Math.max(0, oldCost - (qty * avgCost));
                    }
                    break;
                }
            }
        }
    }

    while (currentDate <= endSimulationDate) {
        const dateStr = formatDate(currentDate);
        let dayValue = 0, dayProfit = 0, dayCash = 0, dayAssets = 0, dayNetDeposits = 0;
        const dayEvents = [];

        const todayStr = today.toISOString().split('T')[0];
        const isToday = dateStr === todayStr;

        // Check for manual overrides for this specific date
        // CRITICAL FIX: For the CURRENT day, we skip the snapshot and use live calculation 
        // to avoid discrepancies between outdated snapshots and new transactions.
        // ALSO: for aggregate history (multiple pIds), we only use snapshots if we have them for ALL portfolios to avoid jumps.
        const historyRecords = !isToday ? database.db.prepare(`SELECT portfolioId, totalValue, cashValue, assetValue FROM portfolio_history WHERE portfolioId IN (${pIds.join(',')}) AND date = ?`).all(dateStr) : [];
        
        if (!isToday && historyRecords.length > 0 && historyRecords.length === pIds.length) {
            // Correctly aggregate snapshots with currency conversion
            for (const rec of historyRecords) {
                const p = portfolios.find(port => port.id === rec.portfolioId);
                let val = rec.totalValue || 0;
                let csh = rec.cashValue || 0;
                let ast = rec.assetValue || 0;

                if (p && p.currency === 'USD') {
                    const rate = fxRates['USD']?.[dateStr] || 1;
                    val /= rate;
                    csh /= rate;
                    ast /= rate;
                }
                dayValue += val;
                dayCash += csh;
                dayAssets += ast;
            }

            // Still need to update state for transactions on this day if any
            // For profit, we still need netDeposits calculation to keep track of state
            for (const p of portfolios) {
                const state = portfolioStates[p.id];
                const dayTx = allTransactions.filter(t => t.portfolioId === p.id && t.date === dateStr);
                for (const t of dayTx) {
                    const amount = t.amount || 0;
                    
                    if (['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'].includes(t.type)) {
                        const ticker = t.assetTicker || 'CASH';
                        const assetMeta = assetMetadataCache[ticker] || { name: ticker };
                        dayEvents.push({ 
                            type: t.type, 
                            ticker: ticker, 
                            assetName: assetMeta.name,
                            portfolioName: p.name, 
                            amount: t.amount || ((t.quantity || 0) * (t.price || 0)) 
                        });
                    }
                    // We still need to update holdings state to keep it consistent if manual record missing for next day
                    const qty = t.quantity || 0, price = t.price || 0, comm = t.commission || 0, tax = t.tax || 0, fx = t.exchangeRate || 1;
                    const effectAmt = amount ? Math.abs(amount) : (qty * price) / fx;
                    switch (t.type) {
                        case 'DEPOSIT': {
                            state.cash += effectAmt; 
                            state.netDeposits += effectAmt; 
                            const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                            state.netDepositsEUR += effectAmt / rateOnDate;
                            break;
                        }
                        case 'WITHDRAWAL': {
                            state.cash -= effectAmt; 
                            state.netDeposits -= effectAmt; 
                            const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                            state.netDepositsEUR -= effectAmt / rateOnDate;
                            break;
                        }
                        case 'TAX':        state.cash -= effectAmt; break;
                        case 'TRANSFER': {
                            state.cash -= effectAmt; 
                            state.netDeposits -= effectAmt; 
                            const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                            state.netDepositsEUR -= effectAmt / rateOnDate;
                            break;
                        }
                        case 'DIVIDEND': {
                            const divAmt = amount ? amount : (Math.abs(amount || (qty * price - comm - tax))) / fx;
                            state.cash += divAmt; 
                            state.dividends += divAmt;
                            break;
                        }
                        case 'BUY': {
                            const cost = amount ? Math.abs(amount) : (qty * price + comm + tax) / fx;
                            state.cash -= cost;
                            if (t.assetTicker !== 'CASH') {
                                state.holdings[t.assetTicker] = (state.holdings[t.assetTicker] || 0) + qty;
                                state.holdingsTotalCost[t.assetTicker] = (state.holdingsTotalCost[t.assetTicker] || 0) + cost;
                            }
                            break;
                        }
                        case 'SELL': {
                            const proceeds = amount ? Math.abs(amount) : (qty * price - comm - tax) / fx;
                            state.cash += proceeds;
                            if (t.assetTicker !== 'CASH') {
                                const oldQty = state.holdings[t.assetTicker] || 0;
                                const oldCost = state.holdingsTotalCost[t.assetTicker] || 0;
                                const avgCost = oldQty > 0 ? oldCost / oldQty : 0;
                                state.holdings[t.assetTicker] = oldQty - qty;
                                state.holdingsTotalCost[t.assetTicker] = Math.max(0, oldCost - (qty * avgCost));
                            }
                            break;
                        }
                    }
                }
            }
            let totalNetDeps = 0;
            for (const p of portfolios) {
                const rec = historyRecords.find(r => r.portfolioId === p.id);
                const state = portfolioStates[p.id];
                
                let pNet = state.netDeposits;
                if (p.currency === 'USD') {
                    const rate = fxRates['USD']?.[dateStr] || 1;
                    pNet /= rate;
                }
                totalNetDeps += pNet;

                if (rec && includeIndividual) {
                    const rate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                    const pValEUR = (rec.totalValue || 0) / rate;
                    const pProfitEUR = pValEUR - state.netDepositsEUR;
                    
                    individualHistories[p.id].push({
                        date: dateStr,
                        value: pValEUR,
                        profit: pProfitEUR,
                        netDeposits: state.netDepositsEUR
                    });
                }
            }
            dayNetDeposits = totalNetDeps;
            dayProfit = dayValue - totalNetDeps;
        } else {
            for (const p of portfolios) {
                const state = portfolioStates[p.id];
                const dayTx = allTransactions.filter(t => t.portfolioId === p.id && t.date === dateStr);

                for (const t of dayTx) {
                    const qty = t.quantity || 0, price = t.price || 0, comm = t.commission || 0, tax = t.tax || 0, fx = t.exchangeRate || 1, amount = t.amount || 0;
                    const effectAmt = amount ? Math.abs(amount) : (qty * price) / fx;
                    if (t.type === 'BUY' && t.assetTicker && price > 0) {
                        state.lastBuyPrices[t.assetTicker] = price;
                    }
                    if (['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'].includes(t.type)) {
                        const tickerForEvent = t.assetTicker || 'CASH';
                        const assetMeta = assetMetadataCache[tickerForEvent] || { name: tickerForEvent };
                        dayEvents.push({ 
                            type: t.type, 
                            ticker: tickerForEvent, 
                            assetName: assetMeta.name,
                            portfolioName: p.name, 
                            amount: t.amount || (qty * price) 
                        });
                    }
                    switch (t.type) {
                        case 'DEPOSIT': {
                            state.cash += effectAmt; 
                            state.netDeposits += effectAmt; 
                            const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                            state.netDepositsEUR += effectAmt / rateOnDate;
                            break;
                        }
                        case 'WITHDRAWAL': {
                            state.cash -= effectAmt; 
                            state.netDeposits -= effectAmt; 
                            const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                            state.netDepositsEUR -= effectAmt / rateOnDate;
                            break;
                        }
                        case 'TAX':        state.cash -= effectAmt; break;
                        case 'TRANSFER': {
                            state.cash -= effectAmt; 
                            state.netDeposits -= effectAmt; 
                            const rateOnDate = (p.currency === 'USD') ? (fxRates['USD']?.[dateStr] || 1) : 1;
                            state.netDepositsEUR -= effectAmt / rateOnDate;
                            break;
                        }
                        case 'DIVIDEND': {
                            const divAmt = amount ? amount : (Math.abs(amount || (qty * price - comm - tax))) / fx;
                            state.cash += divAmt; 
                            state.dividends += divAmt;
                            break;
                        }
                        case 'BUY': {
                            const cost = amount ? Math.abs(amount) : (qty * price + comm + tax) / fx;
                            state.cash -= cost;
                            if (t.assetTicker && t.assetTicker !== 'CASH') {
                                state.holdings[t.assetTicker] = (state.holdings[t.assetTicker] || 0) + qty;
                                state.holdingsTotalCost[t.assetTicker] = (state.holdingsTotalCost[t.assetTicker] || 0) + cost;
                            }
                            break;
                        }
                        case 'SELL': {
                            const proceeds = amount ? Math.abs(amount) : (qty * price - comm - tax) / fx;
                            state.cash += proceeds;
                            if (t.assetTicker && t.assetTicker !== 'CASH') {
                                const oldQty = state.holdings[t.assetTicker] || 0;
                                const oldCost = state.holdingsTotalCost[t.assetTicker] || 0;
                                const avgCost = oldQty > 0 ? oldCost / oldQty : 0;
                                state.holdings[t.assetTicker] = oldQty - qty;
                                state.holdingsTotalCost[t.assetTicker] = Math.max(0, oldCost - (qty * avgCost));
                            }
                            break;
                        }
                    }
                }

                let pAssets = 0;
                for (const [ticker, shares] of Object.entries(state.holdings)) {
                        if (shares <= 0.0001) continue;
                    
                    const dayBuyTx = dayTx.filter(t => t.assetTicker === ticker && t.type === 'BUY' && t.price > 0);
                    let price = dayBuyTx.length > 0 ? dayBuyTx.at(-1).price : historicalPrices[ticker]?.[dateStr];
                    
                    const isTodayNow = dateStr === today.toISOString().split('T')[0];

                    // If price is missing (undefined, null, or 0), try to find a fallback
                    if (!price || price === 0) {
                        const assetMeta = assetMetadataCache[ticker];

                        // Priority 1: If it's today right now, try live price from cache
                        if (isTodayNow && assetMeta && assetMeta.currentPrice > 0) {
                            price = assetMeta.currentPrice;
                        }

                        // Priority 2: CD_ (Certificate of Deposit) - always use last purchase price (fixed value)
                        if (ticker.startsWith('CD_')) {
                            // Valuation for Savings Account: Price is essentially PMC
                            const currentQty = state.holdings[ticker] || 0;
                            const currentCost = state.holdingsTotalCost[ticker] || 0;
                            price = currentQty > 0 ? (currentCost / currentQty) : (state.lastBuyPrices[ticker] || 1);
                        }

                        // Priority 3: Try most recent historical price (critical for weekends/holidays)
                        if (!price || price === 0) {
                            const availableDates = Object.keys(historicalPrices[ticker] || {}).sort();
                            const pastDates = availableDates.filter(d => d < dateStr);
                            if (pastDates.length > 0) {
                                price = historicalPrices[ticker][pastDates.at(-1)];
                            } else if (availableDates.length > 0) {
                                price = historicalPrices[ticker][availableDates[0]];
                            }
                        }

                        // Priority 3: Try most recent transaction price from this portfolio
                        if (!price || price === 0) {
                            price = state.lastBuyPrices[ticker];
                        }

                        // Priority 4: Final fallback to current asset price ONLY if no historical data at all
                        if (!price || price === 0) {
                            if (assetMeta && assetMeta.currentPrice > 0) price = assetMeta.currentPrice;
                            else if (assetMeta && assetMeta.type === 'Bond') price = 100.0;
                            else price = 0;
                        }
                    }

                    const assetMeta = (assetMetadataCache && assetMetadataCache[ticker]) || { currency: 'EUR' };
                    const aCurr = assetMeta.currency || 'EUR';
                    let rate = 1;
                    if (aCurr === 'USD' && p.currency === 'EUR') {
                        rate = fxRates['USD']?.[dateStr];
                        if (rate === undefined) {
                            // Robust fallback: find nearest PAST date, then nearest FUTURE date
                            const availableFxDates = Object.keys(fxRates['USD'] || {}).sort();
                            const pastFx = availableFxDates.filter(d => d < dateStr);
                            if (pastFx.length > 0) {
                                rate = fxRates['USD'][pastFx.at(-1)];
                            } else if (availableFxDates.length > 0) {
                                rate = fxRates['USD'][availableFxDates[0]];
                            } else {
                                // Last resort fallback to live rate or 1
                                const live = await getEurUsdRate();
                                rate = live || 1;
                            }
                        }
                    } else if (aCurr !== p.currency) {
                        const lastFx = allTransactions.filter(t => t.assetTicker === ticker && t.date <= dateStr && t.exchangeRate).at(-1);
                        rate = lastFx ? lastFx.exchangeRate : 1;
                    }
                    let effectivePrice = price;
                    let prePostAdjustment = 0;
                    if (dateStr === todayStr && overrides) {
                        const assetMetaForOverride = assetMetadataCache[ticker];
                        const actualChg = (assetMetaForOverride && assetMetaForOverride.changeValue) || 0;
                        const regMap = overrides.regular || {};
                        const targetChg = regMap.hasOwnProperty(ticker) ? regMap[ticker] : actualChg;
                        
                        effectivePrice = price - (actualChg - targetChg);

                        // Calculate Pre/Post for the chart (though we usually only show 1D on chart)
                        const ppMap = overrides.prePost || {};
                        if (ppMap[ticker]) {
                            const safeRate = (rate && rate > 0) ? rate : 1;
                            prePostAdjustment = (ppMap[ticker] || 0) / safeRate;
                        }
                    }
                    if (isNaN(effectivePrice) || !isFinite(effectivePrice)) effectivePrice = price;
                    if (isNaN(prePostAdjustment) || !isFinite(prePostAdjustment)) prePostAdjustment = 0;
                    pAssets += shares * (effectivePrice / rate);
                }

                let pValue = (state.cash + pAssets);
                // PROFIT CALCULATION: Total Wealth Change in base currency (EUR)
                // If it's EUR portfolio, rate is 1. If USD, we convert current total value to EUR 
                // and subtract the total invested capital expressed in EUR (historical).
                const pValueEUR = p.currency === 'USD' ? pValue / (fxRates['USD']?.[dateStr] || 1) : pValue;
                let pProfit = pValueEUR - state.netDepositsEUR;
                let pCash = state.cash;
                let pAssetsVal = pAssets;

                if (p.currency === 'USD') {
                    const rate = fxRates['USD']?.[dateStr] || 1;
                    pValue /= rate;
                    pProfit /= rate;
                    pCash /= rate;
                    pAssetsVal /= rate;
                }

                if (portfolios.length === 1 || p.include_in_totals !== 0) {
                    dayValue += pValue;
                    dayProfit += pProfit;
                    dayCash += pCash;
                    dayAssets += pAssetsVal;
                    dayNetDeposits += (portfolioStates[p.id].netDeposits / (p.currency === 'USD' ? (fxRates['USD']?.[dateStr] || 1) : 1));
                }

                if (includeIndividual) {
                    const rateForP = p.currency === 'USD' ? (fxRates['USD']?.[dateStr] || 1) : 1;
                    individualHistories[p.id].push({
                        date: dateStr,
                        value: Math.round(pValue),
                        profit: Math.round(pProfit),
                        netDeposits: Math.round(portfolioStates[p.id].netDeposits / rateForP)
                    });
                }
            }
        }


        
        // Benchmarks Calculation
        const benchmarksResult = {};
        for (const bState of benchmarkStates) {
            if (bState.data && bState.data[dateStr]) {
                const currentPrice = bState.data[dateStr];
                
                // Shadow Portfolio Calculation (Absolute comparison)
                if (bState.shadowValue === null) {
                    bState.shadowValue = dayValue;
                    bState.firstPrice = currentPrice;
                } else {
                    const dayNetFlow = dayNetDeposits - (previousDayNetDeposits || dayNetDeposits);
                    if (bState.lastPrice && bState.lastPrice > 0) {
                        bState.shadowValue = (bState.shadowValue * (currentPrice / bState.lastPrice)) + dayNetFlow;
                    } else {
                        bState.shadowValue += dayNetFlow;
                    }
                }

                // Normalized Index Calculation (Relative comparison, starts at 100)
                const normalizedValue = bState.firstPrice ? (currentPrice / bState.firstPrice) * 100 : 100;

                benchmarksResult[bState.label + 'Value'] = Math.round(bState.shadowValue);
                benchmarksResult[bState.label + 'Profit'] = Math.round(bState.shadowValue - dayNetDeposits);
                benchmarksResult[bState.label + 'Normalized'] = parseFloat(normalizedValue.toFixed(2));
                
                bState.lastPrice = currentPrice;
            }
        }

        // Portfolio Normalization (TWR-like index starting at 100)
        // We use the same "implied investment" logic as the reports page
        const currentInv = dayNetDeposits > 0 ? dayNetDeposits : Math.max(1, dayValue - dayProfit);
        const currentRatio = dayValue / currentInv;
        if (portfolioFirstRatio === null) portfolioFirstRatio = currentRatio;
        const portfolioNormalized = portfolioFirstRatio ? (currentRatio / portfolioFirstRatio) * 100 : 100;

        previousDayNetDeposits = dayNetDeposits;

        if (!isFinite(dayValue) || isNaN(dayValue)) {
            // Log exactly which portfolio and asset caused the issue if possible
            logger.warn(`Invalid math dayValue detected on ${dateStr}! Cash: ${dayCash}, Assets: ${dayAssets}, profit: ${dayProfit}. Attempting recovery...`);
            
            // Try to recover rather than hard zeroing
            dayValue = (isFinite(dayValue) && !isNaN(dayValue)) ? dayValue : (dayCash + dayAssets);
            if (!isFinite(dayValue) || isNaN(dayValue)) dayValue = 0;
            if (!isFinite(dayProfit) || isNaN(dayProfit)) dayProfit = 0;
        }

        let dayDividends = 0;
        for (const p of portfolios) {
            if (portfolios.length > 1 && p.include_in_totals === 0) continue;
            let pDivs = portfolioStates[p.id].dividends;
            if (p.currency === 'USD') {
                const rate = fxRates['USD']?.[dateStr] || 1;
                pDivs /= rate;
            }
            dayDividends += pDivs;
        }

        dataPoints.push({
            date: dateStr,
            value: !isFinite(dayValue) ? 0 : Math.round(dayValue),
            profit: !isFinite(dayProfit) ? 0 : Math.round(dayProfit),
            profitNoDiv: !isFinite(dayProfit) ? 0 : Math.round(dayProfit - dayDividends),
            netDeposits: !isFinite(dayNetDeposits) ? 0 : Math.round(dayNetDeposits),
            cash: !isFinite(dayCash) ? 0 : Math.round(dayCash),
            assets: !isFinite(dayAssets) ? 0 : Math.round(dayAssets),
            normalized: parseFloat(portfolioNormalized.toFixed(2)),
            ...benchmarksResult,
            events: typeof dayEvents !== 'undefined' ? dayEvents : []
        });
        currentDate.setDate(currentDate.getDate() + 1);
    }
    // 5. Cache result
    const result = includeIndividual ? { dataPoints, individual: individualHistories } : dataPoints;
    performanceResultsCache[cacheKey] = {
        data: result,
        timestamp: Date.now()
    };

    return result;
}

/**
 * Triggers a background recalculation and persistence of portfolio history.
 * @param {number|null} portfolioId - The ID of a specific portfolio, or null for all/global.
 */
async function triggerHistoryRebuild(portfolioId = null) {
    // Run in background to not block the main API response
    setImmediate(async () => {
        try {
            const portfolios = portfolioId 
                ? [{ id: portfolioId }] 
                : database.db.prepare('SELECT id FROM portfolios').all();
                
            logger.info(`Background history rebuild started for ${portfolioId ? 'portfolio ' + portfolioId : 'ALL portfolios'}`);

            for (const p of portfolios) {
                // AUTO-SYNC startDate with earliest transaction to prevent jumps
                const minTxDate = database.db.prepare('SELECT MIN(date) FROM transactions WHERE portfolioId = ?').get(p.id)['MIN(date)'];
                if (minTxDate) {
                    database.db.prepare('UPDATE portfolios SET startDate = ? WHERE id = ?').run(minTxDate, p.id);
                }

                const uId = database.db.prepare(`SELECT user_id FROM portfolio_users WHERE portfolio_id = ?`).get(p.id)?.user_id;
                const perfData = await calculatePerformanceHistory(p.id, 'ALL', true, true);
                const dataPoints = perfData.dataPoints || [];
                const insert = database.db.prepare(`
                    INSERT OR REPLACE INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                
                database.db.transaction(() => {
                    for (const pt of dataPoints) {
                        insert.run(p.id, uId, pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                    }
                })();
            }

            const users = database.db.prepare('SELECT id FROM users').all();
            for (const u of users) {
                logger.info(`Rebuilding global history for user ${u.id}...`);
                const userP = database.db.prepare(`SELECT portfolio_id FROM portfolio_users WHERE user_id = ?`).all(u.id);
                const userPIds = userP.map(r => r.portfolio_id);
                
                if (userPIds.length > 0) {
                    const perfDataGlobal = await calculatePerformanceHistory(userPIds, 'ALL', true, false, null, u.id);
                    const globalPoints = Array.isArray(perfDataGlobal) ? perfDataGlobal : (perfDataGlobal.dataPoints || []);
                    const insertGlobal = database.db.prepare(`
                        INSERT OR REPLACE INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits)
                        VALUES (NULL, ?, ?, ?, ?, ?, ?)
                    `);
                    
                    database.db.transaction(() => {
                        for (const pt of globalPoints) {
                            insertGlobal.run(u.id, pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                        }
                    })();
                }
            }

            // Clear cache to ensure charts refresh with new historical points
            clearPerformanceCache();

            logger.info(`Background history rebuild completed for ${portfolioId ? 'portfolio ' + portfolioId : 'ALL'}`);
        } catch (err) {
            logger.error(`Failed background history rebuild for ${portfolioId || 'ALL'}`, err);
        }
    });
}

// ─── ANALYTICS ENDPOINTS ──────────────────────────────────────────────────────
// Shorter TTL for analytics endpoints so the current day/month stays fresh.
// Historical points (past days/months) are stable and don't change.
const ANALYTICS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

app.get('/api/analytics/portfolio-performance/:id', requireAuth, requirePortfolioAccess, async (req, res) => {
    try {
        const { range } = req.query;
        const portfolioId = req.params.id;
        const cacheKey = `portfolio_perf_${portfolioId}_${range || 'ALL'}`;

        if (performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < ANALYTICS_CACHE_TTL)) {
            return res.json(performanceResultsCache[cacheKey].data);
        }

        const dataPoints = await calculatePerformanceHistory([portfolioId], range);
        
        let changePercent = 0;
        if (dataPoints.length > 1) {
            const startVal = dataPoints[0].value;
            const endVal = dataPoints[dataPoints.length - 1].value;
            if (startVal > 0) changePercent = ((endVal - startVal) / startVal) * 100;
        }

        const result = { dataPoints, changePercent };
        performanceResultsCache[cacheKey] = { data: result, timestamp: Date.now() };
        res.json(result);
    } catch (err) {
        console.error('Portfolio performance error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/global-performance', requireAuth, async (req, res) => {
    try {
        const { range, benchmark, tagIds, portfolioIds } = req.query;
        const tags = tagIds ? tagIds.split(',').map(Number) : null;
        let pIdsToUse = portfolioIds ? portfolioIds.split(',').map(Number) : null;

        const cacheKey = `global_perf_${req.user.id}_${range || 'ALL'}_${benchmark || 'none'}_${portfolioIds || 'all'}_${tagIds || 'all'}`;

        if (performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < ANALYTICS_CACHE_TTL)) {
            return res.json(performanceResultsCache[cacheKey].data);
        }

        if (!pIdsToUse) {
            const userPortfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
            `).all(req.user.id);
            pIdsToUse = userPortfolios.map(p => p.id);
        }

        const dataPoints = await calculatePerformanceHistory(pIdsToUse, range, false, false, benchmark, req.user.id, tags, true);

        let changePercent = 0;
        if (dataPoints.length > 1) {
            const startVal = dataPoints[0].value;
            const endVal = dataPoints[dataPoints.length - 1].value;
            if (startVal > 0) changePercent = ((endVal - startVal) / startVal) * 100;
        }

        const result = { dataPoints, changePercent };
        performanceResultsCache[cacheKey] = { data: result, timestamp: Date.now() };
        res.json(result);
    } catch (err) {
        console.error('Global performance error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── MARKET INDICES ────────────────────────────────────────────────────────────

const indicesCache = {};     // ticker → { data, ts }
const INDICES_CACHE_TTL = 60 * 1000; // 60s

app.get('/api/indices', requireAuth, async (req, res) => {
    try {
        const raw = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 3);
        if (raw.length === 0) return res.json([]);

        const results = await Promise.all(raw.map(async (ticker) => {
            const now = Date.now();
            if (indicesCache[ticker] && (now - indicesCache[ticker].ts < INDICES_CACHE_TTL)) {
                return indicesCache[ticker].data;
            }
            try {
                const meta = await fetchAssetMetadata(ticker);
                const item = {
                    ticker,
                    name:          meta?.name || ticker,
                    price:         meta?.currentPrice || null,
                    changePercent: meta?.changePercent || 0,
                    changeValue:   meta?.changeValue || 0,
                    currency:      meta?.currency || 'USD',
                };
                indicesCache[ticker] = { data: item, ts: now };
                return item;
            } catch (e) {
                logger.warn(`Indices fetch failed for ${ticker}: ${e.message}`);
                return { ticker, name: ticker, price: null, changePercent: 0, changeValue: 0, currency: '' };
            }
        }));

        res.json(results);
    } catch (err) {
        logger.error('Indices API error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─── FINANCIAL NEWS (RSS proxy) — legacy cache vars (kept for reference) ──────
let newsCache = null;
let newsCacheTime = 0;
const NEWS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
// NOTE: /api/news is defined in the NEWS API ENDPOINTS section below (line ~7518)
// and reads from the news_articles table populated by syncNews().



// ─── DAILY GAINS (Last 7 days) ─────────────────────────────────────────────────


app.get('/api/analytics/daily-gains', requireAuth, async (req, res) => {
    try {
        const { portfolioIds } = req.query;
        let pIds = portfolioIds ? portfolioIds.split(',').map(Number).filter(n => !isNaN(n)) : null;

        // Resolve portfolio IDs for this user
        if (!pIds || pIds.length === 0) {
            const userPortfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
            `).all(req.user.id);
            pIds = userPortfolios.map(p => p.id);
        }

        if (pIds.length === 0) return res.json({ days: [] });

        const todayStr = new Date().toISOString().split('T')[0];

        // Fetch the last 9 days of history (need N+1 to compute differences for 7 days)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 9);
        const cutoffStr = cutoff.toISOString().split('T')[0];

        const placeholders = pIds.map(() => '?').join(',');
        const rows = database.db.prepare(`
            SELECT date,
                   SUM(totalValue)   AS totalValue,
                   SUM(netDeposits)  AS netDeposits
            FROM portfolio_history
            WHERE portfolioId IN (${placeholders})
              AND date >= ?
              AND date < ?
            GROUP BY date
            ORDER BY date ASC
        `).all(...pIds, cutoffStr, todayStr);

        // Compute day-over-day gain (excluding cash flows) for historical days
        const days = [];
        for (let i = 1; i < rows.length; i++) {
            const prev = rows[i - 1];
            const curr = rows[i];
            // Net gain = ΔValue - ΔDeposits (so cash injections don't look like gains)
            const depositsDelta = (curr.netDeposits || 0) - (prev.netDeposits || 0);
            const gain = (curr.totalValue || 0) - (prev.totalValue || 0) - depositsDelta;
            days.push({ date: curr.date, gain: Math.round(gain * 100) / 100 });
        }

        // For TODAY: use live performance1D from the portfolios table (same source as the dashboard hero)
        // This avoids the stale portfolio_history discrepancy for the current day.
        const liveRows = database.db.prepare(`
            SELECT performance1D, performance1DPrePost, currency
            FROM portfolios
            WHERE id IN (${placeholders})
        `).all(...pIds);

        // Sum performance1D across portfolios (already in portfolio currency, typically EUR)
        // For USD portfolios we'd need FX conversion, but performance1D is already stored
        // in portfolio currency after recalculatePortfolio(), so we can sum directly.
        const liveGain = liveRows.reduce((sum, p) => sum + (p.performance1D || 0), 0);

        if (liveRows.length > 0) {
            days.push({ date: todayStr, gain: Math.round(liveGain * 100) / 100 });
        } else if (rows.length >= 2) {
            // Fallback: use last historical delta if no live data available
            const last = rows[rows.length - 1];
            const prev = rows[rows.length - 2];
            const depositsDelta = (last.netDeposits || 0) - (prev.netDeposits || 0);
            const gain = (last.totalValue || 0) - (prev.totalValue || 0) - depositsDelta;
            days.push({ date: last.date, gain: Math.round(gain * 100) / 100 });
        }

        // Return last 7
        res.json({ days: days.slice(-7) });
    } catch (err) {
        logger.error('Daily gains error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─── HISTORY ENDPOINT ──────────────────────────────────────────────────────────


app.get('/api/analytics/history', requireAuth, (req, res) => {
    try {
        const portfolios = database.db.prepare(`
            SELECT p.id, p.name, p.currency FROM portfolios p
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE pu.user_id = ?
        `).all(req.user.id);
        let allClosed = [];

        for (const p of portfolios) {
            const trans = database.db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC').all(p.id);
            const assets = database.db.prepare('SELECT * FROM assets').all();
            const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

            let holdingsMap = {}; // Tracks running shares and costBasis for WAC
            let closed = [];

            for (const t of trans) {
                const year = t.date.split('-')[0];
                const asset = assetMap[t.assetTicker] || { name: t.assetTicker || 'Liquidità' };

                if (t.type === 'BUY' && t.assetTicker) {
                    if (!holdingsMap[t.assetTicker]) holdingsMap[t.assetTicker] = { shares: 0, costBasis: 0 };
                    const totalCost = (t.amount || (t.quantity * t.price + t.commission + t.tax)) / t.exchangeRate;
                    holdingsMap[t.assetTicker].shares += t.quantity;
                    holdingsMap[t.assetTicker].costBasis += totalCost;

                } else if (t.type === 'SELL' && t.assetTicker) {
                    const sellQty = t.quantity;
                    const h = holdingsMap[t.assetTicker] || { shares: 0, costBasis: 0 };
                    const pmc = h.shares > 0 ? h.costBasis / h.shares : 0;
                    const sellCostBasis = sellQty * pmc;
                    const proceeds = (t.amount || (t.quantity * t.price - t.commission - t.tax)) / t.exchangeRate;
                    const gain = proceeds - sellCostBasis;
                    const gainPct = sellCostBasis > 0 ? ((gain / sellCostBasis) * 100).toFixed(2) : 0;

                    closed.push({
                        id: t.id,
                        ticker: t.assetTicker,
                        name: asset.name,
                        type: t.type,
                        assetType: asset.type || 'Stock',
                        year,
                        quantity: sellQty,
                        pmc: Math.round(pmc * 100) / 100,
                        totalProceeds: Math.round(proceeds * 100) / 100,
                        totalCostBasis: Math.round(sellCostBasis * 100) / 100,
                        realizedGain: Math.round(gain * 100) / 100,
                        gainPct,
                        portfolioName: p.name,
                        date: t.date
                    });

                    if (holdingsMap[t.assetTicker]) {
                        holdingsMap[t.assetTicker].shares -= sellQty;
                        holdingsMap[t.assetTicker].costBasis -= sellCostBasis;
                        if (holdingsMap[t.assetTicker].shares <= 0.0001) delete holdingsMap[t.assetTicker];
                    }
                } else if (['DEPOSIT', 'WITHDRAWAL', 'TAX', 'TRANSFER'].includes(t.type)) {
                    // Include cash movements in the history
                    closed.push({
                        id: t.id,
                        ticker: t.assetTicker || 'CASH',
                        name: t.type === 'TAX' ? 'Tasse' : (t.type === 'TRANSFER' ? 'Trasferimento' : 'Movimento Cassa'),
                        type: t.type,
                        assetType: 'Cash',
                        year,
                        quantity: 0,
                        pmc: 0,
                        totalProceeds: Math.abs(t.amount),
                        totalCostBasis: 0,
                        realizedGain: 0,
                        gainPct: 0,
                        portfolioName: p.name,
                        date: t.date
                    });
                }
            }
            allClosed = allClosed.concat(closed);
        }

        // Sort by date desc (most recent first)
        allClosed.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(allClosed);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/dividends', requireAuth, (req, res) => {
    try {
        const portfolios = database.db.prepare(`
            SELECT p.id, p.name, p.currency FROM portfolios p
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE pu.user_id = ?
        `).all(req.user.id);
        let allDividends = [];

        for (const p of portfolios) {
            const divs = database.db.prepare(`
                SELECT t.*, a.name, a.isin, a.type as assetType
                FROM transactions t
                LEFT JOIN assets a ON t.assetTicker = a.ticker
                WHERE t.portfolioId = ? AND t.type = 'DIVIDEND'
                ORDER BY t.date DESC
            `).all(p.id);
            allDividends = allDividends.concat(divs.map(d => ({
                id:          d.id,
                assetTicker: d.assetTicker,
                name:        d.name,
                isin:        d.isin,
                assetType:   d.assetType,
                date:        d.date,
                amount:      d.amount,          // Netto
                tax:         d.tax || 0,        // Tassazione
                gross:       (d.amount || 0) + (d.tax || 0), // Lordo calcolato
                portfolioId: d.portfolioId,
                portfolioName: p.name
            })));
        }
        // Return flat list for frontend to group/sort
        allDividends.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(allDividends);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


app.get('/api/dividends/manual-projections', requireAuth, (req, res) => {
    try {
        const data = database.db.prepare(`
            SELECT m.*, a.name FROM dividend_projections m 
            JOIN assets a ON m.ticker = a.ticker 
            WHERE m.user_id = ?
            ORDER BY exDate ASC
        `).all(req.user.id);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/dividends/projections', requireAuth, (req, res) => {
    try {
        const { ticker, exDate, amount } = req.body;
        if (!ticker || !exDate || !amount) return res.status(400).json({ error: 'Missing fields' });
        const year = parseInt(exDate.substring(0, 4));
        database.db.prepare(`
            INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, yield, tag, year, isCustom)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(req.user.id, ticker, null, exDate, parseFloat(amount), parseFloat(amount), 0, 'MANUALE', year);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dividends/projections/:id', requireAuth, (req, res) => {
    try {
        const { exDate, amount } = req.body;
        const year = parseInt(exDate.substring(0, 4));
        database.db.prepare(`
            UPDATE dividend_projections 
            SET exDate = ?, amount = ?, totalAmount = ?, year = ?, tag = 'MANUALE', isCustom = 1
            WHERE id = ? AND user_id = ?
        `).run(exDate, parseFloat(amount), parseFloat(amount), year, req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dividends/projections/:id', requireAuth, (req, res) => {
    try {
        database.db.prepare(`DELETE FROM dividend_projections WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dividends/projections/:id/confirm', requireAuth, requirePortfolioAccess, async (req, res) => {
    try {
        const { portfolioId, ticker, grossAmount, tax, date } = req.body;
        if (!portfolioId || !ticker || !date) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        const taxVal   = parseFloat(tax)   || 0;
        const grossVal = parseFloat(grossAmount) || 0;
        // Net amount (what hits the portfolio cash) = gross - tax
        const netVal   = grossVal - taxVal;
        
        database.db.prepare(`
            INSERT INTO transactions (portfolioId, type, assetTicker, date, amount, quantity, price, commission, tax, exchangeRate)
            VALUES (?, 'DIVIDEND', ?, ?, ?, 0, 0, 0, ?, 1)
        `).run(portfolioId, ticker, date, netVal, taxVal);
        
        database.db.prepare(`DELETE FROM dividend_projections WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
        database.recalculatePortfolio(portfolioId);
        
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * PUT /api/dividends/transactions/:id
 * Modifica un dividendo già confermato (transazione esistente).
 */
app.put('/api/dividends/transactions/:id', requireAuth, async (req, res) => {
    try {
        const { grossAmount, tax, date } = req.body;
        const taxVal   = parseFloat(tax)   || 0;
        const grossVal = parseFloat(grossAmount) || 0;
        const netVal   = grossVal - taxVal;

        // Verifica che la transazione appartenga a un portfolio dell'utente
        const tx = database.db.prepare(`
            SELECT t.id, t.portfolioId FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE t.id = ? AND pu.user_id = ? AND t.type = 'DIVIDEND'
        `).get(req.params.id, req.user.id);

        if (!tx) return res.status(404).json({ error: 'Transazione non trovata' });

        database.db.prepare(`
            UPDATE transactions SET date = ?, amount = ?, tax = ? WHERE id = ?
        `).run(date, netVal, taxVal, tx.id);

        database.recalculatePortfolio(tx.portfolioId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * DELETE /api/dividends/transactions/:id
 * Elimina un dividendo già confermato (transazione esistente).
 */
app.delete('/api/dividends/transactions/:id', requireAuth, async (req, res) => {
    try {
        const tx = database.db.prepare(`
            SELECT t.id, t.portfolioId FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE t.id = ? AND pu.user_id = ? AND t.type = 'DIVIDEND'
        `).get(req.params.id, req.user.id);

        if (!tx) return res.status(404).json({ error: 'Transazione non trovata' });

        database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(tx.id);
        database.recalculatePortfolio(tx.portfolioId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Core function to recalculate and refresh dividend projections in the database.
 * This can be called manually or automatically after transactions (BUY/SELL).
 */
async function refreshDividendProjections(userId) {
    if (!userId) return 0;
    try {
        const now = new Date();
        const currentYear = now.getFullYear();
        const lastYear = currentYear - 1;
        const liveRate = await getEurUsdRate();
        const BOND_TYPES = ['Bond', 'ETF Obblig', 'Deposito Vincolato', 'ETF Monetario'];

        // Get open positions (only assets currently held by this user)
        const openPositions = database.db.prepare(`
            SELECT * FROM (
                SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance,
                       a.type as assetType,
                       a.currency as currency,
                       COALESCE(a.name, 'N/A') as name
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                LEFT JOIN assets a ON t.assetTicker = a.ticker
                WHERE pu.user_id = ?
                GROUP BY ticker
            )
            WHERE balance > 0.0001
        `).all(userId);

        const allDivTx = database.db.prepare(`
            SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker, t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
            FROM transactions t 
            JOIN portfolios p ON t.portfolioId = p.id 
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE t.type = 'DIVIDEND' AND pu.user_id = ?
        `).all(userId);

        const toEUR = (amount, currency, exchangeRate) => {
            if (currency === 'USD' && liveRate > 0) return amount / liveRate;
            if (exchangeRate && exchangeRate !== 1) return amount / exchangeRate;
            return amount;
        };

        const taxRatesRaw = database.db.prepare(`SELECT asset_type, rate FROM tax_rates WHERE user_id = ?`).all(userId);
        const taxMap = Object.fromEntries(taxRatesRaw.map(tr => [tr.asset_type, tr.rate]));

        const balanceOnExDateQuery = database.db.prepare(`
            SELECT SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance
            FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE pu.user_id = ? AND t.assetTicker = ? AND t.date <= ?
        `);

        const newProjections = [];

        const projectionPromises = openPositions.map(async (pos) => {
            const ticker = pos.ticker;
            const isBond = BOND_TYPES.includes(pos.assetType) || ticker.startsWith('CD_') || ticker === 'Sconosciuto';
            
            if (isBond) {
                const lastYearDivs = allDivTx.filter(d => d.ticker === ticker && d.date.startsWith(lastYear.toString()));
                lastYearDivs.forEach(d => {
                    const newDate = `${currentYear}-${d.date.substring(5)}`;
                    if (newDate >= now.toISOString().split('T')[0]) {
                        const month = newDate.split('-')[1];
                        const alreadyConfirmed = allDivTx.some(tx => tx.ticker === ticker && tx.date.split('-')[1] === month && tx.date.startsWith(currentYear.toString()));
                        if (!alreadyConfirmed) {
                            const balanceOnExDate = balanceOnExDateQuery.get(userId, ticker, newDate)?.balance || 0;
                            if (balanceOnExDate > 0.0001) {
                                const lastYearNet = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
                                const lastYearTax = toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
                                const lastYearGross = lastYearNet + lastYearTax;
                                newProjections.push({ ticker, name: pos.name, date: newDate, tag: 'STORICO', amount: 0, totalAmount: lastYearNet, gross: lastYearGross, tax: lastYearTax, yield: 0 });
                            }
                        }
                    }
                });
            } else if (ticker && !ticker.startsWith('CD_') && ticker !== 'Sconosciuto') {
                try {
                    const summary = await yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'calendarEvents'] }).catch(() => null);
                    if (summary && summary.summaryDetail && summary.summaryDetail.dividendRate > 0) {
                        const annualRate = summary.summaryDetail.dividendRate;
                        const assetYield = summary.summaryDetail.dividendYield || 0;
                        const currencyYF = summary.summaryDetail.currency || pos.currency;
                        
                        const histLastYear = allDivTx.filter(d => d.ticker === ticker && d.date.startsWith(lastYear.toString()));
                        let freq = summary.summaryDetail.dividendFrequency;
                        if (!freq) {
                            if (histLastYear.length > 0) {
                                freq = histLastYear.length;
                            } else {
                                freq = 4;
                            }
                        }
                        
                        let nextDateStr = null;
                        const ce = summary.calendarEvents || {};
                        const dDate = ce.dividendDate || ce.exDividendDate;
                        
                        if (dDate) {
                            nextDateStr = new Date(dDate).toISOString().split('T')[0];
                        }
                        
                        let yfProjected = false;
                        if (nextDateStr && nextDateStr >= now.toISOString().split('T')[0]) {
                            const month = nextDateStr.split('-')[1];
                            const alreadyConfirmed = allDivTx.some(tx => tx.ticker === ticker && tx.date.split('-')[1] === month && tx.date.startsWith(currentYear.toString()));
                            if (!alreadyConfirmed) {
                                const balanceOnExDate = balanceOnExDateQuery.get(userId, ticker, nextDateStr)?.balance || 0;
                                if (balanceOnExDate > 0.0001) {
                                    const perPayment = (annualRate * balanceOnExDate) / freq;
                                    const amtGrossEUR = toEUR(perPayment, currencyYF, null);
                                    const unitAmount = toEUR(annualRate / freq, currencyYF, null);
                                    
                                    let taxRate = taxMap[pos.assetType];
                                    if (taxRate === undefined) taxRate = 26.0;
                                    const taxEUR = amtGrossEUR * (taxRate / 100);
                                    const netEUR = amtGrossEUR - taxEUR;
                                    
                                    newProjections.push({ ticker, name: pos.name, date: nextDateStr, tag: 'YF', amount: unitAmount, totalAmount: netEUR, gross: amtGrossEUR, tax: taxEUR, yield: assetYield });
                                    yfProjected = true;
                                }
                            }
                        }
                        
                        if (!yfProjected && annualRate > 0) {
                            if (histLastYear.length > 0) {
                                histLastYear.forEach(d => {
                                    const newDate = `${currentYear}-${d.date.substring(5)}`;
                                    if (newDate >= now.toISOString().split('T')[0]) {
                                        const month = newDate.split('-')[1];
                                        const alreadyConfirmed = allDivTx.some(tx => tx.ticker === ticker && tx.date.split('-')[1] === month && tx.date.startsWith(currentYear.toString()));
                                        if (!alreadyConfirmed) {
                                            const balanceOnExDate = balanceOnExDateQuery.get(userId, ticker, newDate)?.balance || 0;
                                            if (balanceOnExDate > 0.0001) {
                                                const lastYearNet = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
                                                const lastYearTax = toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
                                                const lastYearGross = lastYearNet + lastYearTax;
                                                
                                                newProjections.push({ ticker, name: pos.name, date: newDate, tag: 'SIMULATO', amount: 0, totalAmount: lastYearNet, gross: lastYearGross, tax: lastYearTax, yield: assetYield });
                                            }
                                        }
                                    }
                                });
                            }
                        }
                    }
                } catch(e) {
                    logger.error(`Error fetching YF data for ${ticker}:`, e.message);
                }
            }
        });

        // Run all fetches in parallel
        await Promise.all(projectionPromises);

        const tx = database.db.transaction((projs) => {
            database.db.prepare(`DELETE FROM dividend_projections WHERE tag != 'MANUALE' AND year = ? AND user_id = ?`).run(currentYear, userId);
            const insert = database.db.prepare(`
                INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, gross, tax, yield, tag, year)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const p of projs) {
                insert.run(userId, p.ticker, p.name, p.date, p.amount, p.totalAmount, p.gross || 0, p.tax || 0, p.yield, p.tag, currentYear);
            }
        });
        tx(newProjections);
        return newProjections.length;
    } catch (err) {
        logger.error('refreshDividendProjections error', err);
        throw err;
    }
}

app.post('/api/dividends/projections/reset', requireAuth, async (req, res) => {
    try {
        const count = await refreshDividendProjections(req.user.id);
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/dividend-projections', async (req, res) => {
    try {
        const now = new Date();
        const currentYear = now.getFullYear();
        const liveRate = await getEurUsdRate();

        const openPositions = database.db.prepare(`
            SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                   a.name as name, a.isin as isin, a.type as assetType,
                   a.currentPrice,
                   a.currency as assetCurrency,
                   SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance
            FROM transactions t 
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            LEFT JOIN assets a ON t.assetTicker = a.ticker
            WHERE pu.user_id = ?
            GROUP BY ticker HAVING balance > 0.0001
        `).all(req.user.id);

        const allDivTx = database.db.prepare(`
            SELECT t.id as txId,
                   COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                   t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
            FROM transactions t 
            JOIN portfolios p ON t.portfolioId = p.id 
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE t.type = 'DIVIDEND' AND t.date LIKE ? AND pu.user_id = ?
        `).all(currentYear + '-%', req.user.id);

        const savedProjections = database.db.prepare(`SELECT * FROM dividend_projections WHERE year = ? AND user_id = ?`).all(currentYear, req.user.id);
        const taxRatesRaw = database.db.prepare(`SELECT asset_type, rate FROM tax_rates WHERE user_id = ?`).all(req.user.id);
        const taxMap = Object.fromEntries(taxRatesRaw.map(tr => [tr.asset_type, tr.rate]));

        const listItems = [];
        const actualByMonth = Array(12).fill(0);
        const projectedByMonth = Array(12).fill(0);
        const tickersByMonth = Array.from({length: 12}, () => new Set());
        let totalExpected = 0;
        let totalReceived = 0;

        const toEUR = (amount, currency, exchangeRate) => {
            if (currency === 'USD' && liveRate > 0) return amount / liveRate;
            if (exchangeRate && exchangeRate !== 1) return amount / exchangeRate;
            return amount;
        };

        // Received - Filtered by current holdings
        allDivTx.forEach(d => {
            const pos = openPositions.find(p => p.ticker === d.ticker);
            if (!pos) return; // Skip dividends for assets no longer held

            const m = parseInt(d.date.split('-')[1]) - 1;
            const amtEUR = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
            actualByMonth[m] += amtEUR;
            totalReceived += amtEUR;
            tickersByMonth[m].add(d.ticker);
            
            const gross = amtEUR + toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
            
            // Calculate Real Yield for this specific payment relative to current position value
            let realYield = 0;
            if (pos && pos.currentPrice > 0 && pos.balance > 0) {
                const priceInEUR = (pos.assetCurrency === 'USD' && liveRate > 0) ? pos.currentPrice / liveRate : pos.currentPrice;
                const positionValueEUR = pos.balance * priceInEUR;
                if (positionValueEUR > 0) {
                    realYield = gross / positionValueEUR;
                }
            }

            listItems.push({
                id: null, txId: d.txId, ticker: d.ticker, name: pos.name, isin: pos.isin, assetType: pos.assetType, date: d.date, tag: 'REGISTRATO',
                amount: null, totalAmount: amtEUR, gross, tax: d.tax || 0, annualProjected: 0, yield: 0, realYield
            });
        });

        // Projected
        savedProjections.forEach(p => {
            const m = parseInt(p.exDate.split('-')[1]) - 1;
            
            let grossEUR = p.gross;
            let taxEUR = p.tax;
            let netEUR = p.totalAmount;

            if (grossEUR === 0 && netEUR > 0 && p.tag !== 'STORICO' && p.tag !== 'SIMULATO') {
                grossEUR = p.totalAmount;
                const asset = openPositions.find(op => op.ticker === p.ticker);
                const assetType = asset ? asset.assetType : 'Azioni';
                let taxRate = taxMap[assetType];
                if (taxRate === undefined) taxRate = 26.0;
                taxEUR = grossEUR * (taxRate / 100);
                netEUR = grossEUR - taxEUR;
            }

            if (p.tag === 'MANUALE') {
                if (p.tax !== undefined && p.tax > 0) {
                    taxEUR = p.tax;
                    grossEUR = p.gross > 0 ? p.gross : p.totalAmount + p.tax;
                    netEUR = p.totalAmount;
                }
            }

            projectedByMonth[m] += netEUR;
            totalExpected += netEUR;
            tickersByMonth[m].add(p.ticker);
            const asset = openPositions.find(op => op.ticker === p.ticker);
            listItems.push({
                id: p.id, ticker: p.ticker, name: p.name, isin: asset ? asset.isin : null, assetType: asset ? asset.assetType : null, date: p.exDate, tag: p.tag,
                amount: p.amount, 
                totalAmount: netEUR, 
                gross: grossEUR, 
                tax: taxEUR, 
                annualProjected: 0, yield: p.yield, isCustom: p.isCustom
            });
        });

        // Compute annual sums per ticker
        const distinctTickers = [...new Set(listItems.map(l => l.ticker))];
        for (const t of distinctTickers) {
            const tot = listItems.filter(l => l.ticker === t).reduce((sum, l) => sum + l.totalAmount, 0);
            listItems.filter(l => l.ticker === t).forEach(l => l.annualProjected = tot);
        }

        const months = [];
        const MONTH_NAMES = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
        for (let i = 0; i < 12; i++) {
            months.push({
                month: i + 1, name: MONTH_NAMES[i], actual: actualByMonth[i], projected: projectedByMonth[i],
                display: projectedByMonth[i], tickers: Array.from(tickersByMonth[i])
            });
        }

        res.json({
            year: currentYear,
            totalExpected: totalReceived + totalExpected,
            totalReceived,
            totalRemaining: totalExpected,
            months,
            assets: listItems.sort((a,b) => new Date(b.date) - new Date(a.date)),
            openTickers: openPositions.map(p => ({ ticker: p.ticker, name: p.name }))
        });
    } catch (err) {
        logger.error('Dividend projections error', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Endpoint for the persistent Dashboard Dividend Alert.
 * Returns summary for the current month and year.
 */
app.get('/api/analytics/current-month-dividends', requireAuth, async (req, res) => {
    try {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const monthStr = currentMonth.toString().padStart(2, '0');
        const yearMonth = `${currentYear}-${monthStr}`;

        // Get projected dividends for this month (filtered by user)
        const projections = database.db.prepare(`
            SELECT SUM(dp.totalAmount) as total, COUNT(*) as count 
            FROM dividend_projections dp
            WHERE dp.user_id = ? AND dp.exDate LIKE ?
        `).get(req.user.id, yearMonth + '%');

        // Get already received dividends for this month from transactions (filtered by user)
        const received = database.db.prepare(`
            SELECT SUM(t.amount) as total, COUNT(*) as count 
            FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE pu.user_id = ? AND t.type = 'DIVIDEND' AND t.date LIKE ?
        `).get(req.user.id, yearMonth + '%');

        const totalAmount = (projections.total || 0) + (received.total || 0);
        const totalCount = (projections.count || 0) + (received.count || 0);

        const todayStr = now.toISOString().split('T')[0];
        const exDateTodayAssets = database.db.prepare(`
            SELECT ticker, totalAmount 
            FROM dividend_projections 
            WHERE user_id = ? AND exDate = ?
        `).all(req.user.id, todayStr);
        const todayCount = exDateTodayAssets.length;

        const MONTH_NAMES_LONG = [
            'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
            'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
        ];

        res.json({
            monthName: MONTH_NAMES_LONG[currentMonth - 1],
            year: currentYear,
            count: totalCount,
            amount: totalAmount,
            hasDividends: totalCount > 0,
            isExDateToday: todayCount > 0,
            todayCount: todayCount,
            todayAssets: exDateTodayAssets
        });
    } catch (err) {
        logger.error('Current month dividends error', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/reports', requireAuth, async (req, res) => {
    try {
        const { range = '1Y', portfolioIds } = req.query;
        // Parse selected portfolio IDs from query string
        const selectedPIds = (portfolioIds && portfolioIds.trim() !== '')
            ? portfolioIds.split(',').map(Number).filter(n => !isNaN(n))
            : null;

        // Build portfolio filter: if specific IDs provided use them, else all user portfolios
        let portfolioFilter = '';
        let params = [req.user.id];
        if (selectedPIds && selectedPIds.length > 0) {
            const placeholders = selectedPIds.map(() => '?').join(',');
            portfolioFilter = ` AND p.id IN (${placeholders})`;
            params = [...params, ...selectedPIds];
        }

        const portfolios = database.db.prepare(`
            SELECT p.* FROM portfolios p
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE pu.user_id = ? ${portfolioFilter}
        `).all(...params);
        if (portfolios.length === 0) return res.json({ error: 'No portfolios found' });

        const pIdsForQuery = portfolios.map(p => p.id);
        const txPlaceholders = pIdsForQuery.map(() => '?').join(',');
        const allTransactions = database.db.prepare(`
            SELECT t.* FROM transactions t
            WHERE t.portfolioId IN (${txPlaceholders})
            ORDER BY t.date ASC
        `).all(...pIdsForQuery);
        const assets = database.db.prepare('SELECT * FROM assets').all();
        const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

        const today = new Date();

        let startDate;
        switch (range) {
            case '1M':
                startDate = new Date(today);
                startDate.setMonth(today.getMonth() - 1);
                break;
            case '6M':
                startDate = new Date(today);
                startDate.setMonth(today.getMonth() - 6);
                break;
            case '1Y':
                startDate = new Date(today);
                startDate.setFullYear(today.getFullYear() - 1);
                break;
            case '2Y':
                startDate = new Date(today);
                startDate.setFullYear(today.getFullYear() - 2);
                break;
            case '3Y':
                startDate = new Date(today);
                startDate.setFullYear(today.getFullYear() - 3);
                break;
            case '5Y':
                startDate = new Date(today);
                startDate.setFullYear(today.getFullYear() - 5);
                break;
            case 'YTD':
                startDate = new Date(today.getFullYear(), 0, 1);
                break;
            case 'ALL':
                startDate = allTransactions.length > 0 ? new Date(allTransactions[0].date) : new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
                break;
            default:
                startDate = new Date(today);
                startDate.setFullYear(today.getFullYear() - 1);
        }

        const dateStrStart = startDate.toISOString().split('T')[0];
        const dateStrEnd = today.toISOString().split('T')[0];

        // Pass the selected portfolio IDs so performance history respects the filter
        const portfolioData = await calculatePerformanceHistory(
            selectedPIds && selectedPIds.length > 0 ? selectedPIds : pIdsForQuery,
            range, false, true, null, req.user.id
        );
        if (!portfolioData || !portfolioData.dataPoints || portfolioData.dataPoints.length === 0) {
             return res.json({ error: 'No performance data' });
        }

        // Fetch Benchmarks in parallel
        const fetchBenchmark = async (ticker) => {
            try {
                const chart = await yahooFinance.chart(ticker, {
                    period1: dateStrStart,
                    period2: dateStrEnd,
                    interval: '1mo'
                });
                if (chart && chart.quotes && chart.quotes.length > 0) {
                    const firstPrice = chart.quotes[0].adjclose || chart.quotes[0].close;
                    return chart.quotes.map(h => ({
                        date: new Date(h.date).toISOString().split('T')[0].substring(0, 7),
                        value: ((h.adjclose || h.close) / (firstPrice || 1)) * 100
                    }));
                }
            } catch (e) {
                console.warn(`Failed benchmark fetch for ${ticker}:`, e.message);
            }
            return [];
        };

        const [sp500, msci] = await Promise.all([fetchBenchmark('^GSPC'), fetchBenchmark('URTH')]);

        const downsampleToMonthly = (daily) => {
            const monthly = [];
            let currentMonthEvents = [];
            for (let i = 0; i < daily.length; i++) {
                const day = daily[i];
                const mStr = day.date.substring(0, 7);
                if (day.events) currentMonthEvents.push(...day.events);
                
                const next = daily[i+1];
                if (!next || next.date.substring(0, 7) !== mStr) {
                    monthly.push({
                        ...day,
                        date: mStr,
                        events: [...currentMonthEvents]
                    });
                    currentMonthEvents = [];
                }
            }
            return monthly;
        };

        const monthlyGlobal = downsampleToMonthly(portfolioData.dataPoints);
        const monthlyIndividual = {};
        for (const pid in portfolioData.individual) {
            const p = portfolios.find(port => port.id == pid);
            monthlyIndividual[pid] = {
                id: pid,
                name: p ? p.name : pid,
                history: downsampleToMonthly(portfolioData.individual[pid]),
                metrics: {}
            };
        }

        // Normalize History (Standardize to 100 at the beginning of the period)
        const normalizeRelative = (history) => {
            if (history.length === 0) return [];
            const first = history[0];
            
            // ROI Base Fallback: If netDeposits is 0, we assume the "investment" is the 
            // cost basis of the assets (Value - Profit).
            const getRatio = (p) => {
                if (p.netDeposits > 0) return p.value / p.netDeposits;
                const impliedInvestment = Math.max(1, p.value - p.profit);
                return p.value / impliedInvestment;
            };

            const firstRatio = getRatio(first);
            return history.map(p => {
                const currentRatio = getRatio(p);
                return {
                    date: p.date.substring(0, 7),
                    value: (currentRatio / (firstRatio || 1)) * 100,
                    absoluteValue: Math.round(p.value),
                    profit: Math.round(p.profit),
                    netDeposits: p.netDeposits || 0
                };
            });
        };

        const normalizedGlobal = normalizeRelative(monthlyGlobal);
        const lastGlobal = normalizedGlobal.length > 0 ? normalizedGlobal[normalizedGlobal.length - 1] : null;
        const firstGlobal = normalizedGlobal.length > 0 ? normalizedGlobal[0] : null;
        const riskFreeMonthly = 0.002;

        for (const pid in monthlyIndividual) {
            const p = monthlyIndividual[pid];
            const portfolioObj = portfolios.find(port => port.id == pid);
            p.history = normalizeRelative(p.history);
            const last = p.history.length > 0 ? p.history[p.history.length - 1] : null;
            const first = p.history.length > 0 ? p.history[0] : null;
            
            const periodProfit = (first && last) ? last.profit - first.profit : (last ? last.profit : 0);
            const periodNetFlow = (first && last) ? last.netDeposits - first.netDeposits : (last ? last.netDeposits : 0);
            const periodStartValue = first ? first.absoluteValue : 0;
            const currentVal = last ? last.absoluteValue : 0;
            
            const roi = calculateROI(currentVal, periodStartValue + periodNetFlow, periodProfit);
            
            // Calculate individual TWR
            const indHistory = portfolioData.individual[pid];
            let indTwr = 0;
            if (indHistory.length >= 2) {
                const subPeriods = [];
                for (let i = 1; i < indHistory.length; i++) {
                    const prev = indHistory[i-1];
                    const curr = indHistory[i];
                    subPeriods.push({
                        startingValue: prev.value,
                        endingValue: curr.value,
                        netCashFlow: curr.netDeposits - prev.netDeposits
                    });
                }
                indTwr = calculateTWR(subPeriods);
            }

            // Calculate individual XIRR
            const pTxs = allTransactions.filter(t => t.portfolioId == pid && ['DEPOSIT', 'WITHDRAWAL'].includes(t.type));
            const pFlows = pTxs.map(t => {
                const rate = (portfolioObj && portfolioObj.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
                const amt = (t.amount || (t.quantity * t.price)) / rate;
                return { date: new Date(t.date), amount: t.type === 'DEPOSIT' ? -amt : amt };
            });
            pFlows.push({ date: new Date(), amount: currentVal });
            pFlows.sort((a,b) => a.date - b.date);
            const indXirr = pFlows.length >= 2 ? (xirr(pFlows) || 0) : 0;

            p.metrics = {
                totalROI: roi,
                twr: indTwr,
                xirr: indXirr,
                currentValue: currentVal,
                contribution: (lastGlobal && lastGlobal.absoluteValue > 0) ? 
                    (currentVal / lastGlobal.absoluteValue) : 0,
                sharpeRatio: (() => {
                    const returns = [];
                    for (let i = 1; i < p.history.length; i++) {
                        const prev = p.history[i-1].value;
                        const curr = p.history[i].value;
                        if (prev > 0) returns.push((curr / prev) - 1);
                    }
                    if (returns.length < 2) return 0;
                    const m = returns.reduce((a, b) => a + b, 0) / returns.length;
                    const s = Math.sqrt(returns.map(x => Math.pow(x - m, 2)).reduce((a, b) => a + b, 0) / returns.length);
                    return s > 0 ? (m - riskFreeMonthly) / s : 0;
                })()
            };
        }

        // 2. Diversification (assetType, geography, currency)
        const diversification = {
            geography: {},
            assetType: {},
            currency: {}
        };

        for (const p of portfolios) {
            const holdings = {};
            const holdingsCost = {};
            const pTxs = allTransactions.filter(t => t.portfolioId === p.id);
            for (const t of pTxs) {
                if (t.type === 'BUY') {
                    holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + t.quantity;
                    const costAsset = t.amount ? (Math.abs(t.amount) * (t.exchangeRate || 1)) : (t.quantity * t.price + t.commission + t.tax);
                    holdingsCost[t.assetTicker] = (holdingsCost[t.assetTicker] || 0) + costAsset;
                }
                if (t.type === 'SELL') {
                    const avgCost = holdings[t.assetTicker] > 0 ? (holdingsCost[t.assetTicker] || 0) / holdings[t.assetTicker] : 0;
                    holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - t.quantity;
                    holdingsCost[t.assetTicker] = Math.max(0, (holdingsCost[t.assetTicker] || 0) - (t.quantity * avgCost));
                }
            }
            for (const [ticker, shares] of Object.entries(holdings)) {
                if (shares <= 0.0001) continue;
                const a = assetMap[ticker];
                if (!a) continue;
                // Use last known exchange rate for currency conversion
                const lastExRate = pTxs.filter(tx => tx.assetTicker === ticker && tx.exchangeRate).at(-1)?.exchangeRate || 1;
                
                let curPx = a.currentPrice;
                if (ticker.startsWith('CD_')) {
                    curPx = shares > 0 ? (holdingsCost[ticker] || 0) / shares : 0;
                }
                
                const value = shares * (curPx / lastExRate);

                const geo = a.country || 'Unknown';
                const type = a.type || 'Other';
                const currency = a.currency || p.currency || 'EUR';
                diversification.geography[geo] = (diversification.geography[geo] || 0) + value;
                diversification.assetType[type] = (diversification.assetType[type] || 0) + value;
                diversification.currency[currency] = (diversification.currency[currency] || 0) + value;
            }
        }

        // 3. Dividends (Last 12 Months)
        const dividends = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
            const mStr = d.toISOString().substring(0, 7);
            const monthlyDiv = allTransactions
                .filter(t => t.type === 'DIVIDEND' && t.date.startsWith(mStr))
                .reduce((sum, t) => sum + (t.amount || (t.quantity * t.price - t.commission - t.tax)) / (t.exchangeRate || 1), 0);
            dividends.push({ date: mStr, amount: monthlyDiv });
        }

        // 4. Metrics

        const currentTotalValue = lastGlobal ? lastGlobal.absoluteValue : 0;
        const currentProfit = lastGlobal ? lastGlobal.profit : 0;
        const currentNetDeposits = lastGlobal ? lastGlobal.netDeposits : 0;

        const gPeriodNetFlow = (firstGlobal && lastGlobal) ? lastGlobal.netDeposits - firstGlobal.netDeposits : (lastGlobal ? lastGlobal.netDeposits : 0);
        const gPeriodStartValue = firstGlobal ? firstGlobal.absoluteValue : 0;
        const gPeriodProfit = (firstGlobal && lastGlobal) ? lastGlobal.profit - firstGlobal.profit : (lastGlobal ? lastGlobal.profit : 0);
        
        const totalROI = calculateROI(currentTotalValue, gPeriodStartValue + gPeriodNetFlow, gPeriodProfit);

        // --- NEW: Financial Metrics (XIRR & TWR) ---
        const externalTxs = allTransactions.filter(t => ['DEPOSIT', 'WITHDRAWAL'].includes(t.type));
        const flows = [];
        for (const t of externalTxs) {
            const p = portfolios.find(port => port.id === t.portfolioId);
            const rate = (p && p.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
            const amt = (t.amount || (t.quantity * t.price)) / rate;
            flows.push({
                date: new Date(t.date),
                amount: t.type === 'DEPOSIT' ? -amt : amt
            });
        }
        flows.push({ date: new Date(), amount: currentTotalValue });
        flows.sort((a,b) => a.date - b.date);
        const xirrValue = flows.length >= 2 ? (xirr(flows) || 0) : 0;

        let twrSeries = [];
        const twrValue = (() => {
            const data = portfolioData.dataPoints;
            if (data.length < 2) return 0;
            const subPeriods = [];
            let cumulativeTwr = 1;
            twrSeries.push({ date: data[0].date, value: 100, events: data[0].events });

            for (let i = 1; i < data.length; i++) {
                const prev = data[i-1];
                const curr = data[i];
                const netFlow = curr.netDeposits - prev.netDeposits;
                const hpr = prev.value > 0.01 ? (curr.value - netFlow - prev.value) / prev.value : 0;
                cumulativeTwr *= Math.max(0, 1 + hpr);
                
                twrSeries.push({
                    date: curr.date,
                    value: Math.max(0, cumulativeTwr * 100),
                    events: curr.events
                });

                subPeriods.push({
                    startingValue: prev.value,
                    endingValue: curr.value,
                    netCashFlow: netFlow
                });
            }
            return calculateTWR(subPeriods);
        })();

        // Downsample TWR series for comparison chart (monthly)
        const monthlyTwr = downsampleToMonthly(twrSeries);

        // Best Asset (by absolute profit)
        let bestAsset = { ticker: '-', profit: -Infinity };
        for (const [ticker, a] of Object.entries(assetMap)) {
            if (ticker === 'CASH') continue;
            let unrealized = 0;
            let realized = 0;
            let qty = 0;
            let costBasis = 0;
            const tks = allTransactions.filter(t => t.assetTicker === ticker);
            for (const t of tks) {
                const total = (t.amount || (t.quantity * t.price + (t.type==='BUY'?1:-1)*(t.commission+t.tax))) / (t.exchangeRate||1);
                if (t.type === 'BUY') {
                    qty += t.quantity;
                    costBasis += total;
                } else if (t.type === 'SELL') {
                    const avgCost = qty > 0 ? costBasis / qty : 0;
                    realized += total - (t.quantity * avgCost);
                    qty -= t.quantity;
                    costBasis -= (t.quantity * avgCost);
                } else if (t.type === 'DIVIDEND') {
                    realized += (t.amount || (t.quantity * t.price - t.commission - t.tax)) / (t.exchangeRate || 1);
                }
            }
            unrealized = qty * (a.currentPrice / (tks.filter(tx=>tx.exchangeRate).at(-1)?.exchangeRate||1)) - costBasis;
            const totalProfit = realized + unrealized;
            if (totalProfit > bestAsset.profit) bestAsset = { ticker, profit: totalProfit, name: a.name };
        }

        // 5. Annual Gains (Realized + Dividends + Unrealized for Current Year)
        const annualGainsMap = {}; // { year: { realized: 0, dividends: 0, unrealized: 0 } }
        const currentYearString = today.getFullYear().toString();
        const liveRateValReports = await getEurUsdRate();

        for (const p of portfolios) {
            try {
                const details = await getPortfolioDetails(p.id, liveRateValReports);
                const rate = (p.currency === 'USD') ? liveRateValReports : 1;
                
                // Realized from closed positions
                for (const pos of details.closedPositions) {
                    const y = pos.year;
                    if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                    annualGainsMap[y].realized += pos.realizedGain / rate;
                }
                
                // Dividends
                for (const group of details.dividendGroups) {
                    const y = group.year;
                    if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                    annualGainsMap[y].dividends += group.total / rate;
                }
                
                // Unrealized (only current year)
                const pUnrealized = details.holdings.reduce((sum, h) => sum + (h.unrealizedGain || 0), 0);
                if (!annualGainsMap[currentYearString]) annualGainsMap[currentYearString] = { year: currentYearString, realized: 0, dividends: 0, unrealized: 0 };
                annualGainsMap[currentYearString].unrealized += pUnrealized / rate;
                
            } catch (e) {
                console.error(`Error aggregating annual gains for portfolio ${p.id}:`, e);
            }
        }

        const annualGains = Object.values(annualGainsMap).sort((a,b) => b.year - a.year);

        res.json({
            performance: {
                portfolio: normalizedGlobal, // This is ROI-based (Wealth-Weighted)
                twr: monthlyTwr,             // This is true Time-Weighted Return
                individual: monthlyIndividual,
                sp500,
                msci
            },
            diversification,
            dividends,
            annualGains,
            metrics: {
                totalROI,
                totalGain: currentProfit,
                annualizedROI: Math.pow(1 + totalROI, 1 / (Math.max(1, monthlyGlobal.length) / 12)) - 1,
                xirr: xirrValue,
                twr: twrValue,
                bestAsset: bestAsset.ticker === '-' ? '-' : `${bestAsset.name} (${bestAsset.ticker})`,
                sharpeRatio: (() => {
                    const returns = [];
                    for (let i = 1; i < normalizedGlobal.length; i++) {
                        const prev = normalizedGlobal[i-1].value;
                        const curr = normalizedGlobal[i].value;
                        if (prev > 0) returns.push((curr / prev) - 1);
                    }
                    if (returns.length < 2) return 0;
                    const meanValue = returns.reduce((a, b) => a + b, 0) / returns.length;
                    const stdDevValue = Math.sqrt(returns.map(x => Math.pow(x - meanValue, 2)).reduce((a, b) => a + b, 0) / returns.length);
                    return stdDevValue > 0 ? (meanValue - riskFreeMonthly) / stdDevValue : 0;
                })(),
                dividendYield: currentTotalValue > 0 ? dividends.reduce((s, x) => s + x.amount, 0) / currentTotalValue : 0
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// BACKUP API
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// BACKUP API
// ════════════════════════════════════════════════════════════════════════════

// --- System Backups (SQLite - Admin Only) ---
app.get('/api/backups', requireAuth, requireAdmin, (req, res) => {
    res.json(backupManager.listBackups());
});

app.post('/api/backups/manual', requireAuth, requireAdmin, async (req, res) => {
    try {
        const metadata = await backupManager.createBackup(false);
        res.json(metadata);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/backups/restore', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).send('Filename required');
        await backupManager.restoreBackup(filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/backups/:filename', requireAuth, requireAdmin, (req, res) => {
    try {
        backupManager.deleteBackup(req.params.filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- User Backups (JSON - Export/Import) ---
app.get('/api/backups/export', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const data = {
            version: '2.0',
            exportedAt: new Date().toISOString(),
            portfolios: [],
            transactions: [],
            settings: [],
            tax_rates: [],
            user_watchlist: [],
            notifications: [],
            dividend_projections: [],
            portfolio_history: []
        };

        const portfolios = database.db.prepare(`
            SELECT p.* FROM portfolios p 
            JOIN portfolio_users pu ON p.id = pu.portfolio_id 
            WHERE pu.user_id = ?
        `).all(userId);
        data.portfolios = portfolios;

        const pIds = portfolios.map(p => p.id);
        if (pIds.length > 0) {
            const placeholders = pIds.map(() => '?').join(',');
            data.transactions = database.db.prepare(`SELECT * FROM transactions WHERE portfolioId IN (${placeholders})`).all(...pIds);
            data.portfolio_history = database.db.prepare(`SELECT * FROM portfolio_history WHERE portfolioId IN (${placeholders})`).all(...pIds);
        }
        
        const globalHistory = database.db.prepare(`SELECT * FROM portfolio_history WHERE portfolioId IS NULL AND user_id = ?`).all(userId);
        data.portfolio_history.push(...globalHistory);

        data.settings = database.db.prepare(`SELECT * FROM settings WHERE user_id = ?`).all(userId);
        data.tax_rates = database.db.prepare(`SELECT * FROM tax_rates WHERE user_id = ?`).all(userId);
        data.user_watchlist = database.db.prepare(`SELECT * FROM user_watchlist WHERE user_id = ?`).all(userId);
        data.notifications = database.db.prepare(`SELECT * FROM notifications WHERE user_id = ?`).all(userId);
        data.dividend_projections = database.db.prepare(`SELECT * FROM dividend_projections WHERE user_id = ?`).all(userId);

        res.setHeader('Content-disposition', `attachment; filename=foliotracker_export_${new Date().toISOString().split('T')[0]}.json`);
        res.setHeader('Content-type', 'application/json');
        
        logAudit(userId, 'DATA_EXPORT', { count: data.portfolios.length }, req);
        
        res.send(JSON.stringify(data, null, 2));
    } catch (err) {
        logger.error('Export failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/backups/import', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const userId = req.user.id;
        const data = req.body;
        if (!data || !data.portfolios) return res.status(400).json({ error: 'Invalid backup format' });

        database.db.transaction(() => {
            // 1. Portfolios & Transactions
            const pIdMap = {}; // oldId -> newId
            for (const p of data.portfolios) {
                const oldId = p.id;
                delete p.id;
                const result = database.db.prepare(`
                    INSERT INTO portfolios (name, type, currency, startDate, initialCash, currentCash, totalValue, performance1D, performance1DPrePost, totalDividends, investedCapital, assetCount, color)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(p.name, p.type, p.currency, p.startDate, p.initialCash, p.currentCash, p.totalValue, p.performance1D, p.performance1DPrePost, p.totalDividends, p.investedCapital, p.assetCount, p.color);
                const newId = result.lastInsertRowid;
                pIdMap[oldId] = newId;
                
                // Associate with current user
                database.db.prepare(`INSERT INTO portfolio_users (portfolio_id, user_id) VALUES (?, ?)`).run(newId, userId);
            }

            for (const t of data.transactions) {
                const newPId = pIdMap[t.portfolioId];
                if (!newPId) continue;
                database.db.prepare(`
                    INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(newPId, t.type, t.assetTicker, t.date, t.quantity, t.price, t.commission, t.tax, t.exchangeRate, t.amount);
            }

            // 2. Settings (Merge/Overwrite)
            for (const s of data.settings) {
                database.db.prepare(`INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)`).run(userId, s.key, s.value);
            }

            // 3. Tax Rates
            for (const tr of data.tax_rates) {
                database.db.prepare(`INSERT OR REPLACE INTO tax_rates (user_id, asset_type, rate) VALUES (?, ?, ?)`).run(userId, tr.asset_type, tr.rate);
            }

            // 4. Watchlist
            for (const w of data.user_watchlist) {
                database.db.prepare(`INSERT OR REPLACE INTO user_watchlist (user_id, ticker, targetPrice, stopLoss, volatilityAlert) VALUES (?, ?, ?, ?, ?)`).run(userId, w.ticker, w.targetPrice, w.stopLoss, w.volatilityAlert);
            }

            // 5. Projections & History
            for (const dp of data.dividend_projections) {
                database.db.prepare(`INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, yield, tag, year, isCustom) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, dp.ticker, dp.name, dp.exDate, dp.amount, dp.totalAmount, dp.yield, dp.tag, dp.year, dp.isCustom);
            }

            for (const ph of data.portfolio_history) {
                const newPId = ph.portfolioId ? pIdMap[ph.portfolioId] : null;
                // If it was a portfolio history point but the portfolio didn't import, skip
                if (ph.portfolioId && !newPId) continue; 
                database.db.prepare(`INSERT INTO portfolio_history (portfolioId, user_id, date, totalValue, cashValue, assetValue, netDeposits) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newPId, userId, ph.date, ph.totalValue, ph.cashValue, ph.assetValue, ph.netDeposits);
            }
        })();

        res.json({ success: true, message: 'Data imported successfully' });
    } catch (err) {
        logger.error('Import failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// LOGS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/logs', (req, res) => {
    try {
        const maxLines = parseInt(req.query.lines) || 2000;
        const dateParam = req.query.date; // YYYY-MM-DD

        let content = '';
        if (dateParam) {
            // Return a specific day's rotated log file
            const rotatedFile = getRotatedLogFile(new Date(dateParam));
            if (fs.existsSync(rotatedFile)) {
                content = fs.readFileSync(rotatedFile, 'utf8');
            }
        } else {
            // Return master log (all days)
            if (fs.existsSync(LOG_FILE)) {
                content = fs.readFileSync(LOG_FILE, 'utf8');
            }
        }
        if (!content) return res.json([]);
        const lines = content.trim().split('\n').filter(Boolean);
        res.json(lines.slice(-maxLines).reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List available log dates
app.get('/api/logs/dates', (req, res) => {
    try {
        if (!fs.existsSync(LOGS_DIR)) return res.json([]);
        const files = fs.readdirSync(LOGS_DIR)
            .filter(f => f.match(/^app-\d{4}-\d{2}-\d{2}\.log$/))
            .map(f => f.replace('app-', '').replace('.log', ''))
            .sort().reverse();
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/market-status', (req, res) => {
    res.json({
        ...getMarketStatus(),
        lastUpdate: globalLastMarketUpdate
    });
});



app.post('/api/market-sync', async (req, res) => {
    try {
        logger.info('Manual market sync triggered.');
        updateMarketData(true); // force = true
        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ══ PURGE PERFORMANCE HISTORY ══
app.post('/api/admin/purge-performance', requireAuth, (req, res) => {
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const scope = req.query.scope || 'user'; // 'user' or 'system'

    try {
        database.db.transaction(() => {
            if (isAdmin && scope === 'system') {
                const tables = ['portfolio_history', 'portfolio_losses', 'asset_quotes'];
                for (const table of tables) {
                    database.db.prepare(`DELETE FROM ${table}`).run();
                }
                logger.info('System-wide performance history purged by admin.');
            } else {
                // User-level purge
                // 1. Portfolio history & losses for user portfolios
                const pIds = database.db.prepare(`SELECT portfolio_id FROM portfolio_users WHERE user_id = ?`).all(userId).map(r => r.portfolio_id);
                if (pIds.length > 0) {
                    const placeholders = pIds.map(() => '?').join(',');
                    database.db.prepare(`DELETE FROM portfolio_history WHERE portfolioId IN (${placeholders})`).run(...pIds);
                    database.db.prepare(`DELETE FROM portfolio_losses WHERE portfolioId IN (${placeholders})`).run(...pIds);
                }
                // 2. Global history points
                database.db.prepare(`DELETE FROM portfolio_history WHERE portfolioId IS NULL AND user_id = ?`).run(userId);
                logger.info(`Performance history purged for user ${userId}.`);
            }
        })();
        
        clearPerformanceCache();
        res.json({ success: true, message: 'Performance history purged. Portfolios and transactions were kept.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ══ APPLICATION DATA RESET ══
app.post('/api/reset-data', requireAuth, (req, res) => {
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const scope = req.query.scope || 'user'; // 'user' or 'system'

    logger.info(`Initiating data reset (Scope: ${scope}) for user ${userId}...`);
    logAudit(userId, 'DATA_RESET', { scope }, req);
    
    try {
        database.db.transaction(() => {
            if (isAdmin && scope === 'system') {
                // FULL SYSTEM WIPE (Existing logic)
                const tables = [
                    'notifications', 'portfolio_history', 'portfolio_losses', 'asset_quotes', 
                    'dividend_projections', 'transactions', 'portfolios', 'assets', 
                    'tax_rates', 'settings', 'test'
                ];
                for (const table of tables) {
                    try { database.db.prepare(`DELETE FROM ${table}`).run(); } catch (e) {}
                }
                database.initDb();
                logger.info('FULL SYSTEM RESET COMPLETED.');
            } else {
                // USER-LEVEL WIPE
                const pIds = database.db.prepare(`SELECT portfolio_id FROM portfolio_users WHERE user_id = ?`).all(userId).map(r => r.portfolio_id);
                for (const pId of pIds) {
                    const usersCount = database.db.prepare(`SELECT COUNT(*) as c FROM portfolio_users WHERE portfolio_id = ?`).get(pId).c;
                    if (usersCount <= 1) {
                        database.db.prepare(`DELETE FROM portfolios WHERE id = ?`).run(pId);
                    } else {
                        database.db.prepare(`DELETE FROM portfolio_users WHERE portfolio_id = ? AND user_id = ?`).run(pId, userId);
                    }
                }
                
                const userTables = ['notifications', 'portfolio_history', 'dividend_projections', 'user_watchlist', 'tax_rates', 'settings'];
                for (const table of userTables) {
                    database.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
                }
                logger.info(`User-level data reset completed for user ${userId}.`);
            }
        })();

        clearPerformanceCache();
        lastUpdateTime = 0;
        res.json({ success: true, message: scope === 'system' ? 'Application has been fully reset.' : 'Your data has been reset.' });
    } catch (err) {
        logger.error('RESET ERROR:', err);
        res.status(500).json({ error: 'Reset failed: ' + err.message });
    }
});

// Notification Settings Matrix
app.get('/api/settings/notifications', requireAuth, (req, res) => {
    try {
        const settings = database.getSettings(req.user.id);
        const matrix = {
            tp: { telegram: settings.notify_tp_telegram === 'true', push: settings.notify_tp_push === 'true' },
            sl: { telegram: settings.notify_sl_telegram === 'true', push: settings.notify_sl_push === 'true' },
            vol: { telegram: settings.notify_vol_telegram === 'true', push: settings.notify_vol_push === 'true' },
            daily: { telegram: settings.notify_daily_telegram === 'true', push: settings.notify_daily_push === 'true' },
            status: { telegram: settings.notify_status_telegram === 'true', push: settings.notify_status_push === 'true' },
            dividend: { telegram: settings.notify_dividend_telegram === 'true', push: settings.notify_dividend_push === 'true' }
        };
        res.json(matrix);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings/notifications', requireAuth, (req, res) => {
    const matrix = req.body; // { tp: { telegram: true, push: false }, ... }
    try {
        const userId = req.user.id;
        const updates = [];
        for (const [event, channels] of Object.entries(matrix)) {
            updates.push({ key: `notify_${event}_telegram`, value: String(channels.telegram) });
            updates.push({ key: `notify_${event}_push`, value: String(channels.push) });
        }
        
        database.db.transaction(() => {
            const stmt = database.db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)');
            for (const u of updates) {
                stmt.run(userId, u.key, u.value);
            }
        })();
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Telegram Test Endpoints ────────────────────────────────────────────────
app.post('/api/settings/telegram/test-tp', async (req, res) => {
    try {
        const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        const msg = `${escapeV2('🏆')} *${escapeV2('TARGET PROFIT')}*\n\n` +
                    `\`${escapeCodeV2('AAPL     $ 190,50')}\`\n` +
                    `*${escapeV2('Target:')}* \`${escapeCodeV2('$ 190,00')}\`\n\n` +
                    `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
        await sendTelegramMessage(msg);
        res.json({ success: true, message: 'Test TP sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/telegram/test-sl', async (req, res) => {
    try {
        const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        const msg = `${escapeV2('⚠️')} *${escapeV2('STOP LOSS')}*\n\n` +
                    `\`${escapeCodeV2('TSLA     $ 165,20')}\`\n` +
                    `*${escapeV2('Soglia:')}* \`${escapeCodeV2('$ 170,00')}\`\n\n` +
                    `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
        await sendTelegramMessage(msg);
        res.json({ success: true, message: 'Test SL sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/telegram/test-volatility', async (req, res) => {
    try {
        const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        const msg = `${escapeV2('📊')} *${escapeV2('VOLATILITY ALERT')}*\n\n` +
                    `${escapeV2('📈')} \`${escapeCodeV2('BTC.USD  $ 68.340,50')}\`\n` +
                    `*${escapeV2('Var.:')}* \`${escapeCodeV2('+5,20%')}\` ${escapeV2('(Soglia: 5%)')}\n\n` +
                    `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
        await sendTelegramMessage(msg);
        res.json({ success: true, message: 'Test Volatility sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/telegram/test-status', async (req, res) => {
    try {
        await sendMarketStatusTelegram();
        res.json({ success: true, message: 'Test Status sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/debug/telegram-market', async (req, res) => {
    try {
        const settings = database.getSettings(1);
        if (settings.telegramEnabled !== 'true') {
            return res.json({ success: false, error: 'Telegram is globally disabled in settings.' });
        }
        if (!settings.telegramBotToken || !settings.telegramChatId) {
            return res.json({ success: false, error: 'Missing Bot Token or Chat ID in settings.' });
        }
        await sendMarketStatusTelegram();
        res.json({ success: true, message: 'Notification sent successfully.' });
    } catch (err) {
        logger.error('Debug Telegram failed', err);
        res.json({ success: false, error: err.message || 'Unknown error' });
    }
});

app.get('/api/logs/telegram', (req, res) => {
    try {
        if (!fs.existsSync(TELEGRAM_LOG_FILE)) return res.json([]);
        const content = fs.readFileSync(TELEGRAM_LOG_FILE, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        res.json(lines.slice(-200).reverse()); // Last 200 lines
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});





// ════════════════════════════════════════════════════════════════════════════
// NEWS API ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/news', requireAuth, (req, res) => {
    try {
        const rows = database.db.prepare('SELECT * FROM news_articles WHERE user_id = ? ORDER BY pubDate DESC LIMIT 50').all(req.user.id);
        res.json(rows);
    } catch (err) {
        logger.error('/api/news error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settings/news-sources', requireAuth, (req, res) => {
    try {
        const rows = database.db.prepare('SELECT * FROM news_sources WHERE user_id = ? ORDER BY created_at ASC').all(req.user.id);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/news-sources', requireAuth, express.json(), (req, res) => {
    try {
        const { name, url } = req.body;
        if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
        
        const stmt = database.db.prepare('INSERT INTO news_sources (user_id, name, url) VALUES (?, ?, ?)');
        const info = stmt.run(req.user.id, name, url);
        
        // Trigger a background sync immediately so the user sees news right away
        setTimeout(() => {
            syncNews().catch(e => logger.error('Error in immediate sync:', e));
        }, 100);

        res.json({ id: info.lastInsertRowid, name, url, is_enabled: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings/news-sources/:id', requireAuth, express.json(), (req, res) => {
    try {
        const { is_enabled } = req.body;
        const stmt = database.db.prepare('UPDATE news_sources SET is_enabled = ? WHERE id = ? AND user_id = ?');
        stmt.run(is_enabled ? 1 : 0, req.params.id, req.user.id);
        
        // Trigger a background sync immediately
        setTimeout(() => {
            syncNews().catch(e => logger.error('Error in immediate sync:', e));
        }, 100);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/settings/news-sources/:id', requireAuth, (req, res) => {
    try {
        const stmt = database.db.prepare('DELETE FROM news_sources WHERE id = ? AND user_id = ?');
        stmt.run(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



app.get('/api/news/sources', (req, res) => {
    try {
        const settings = database.getSettings(1);
        let disabledSources = [];
        try { disabledSources = JSON.parse(settings.disabledNewsSources || '[]'); } catch (e) {}

        const rows = database.db.prepare(`SELECT DISTINCT publisher FROM global_news ORDER BY publisher ASC`).all();
        const sources = rows.map(r => ({
            name: r.publisher,
            isEnabled: !disabledSources.includes(r.publisher)
        }));
        res.json(sources);
    } catch (err) {
        logger.error('/api/news/sources error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/news/sources', express.json(), (req, res) => {
    try {
        const { disabledSources } = req.body;
        if (!Array.isArray(disabledSources)) return res.status(400).json({ error: 'Must be an array' });
        database.setSetting('disabledNewsSources', JSON.stringify(disabledSources));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// STATIC FILES  (must come AFTER all API routes)
// ════════════════════════════════════════════════════════════════════════════

app.use(express.static(path.join(__dirname, '../public')));

// Helper to detect mobile devices
const isMobile = (req) => {
    const ua = req.headers['user-agent'] || '';
    return /Mobile|Android|iPhone|iPad|IEMobile|Opera Mini/i.test(ua);
};

// ─── HTML page routes ────────────────────────────────────────────────────────

// Public: Login page (no auth required)
app.get('/login', (req, res) => {
    // If already logged in, redirect to dashboard
    const token = req.cookies[JWT_COOKIE];
    if (token) {
        try { jwt.verify(token, JWT_SECRET); return res.redirect('/dashboard'); } catch(_) {}
    }
    res.sendFile(path.join(__dirname, '../public', 'login.html'));
});

// Admin panel (requires auth + admin role)
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, '../private_views', 'admin.html'));
});

// Protected app pages
app.get('/dashboard', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'dashboard_mobile.html' : 'dashboard.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/portfolio', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'portfolio_detail_mobile.html' : 'portfolio_detail.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/market', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'market_mobile.html' : 'market_overview.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/reports', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'reports_mobile.html' : 'reports.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/history', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'history_mobile.html' : 'history.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/dividend', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'dividend_mobile.html' : 'dividend.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/settings', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'settings_mobile.html' : 'settings.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/notifications', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'notifications_mobile.html' : 'notifications.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

app.get('/watchlist', requireAuth, (req, res) => {
    const file = isMobile(req) ? 'watchlist_mobile.html' : 'watchlist.html';
    res.sendFile(path.join(__dirname, '../private_views', file));
});

// Legacy /assets route → redirect to /market
app.get('/assets', requireAuth, (req, res) => res.redirect('/market'));

// Default → login (for unauthenticated), dashboard (for authenticated)
app.get('/', (req, res) => {
    const token = req.cookies[JWT_COOKIE];
    if (token) {
        try { jwt.verify(token, JWT_SECRET); return res.redirect('/dashboard'); } catch(_) {}
    }
    return res.redirect('/login');
});
app.use((req, res) => res.redirect('/login'));

// ════════════════════════════════════════════════════════════════════════════
// RESET DATA
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// MARKET DATA UPDATE  (runs on interval)
// ════════════════════════════════════════════════════════════════════════════

let globalLastMarketUpdate = Date.now();

async function updateMarketData(force = false) {
    const settings = database.getSettings(1);
    const status = getMarketStatus();
    if (!force && !status.anyOpen) {
        // If markets are closed, only proceed if there are assets with 0.00€ price (critical for newly imported BTPs)
        const hasZeroPrice = database.db.prepare(`SELECT id FROM assets WHERE currentPrice = 0 AND ticker != 'CASH' LIMIT 1`).get();
        if (!hasZeroPrice) {
            logger.info('Skipping automatic market update: all markets are closed.');
            return;
        }
        logger.info('Markets are closed, but fetching quotes for assets with 0.00€ price...');
    }
    const assets = database.db.prepare(`
        SELECT a.* 
        FROM assets a
        LEFT JOIN (
            SELECT assetTicker, SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
            FROM transactions
            GROUP BY assetTicker
        ) t ON a.ticker = t.assetTicker
        WHERE a.inWatchlist = 1 OR IFNULL(t.balance, 0) > 0.0001
    `).all();
    if (assets.length === 0) return;
    logger.info(`Updating market data for ${assets.length} assets...`);

    for (const asset of assets) {
        if (!asset.ticker || asset.ticker === 'CASH') continue;
        if (asset.ticker.startsWith('CD_') || (asset.dataSource && asset.dataSource.toUpperCase() === 'MANUAL')) continue; // Skip constant-value or manual assets
        if (asset.isManual === 1 && (!asset.dataSource || asset.dataSource === 'YF')) continue;
        
        // If markets are closed, only update assets with 0 price (unless forced)
        if (!force && !status.anyOpen && asset.currentPrice > 0) continue;

        logger.info(`Updating [${asset.ticker}] using [${asset.dataSource || 'YF'}]...`);
        try {
            let updateData = null;

            if (asset.dataSource === 'B_ITA' && asset.isin) {
                const result = await B_ITA(asset.isin);
                if (result.success) {
                    const changeVal = result.variation !== null ? (result.price * (result.variation / (100 + result.variation))) : 0;
                    updateData = {
                        price: result.price,
                        change: result.variation,
                        changeValue: changeVal,
                        pe: asset.pe,
                        name: asset.name,
                        currency: asset.currency || 'EUR',
                        exchange: asset.exchange,
                        country: asset.country,
                        quoteDate: result.quoteDate || new Date().toISOString().split('T')[0]
                    };
                } else {
                    logger.warn(`B_ITA scraping failed for ${asset.ticker} (${asset.isin})`);
                }
            } else {
                // Default Yahoo Finance
                const metadata = await fetchAssetMetadata(asset.ticker);
                if (!metadata) {
                    throw new Error(`YF: no quote data returned for '${asset.ticker}' (check ticker spelling or try manual update)`);
                }
                if (!metadata.currentPrice || metadata.currentPrice === 0) {
                    logger.warn(`YF: price is 0 for ${asset.ticker} — data may be stale or market closed`);
                }
                updateData = {
                    price: metadata.currentPrice || asset.currentPrice,
                    change: metadata.changePercent !== undefined && metadata.changePercent !== null ? metadata.changePercent : asset.changePercent,
                    changeValue: metadata.changeValue !== undefined && metadata.changeValue !== null ? metadata.changeValue : 0,
                    pe: metadata.pe || asset.pe,
                    forwardPE: metadata.forwardPE || asset.forwardPE,
                    pegRatio: metadata.pegRatio || asset.pegRatio,
                    dividendYield: metadata.dividendYield || asset.dividendYield,
                    eps: metadata.eps || asset.eps,
                    beta: metadata.beta || asset.beta,
                    preMarketChangePercent: metadata.preMarketChangePercent || 0,
                    postMarketChangePercent: metadata.postMarketChangePercent || 0,
                    nextDividendDate: metadata.nextDividendDate || asset.nextDividendDate,
                    name: metadata.name || asset.name,
                    currency: metadata.currency || asset.currency,
                    exchange: metadata.exchange || asset.exchange,
                    country: metadata.country || asset.country,
                    quoteDate: metadata.quoteDate || new Date().toISOString().split('T')[0]
                };
                logger.info(`YF ✓ ${asset.ticker}: price=${updateData.price} ${updateData.currency} chg=${updateData.change?.toFixed ? updateData.change.toFixed(2) : updateData.change}%`);
            }

            if (updateData) {
                database.db.prepare(`
                    UPDATE assets
                    SET currentPrice=?, changePercent=?, changeValue=?, preMarketChangePercent=?, postMarketChangePercent=?, pe=?, forwardPE=?, dividendYield=?, eps=?, beta=?, pegRatio=?, nextDividendDate=?, name=?, currency=?, exchange=?, country=?, quoteDate=?, lastUpdateError=NULL, updatedAt=datetime('now')
                    WHERE ticker=?
                `).run(
                    updateData.price,
                    updateData.change,
                    updateData.changeValue,
                    updateData.preMarketChangePercent || 0,
                    updateData.postMarketChangePercent || 0,
                    updateData.pe,
                    updateData.forwardPE,
                    updateData.dividendYield,
                    updateData.eps,
                    updateData.beta,
                    updateData.pegRatio,
                    updateData.nextDividendDate,
                    updateData.name,
                    updateData.currency,
                    updateData.exchange,
                    updateData.country,
                    updateData.quoteDate,
                    asset.ticker
                );
                logger.info(`Successfully updated ${asset.ticker}: ${updateData.price} ${updateData.currency}`);

                // Alert Checks (Per User)
                const newPrice = updateData.price;
                const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

                // Get all user alerts for this ticker
                const userAlerts = database.db.prepare(`
                    SELECT uw.*, u.telegram_chat_id 
                    FROM user_watchlist uw
                    JOIN users u ON uw.user_id = u.id
                    WHERE uw.ticker = ?
                `).all(asset.ticker);

                for (const ua of userAlerts) {
                    const tsFormatted = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                    
                    // 1. TARGET PROFIT
                    if (ua.targetPrice > 0 && newPrice >= ua.targetPrice) {
                        const existing = database.db.prepare(`
                            SELECT id FROM notifications 
                            WHERE ticker = ? AND user_id = ? AND type = 'TP' AND date(date) = date('now')
                        `).get(asset.ticker, ua.user_id);
                        if (!existing) {
                            const sym = asset.ticker.padEnd(8);
                            const cur = asset.currency === 'USD' ? '$' : '€';
                            const priceStr = newPrice.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            const targetStr = ua.targetPrice.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            
                            const tgMsg = `${escapeV2('🏆')} *${escapeV2('TARGET PROFIT')}*\n\n` +
                                        `\`${escapeCodeV2(sym + ' ' + cur + ' ' + priceStr)}\`\n` +
                                        `*${escapeV2('Target:')}* \`${escapeCodeV2(cur + ' ' + targetStr)}\`\n\n` +
                                        `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
                                        
                            notifyUser(ua.user_id, 'TP', {
                                title: `🏆 TP: ${asset.ticker}`,
                                body: `${priceStr} ${cur} (Tgt: ${targetStr})`,
                                telegramMessage: tgMsg,
                                ticker: asset.ticker,
                                data: { ticker: asset.ticker }
                            });
                        }
                    }

                    // 2. STOP LOSS
                    if (ua.stopLoss > 0 && newPrice <= ua.stopLoss) {
                        const existing = database.db.prepare(`
                            SELECT id FROM notifications 
                            WHERE ticker = ? AND user_id = ? AND type = 'SL' AND date(date) = date('now')
                        `).get(asset.ticker, ua.user_id);
                        if (!existing) {
                            const sym = asset.ticker.padEnd(8);
                            const cur = asset.currency === 'USD' ? '$' : '€';
                            const priceStr = newPrice.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            const stopStr = ua.stopLoss.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            
                            const tgMsg = `${escapeV2('⚠️')} *${escapeV2('STOP LOSS')}*\n\n` +
                                        `\`${escapeCodeV2(sym + ' ' + cur + ' ' + priceStr)}\`\n` +
                                        `*${escapeV2('Soglia:')}* \`${escapeCodeV2(cur + ' ' + stopStr)}\`\n\n` +
                                        `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
                                        
                            notifyUser(ua.user_id, 'SL', {
                                title: `⚠️ SL: ${asset.ticker}`,
                                body: `${priceStr} ${cur} (Soglia: ${stopStr})`,
                                telegramMessage: tgMsg,
                                ticker: asset.ticker,
                                data: { ticker: asset.ticker }
                            });
                        }
                    }

                    // 3. VOLATILITY ALERT
                    const userSettings = database.getSettings(ua.user_id);
                    const threshold = parseFloat(ua.volatilityAlert || userSettings.volatilityThreshold || 5);
                    const currentChange = Math.abs(updateData.change || 0);
                    
                    if (currentChange >= threshold) {
                        const existing = database.db.prepare(`
                            SELECT id FROM notifications 
                            WHERE ticker = ? AND user_id = ? AND type = 'VOL' AND date(date) = date('now')
                        `).get(asset.ticker, ua.user_id);
                        
                        if (!existing) {
                            const sym = asset.ticker.padEnd(8);
                            const cur = asset.currency === 'USD' ? '$' : '€';
                            const priceStr = newPrice.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            const changeSign = (updateData.change || 0) >= 0 ? '+' : '';
                            const changeStr = changeSign + (updateData.change || 0).toFixed(2) + '%';
                            const vIcon = (updateData.change || 0) >= 0 ? '📈' : '📉';
                            
                            const tgMsg = `${escapeV2('📊')} *${escapeV2('VOLATILITY ALERT')}*\n\n` +
                                        `${escapeV2(vIcon)} \`${escapeCodeV2(sym + ' ' + cur + ' ' + priceStr)}\`\n` +
                                        `*${escapeV2('Var.:')}* \`${escapeCodeV2(changeStr)}\` ${escapeV2('(Soglia: ' + threshold + '%)')}\n\n` +
                                        `${escapeV2('🕒')} \`${escapeCodeV2(tsFormatted)}\``;
                                        
                            notifyUser(ua.user_id, 'VOL', {
                                title: 'VOLATILITY ALERT 📊',
                                body: `${asset.ticker}: ${changeStr} (Soglia: ${threshold}%)`,
                                telegramMessage: tgMsg,
                                ticker: asset.ticker,
                                data: { ticker: asset.ticker }
                            });
                        }
                    }
                }
            }
        } catch (err) {
            if (err.message === 'YF_RATE_LIMIT') {
                logger.warn('Yahoo Finance API Rate Limit Reached. Suspending current update batch to avoid further blocks.');
                return; // BREAK the loop and stop the entire update batch
            }
            logger.error(`Failed to update ${asset.ticker}`, err);
            database.db.prepare(`UPDATE assets SET lastUpdateError=? WHERE ticker=?`).run(err.message, asset.ticker);
            // If it's a 404/Not Found on YF, mark as manual to stop hammering
            if (asset.dataSource === 'YF' && (err.message.includes('Not Found') || err.message.includes('404'))) {
                database.db.prepare(`UPDATE assets SET isManual=1 WHERE ticker=?`).run(asset.ticker);
            }
        }
    }
    const liveRate = await getEurUsdRate();
    await recalculateAllPortfoliosWithOverrides(liveRate);
    globalLastMarketUpdate = Date.now();
    logger.info(`Market data update cycle completed.`);
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
let lastUpdateTime = Date.now();
let lastBackupDate = ''; // 'YYYY-MM-DD'
let lastSnapshotDate = '';
try {
    const row = database.db.prepare('SELECT MAX(date) as lastDate FROM portfolio_history').get();
    if (row && row.lastDate) lastSnapshotDate = row.lastDate;
} catch (e) {
    logger.error('Failed to load lastSnapshotDate from DB', e);
}
let lastDailyReportDate = ''; // 'YYYY-MM-DD'
let lastTelegramStatusTime = 0;

// ─── News Sync Engine ───────────────────────────────────────────────────────────────────────
async function syncNews() {
    try {
        logger.info('Starting RSS News Sync...');
        
        const sources = database.db.prepare('SELECT * FROM news_sources WHERE is_enabled = 1').all();
        if (sources.length === 0) return;

        let totalSaved = 0;

        for (const source of sources) {
            try {
                const feed = await rssParser.parseURL(source.url);
                for (const item of feed.items || []) {
                    if (!item.title || !item.link) continue;
                    
                    const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
                    
                    const stmt = database.db.prepare(`
                        INSERT OR IGNORE INTO news_articles (user_id, title, link, pubDate, source_name)
                        VALUES (?, ?, ?, ?, ?)
                    `);
                    const info = stmt.run(source.user_id, item.title, item.link, pubDate, source.name);
                    if (info.changes > 0) totalSaved++;
                }
            } catch (err) {
                logger.error(`Failed to fetch RSS for ${source.url}: `, err);
            }
            
            // Keep only latest 50 articles per user
            database.db.prepare(`
                DELETE FROM news_articles 
                WHERE user_id = ? AND id NOT IN (
                    SELECT id FROM news_articles WHERE user_id = ? ORDER BY pubDate DESC LIMIT 50
                )
            `).run(source.user_id, source.user_id);
        }
        
        logger.info(`News Sync completed. Saved ${totalSaved} new articles.`);
    } catch (err) {
        logger.error('Error during news sync:', err);
    }
}

setInterval(() => {
    syncNews().catch(e => logger.error(e));
}, 1 * 60 * 60 * 1000); // 1 hour

setTimeout(syncNews, 5000); // Run first sync 5s after startup

setInterval(async () => {
    const settings = database.getSettings(1);
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const status = getMarketStatus();
    
    // 1. Market Data Update
    const freqMs = parseInt(settings.updateFrequency || 5) * 60 * 1000;
    if (freqMs > 0 && Date.now() - lastUpdateTime >= freqMs) {
        updateMarketData();
        lastUpdateTime = Date.now();
    }

    // 2. Multi-User Notifications (Status & Daily)
    const users = database.db.prepare('SELECT id FROM users').all();
    for (const u of users) {
        const uSettings = database.getSettings(u.id);
        const tgIntervalMin = parseInt(uSettings.marketStatusInterval || 60);
        const todayStr = now.toISOString().split('T')[0];
        
        // Status updates during market hours
        if (status.anyOpen && tgIntervalMin > 0) {
            const lastStatusKey = `last_status_time_${u.id}`;
            const lastValueKey = `last_status_value_${u.id}`;
            const lastStatusTime = global[lastStatusKey] || 0;
            const lastStatusValue = global[lastValueKey] || 0;
            const minVar = parseFloat(uSettings.marketStatusMinVariation || 0);

            if (Date.now() - lastStatusTime >= tgIntervalMin * 60 * 1000) {
                const stats = await calculateMarketStats(u.id);
                const currentVal = stats.totalNetValue || 0;

                // Send only if variation threshold is met (or if it's the first notification)
                if (lastStatusValue === 0 || Math.abs(currentVal - lastStatusValue) >= minVar) {
                    sendStatusNotification(u.id, 'STATUS', stats).catch(e => logger.error('Status notify failed', e));
                    global[lastStatusKey] = Date.now();
                    global[lastValueKey] = currentVal;
                }
            }
        }

        // Daily Summary at 22:15 CET
        const nowHour = now.getHours();
        const nowMin = now.getMinutes();
        if (nowHour === 22 && nowMin === 15) {
            const lastDailyKey = `last_daily_date_${u.id}`;
            if (global[lastDailyKey] !== todayStr) {
                sendStatusNotification(u.id, 'DAILY').catch(e => logger.error('Daily notify failed', e));
                global[lastDailyKey] = todayStr;
            }
        }
    }

    // 2. Scheduled Backups
    const backupFreq = settings.backupFrequency; // 'Daily', 'Weekly', 'None'
    
    if (backupFreq && backupFreq !== 'None' && lastBackupDate !== todayStr) {
        let shouldBackup = false;
        if (backupFreq === 'Daily') {
            shouldBackup = true;
        } else if (backupFreq === 'Weekly') {
            // Sunday backup
            if (now.getDay() === 0) shouldBackup = true;
        }

        if (shouldBackup) {
            logger.info(`Starting scheduled backup (${backupFreq})...`);
            try {
                await backupManager.createBackup(true);
                logger.info(`Scheduled backup completed successfully.`);
                lastBackupDate = todayStr;
            } catch (e) {
                logger.error('Scheduled backup failed', e);
            }
        }
    }
    // 3. Daily History Snapshots
    if (lastSnapshotDate !== todayStr) {
        logger.info(`Recording daily snapshots for portfolios and dashboard...`);
        try {
            const liveRate = await getEurUsdRate();
            const users = database.db.prepare(`SELECT id FROM users`).all();
            for (const u of users) {
                const userPortfolios = database.db.prepare(`SELECT portfolio_id as id FROM portfolio_users WHERE user_id = ?`).all(u.id);
                userPortfolios.forEach(p => database.savePortfolioSnapshot(p.id, liveRate, u.id));
                database.savePortfolioSnapshot(null, liveRate, u.id); // Global snapshot per user
            }
            lastSnapshotDate = todayStr;
            logger.info(`Daily snapshots completed.`);
        } catch (e) {
            logger.error('Daily snapshot failed', e);
        }
    }
}, 60_000);

// Run once at startup
updateMarketData();

// ─── Start ──────────────────────────────────────────────────────────────────

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`FolioTrack server running on port ${PORT}`);
        logger.info(`Database: ${require('./db').db.name}`);
        
        // Start Telegram command listener
        startTelegramPolling().catch(e => logger.error('Telegram polling failed at startup', e));
    });
}

module.exports = {
    app,
    calculatePerformanceHistory,
    updateMarketData,
    getEurUsdRate,
    syncNews,
    sendStatusNotification
};
