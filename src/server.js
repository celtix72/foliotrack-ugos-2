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
app.get('/api/asset-quotes/:ticker', requireAuth, (req, res) => {
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



app.post('/api/assets/manual-update', requireAuth, async (req, res) => {
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

app.post('/api/assets/toggle-manual', requireAuth, (req, res) => {
    const { ticker, isManual } = req.body;
    database.db.prepare(`UPDATE assets SET isManual = ? WHERE ticker = ?`).run(isManual ? 1 : 0, ticker);
    res.json({ success: true });
});

app.get('/api/assets/:id', requireAuth, (req, res) => {
    const row = database.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Asset not found');
    res.json(row);
});

// Borsa Italiana Debug Endpoint (admin only)
app.post('/api/debug/borsa-italiana', requireAuth, requireAdmin, async (req, res) => {
    const { isin, assetType } = req.body;
    if (!isin) return res.status(400).send('ISIN is required');
    const result = await B_ITA(isin, assetType);
    res.json(result);
});

// Import historical data (usually from frontend scraper)
app.post('/api/assets/import-history', requireAuth, (req, res) => {
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

app.get('/api/market/search', requireAuth, async (req, res) => {
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

app.get('/api/market/indices', requireAuth, async (req, res) => {
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

app.get('/api/assets/:ticker/history', requireAuth, async (req, res) => {
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

app.get('/api/assets/:ticker/details', requireAuth, async (req, res) => {
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

app.delete('/api/assets/:id', requireAuth, (req, res) => {
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
        let newsTitles = '';
        const tavilyKey = globalSettings.tavilyApiKey || process.env.TAVILY_API_KEY;
        if (tavilyKey) {
            sendEvent('progress', { message: 'Ricerca news recenti tramite Tavily...' });
            try {
                const tavilyRes = await axios.post('https://api.tavily.com/search', {
                    api_key: tavilyKey,
                    query: `${assetRow.ticker} ${assetRow.name} stock news latest analysis`,
                    search_depth: 'basic',
                    max_results: 5
                });
                if (tavilyRes.data && Array.isArray(tavilyRes.data.results)) {
                    newsTitles = tavilyRes.data.results.map(r => `${r.title}: ${r.content}`).join('\n');
                }
            } catch (err) {
                logger.error('[Tavily API Error]', err.message);
            }
        }
        
        if (!newsTitles) {
            sendEvent('progress', { message: 'Ricerca news recenti...' });
            const newsRes = await yahooFinance.search(ticker, { newsCount: 3 }).catch(() => ({}));
            newsTitles = (newsRes.news || []).map(n => n.title).join('; ');
        }
        
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





