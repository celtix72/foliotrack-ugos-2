'use strict';

const express      = require('express');
const path         = require('path');
const dotenv       = require('dotenv');
const crypto       = require('crypto');
const YahooFinance = require('yahoo-finance2').default;
const axios        = require('axios');
const fs           = require('fs');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const webpush      = require('web-push');
const { xirr, calculateTWR } = require('./utils/finance');
const Parser = require('rss-parser');
const rssParser = new Parser();
const { callAIModel, parseAIResponse } = require('./services/aiService');
const { notifyUser } = require('./services/notificationService');


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

const { logger, telegramLogger, getLastLogLines, LOG_FILE, LOGS_DIR, TELEGRAM_LOG_FILE, getRotatedLogFile } = require('./utils/logger');

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


const { startTelegramPolling, sendTelegramMessage } = require('./services/telegramService');


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
const { getTransporter, resetTransporter } = require('./utils/mailer');
const { logAudit } = require('./utils/audit');

const app  = express();
const PORT = process.env.PORT || 3000;


// ─── JWT / Auth configuration ─────────────────────────────────────────────────
const { JWT_SECRET, JWT_COOKIE, JWT_EXPIRY } = require('./config');

app.set('trust proxy', 1);

// ─── Security Headers (Helmet) ───────────────────────────────────────────────
const { configureSecurity, authLimiter, registerLimiter } = require('./middlewares/securityMiddleware');

// ─── Security Setup ──────────────────────────────────────────────────────────
configureSecurity(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Auth Middleware ─────────────────────────────────────────────────────────
const { 
    requireAuth, 
    requireAdmin, 
    requirePortfolioAccess, 
    publicApiMiddleware 
} = require('./middlewares/authMiddleware');

app.use('/api', publicApiMiddleware);

// ─── Auth API Routes ─────────────────────────────────────────────────────────

// POST /api/auth/login
app.use('/api/auth', require('./routes/auth'));
app.use('/api/push', require('./routes/push'));
app.use('/api/notify', require('./routes/notify'));


// ─── Extracted Admin & Settings Routes ───────────────────────────────────────
app.use('/api/admin', require('./routes/admin')({
    requireAuth, requireAdmin, database, logger, APP_VERSION, LOG_FILE, LOGS_DIR, getRotatedLogFile, logAudit, getTransporter
}));

app.use('/api', require('./routes/settings')({
    requireAuth, requireAdmin, database, logger, resetTransporter
}));

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
let globalLastMarketUpdate = Date.now();


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

// ─── PORTFOLIOS API ──────────────────────────────────────────────────────────────

app.use('/api/portfolios', require('./routes/portfolios')({
    requireAuth,
    requirePortfolioAccess,
    database,
    logger,
    getAllPortfolioStats,
    getPortfolioDetails,
    calculatePerformanceHistory,
    getEurUsdRate,
    callAIModel,
    parseAIResponse,
    clearPerformanceCache: typeof clearPerformanceCache === 'function' ? clearPerformanceCache : () => {}
}));

// ─── Assets & Fundamentals Routes ────────────────────────────────────────────
app.use('/api', require('./routes/assets')({
    requireAuth, requireAdmin, requirePortfolioAccess, database, logger, yahooFinance,
    getEurUsdRate, getMarketStatus, isUSMarket, fetchAssetMetadata,
    clearPerformanceCache, callAIModel, parseAIResponse, notifyUser, APP_VERSION
}));

// ─── Market Routes ────────────────────────────────────────────────────────────
app.use('/api', require('./routes/market')({
    requireAuth, requireAdmin, database, logger, yahooFinance,
    getEurUsdRate, getMarketStatus, isUSMarket, fetchAssetMetadata,
    clearPerformanceCache, updateMarketData, syncNews,
    get eurUsdCache() { return eurUsdCache; },
    get globalLastMarketUpdate() { return globalLastMarketUpdate; },
    APP_VERSION
}));

// ─── Transactions Routes ──────────────────────────────────────────────────────
app.use('/api', require('./routes/transactions')({
    requireAuth, requireAdmin, requirePortfolioAccess, database, logger, yahooFinance,
    getEurUsdRate, fetchAssetMetadata, clearPerformanceCache, notifyUser,
    triggerHistoryRebuild, refreshDividendProjections, sanitizeTicker, APP_VERSION
}));

// ─── Dividends Routes ─────────────────────────────────────────────────────────
app.use('/api', require('./routes/dividends')({
    requireAuth, requirePortfolioAccess, database, logger, getEurUsdRate,
    refreshDividendProjections
}));

// ─── Watchlist Routes ─────────────────────────────────────────────────────────
app.use('/api', require('./routes/watchlist')({
    requireAuth, database, logger, yahooFinance, getMarketStatus, isUSMarket,
    fetchAssetMetadata, triggerHistoryRebuild, historicalPricesCache, watchlistPerformanceCache
}));




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


// --- Gemini Model Resolver ---
// Moved to src/services/aiService.js





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


app.get('/api/export-all-transactions', requireAuth, (req, res) => {
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






app.post('/api/admin/rebuild-history', requireAuth, requireAdmin, async (req, res) => {
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
// EXCHANGE RATE API
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

app.post('/api/telegram/send-report', requireAuth, async (req, res) => {
    try {
        await sendTelegramDailyReport();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ASSET SEARCH

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



app.get('/api/analytics/dividend-projections', requireAuth, async (req, res) => {
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

app.get('/api/logs', requireAuth, requireAdmin, (req, res) => {
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
app.get('/api/logs/dates', requireAuth, requireAdmin, (req, res) => {
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
app.post('/api/settings/telegram/test-tp', requireAuth, async (req, res) => {
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

app.post('/api/settings/telegram/test-sl', requireAuth, async (req, res) => {
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

app.post('/api/settings/telegram/test-volatility', requireAuth, async (req, res) => {
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

app.post('/api/settings/telegram/test-status', requireAuth, async (req, res) => {
    try {
        await sendMarketStatusTelegram();
        res.json({ success: true, message: 'Test Status sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/debug/telegram-market', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/api/logs/telegram', requireAuth, requireAdmin, (req, res) => {
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
