'use strict';

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const dotenv     = require('dotenv');
const YahooFinance = require('yahoo-finance2').default;
const axios      = require('axios');
const fs         = require('fs');
const { xirr, calculateTWR } = require('./utils/finance');

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
        fs.appendFileSync(LOG_FILE, line); // keep master log too
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
        const errMsg = err ? ` - ${err.message || err}` : '';
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

dotenv.config();

const https = require('https');

// ─── Telegram Utility ────────────────────────────────────────────────────────
function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    // MarkdownV2 requires escaping these characters outside of pre/code spans
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    // Inside pre/code spans, only \ and ` need escaping
    return text.replace(/([\\`])/g, '\\$1');
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

async function sendTelegramMessage(message) {
    const settings = database.getSettings();
    const token = settings.telegramBotToken;
    const chatId = settings.telegramChatId;
    const enabled = settings.telegramEnabled === 'true';

    if (!enabled || !token || !chatId) return;

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
                try {
                    const parsed = JSON.parse(body);
                    if (parsed.ok) resolve(parsed);
                    else {
                        logger.error(`Telegram API error: ${parsed.description}`);
                        reject(new Error(parsed.description));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            logger.error(`Telegram request error: ${e.message}`);
            reject(e);
        });

        req.write(data);
        req.end();
    });
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

async function calculateMarketStats() {
    try {
        const liveRate = await getEurUsdRate();
        const stats = await getAllPortfolioStats(liveRate);
        const assets = database.db.prepare(`
            SELECT a.*, 
                   IFNULL(h.netQty, 0) as netQty
            FROM assets a
            LEFT JOIN (
                SELECT assetTicker, 
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as netQty 
                FROM transactions t
                GROUP BY assetTicker
            ) h ON a.ticker = h.assetTicker
            WHERE h.netQty > 0.001 OR a.inWatchlist = 1
        `).all();

        return {
            totalNetValue: stats.totalNetValue,
            totalChange: stats.totalChange,
            totalChangePercent: stats.changePercent,
            assets: assets.map(a => ({
                ticker: a.ticker,
                currentPrice: a.currentPrice,
                changePercent: a.changePercent,
                value: (a.currentPrice * a.netQty) / (a.currency === 'USD' ? liveRate : 1),
                inWatchlist: a.inWatchlist === 1
            }))
        };
    } catch (err) {
        logger.error('calculateMarketStats error', err);
        return { totalNetValue: 0, totalChange: 0, totalChangePercent: 0, assets: [] };
    }
}

async function sendMarketStatusTelegram() {
    const escape = escapeV2;
    const stats = await calculateMarketStats();
    
    let message = `📊 *STATO MERCATI*\n\n`;
    
    // Header
    const totalVal = stats.totalNetValue || 0;
    const totalChange = stats.totalChange || 0;
    const totalChangePct = stats.totalChangePercent || 0;
    const sign = totalChange >= 0 ? '+' : '';
    const emoji = totalChange >= 0 ? '🟢' : '🔴';

    message += `💰 *Valore Totale:* ${escape(totalVal.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}€\n`;
    message += `${emoji} *Variazione:* ${sign}${escape(totalChange.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}€ (${sign}${escape(totalChangePct.toFixed(2))}%) \n\n`;

    // Active Assets Section
    const activeAssets = stats.assets.filter(a => a.value > 10 || a.inWatchlist);
    if (activeAssets.length > 0) {
        message += `📈 *Top Asset:*\n`;
        activeAssets.sort((a,b) => b.value - a.value).slice(0, 8).forEach(a => {
            const aSign = a.changePercent >= 0 ? '+' : '';
            const aEmoji = a.changePercent >= 0 ? '🔼' : '🔽';
            const ticker = escape(a.ticker);
            const price = escape(a.currentPrice.toLocaleString('it-IT', { minimumFractionDigits: 2 }));
            const chg = escape(a.changePercent.toFixed(2));
            message += `${aEmoji} \`${ticker}\`: ${price} \\(${aSign}${chg}%\\)\n`;
        });
    }

    message += `\n🕒 _Aggiornato alle ${escape(new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))}_`;

    try {
        await sendTelegramMessage(message);
    } catch (err) {
        logger.error('sendMarketStatusTelegram failed', err);
    }
}

async function sendTelegramDailyReport() {
    await sendMarketStatusTelegram(); // Unify with the new requested format
}

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const database = require('./db');
const backupManager = require('./backup_manager');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
            dividendYield: quote.dividendYield || (summary.summaryDetail ? summary.summaryDetail.dividendYield : null),
            eps: quote.epsTrailingTwelveMonths || (summary.defaultKeyStatistics ? summary.defaultKeyStatistics.trailingEps : null),
            beta: quote.beta || (summary.summaryDetail ? summary.summaryDetail.beta : null),
            nextDividendDate: (summary.calendarEvents && summary.calendarEvents.exDividendDate) ? new Date(summary.calendarEvents.exDividendDate).toISOString().split('T')[0] : (quote.dividendDate ? new Date(quote.dividendDate * 1000).toISOString().split('T')[0] : null),
            quoteDate: quote.regularMarketTime ? new Date(quote.regularMarketTime).toISOString().split('T')[0] : null
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

    const status = {
        EU: milOpen || gerOpen,
        US: usOpen,
        isWeekend,
        anyOpen: milOpen || gerOpen || usOpen
    };

    return status;
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
    const searchUrl = `https://www.borsaitaliana.it/borsa/search/scheda.html?code=${isin}&lang=it`;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/120.0.0.0'
                },
                timeout: 20000 // Increased to 20s
            });
            const html = response.data;
            const finalUrl = response.request.res.responseUrl || searchUrl;

            // Scraping Logic using robust Regex
            let price = null;
            // Primary pattern: span with -formatPrice class
            const priceMatch = html.match(/-formatPrice\">\s*<strong>\s*([\d,.]+)\s*<\/strong>/i);
            if (priceMatch && priceMatch[1]) {
                price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
            } else {
                // Secondary fallback pattern
                const priceMatchAlt = html.match(/<strong>\s*([\d,.]+)\s*<\/span>\s*<\/strong>/i);
                if (priceMatchAlt && priceMatchAlt[1]) {
                    price = parseFloat(priceMatchAlt[1].replace(/\./g, '').replace(',', '.'));
                }
            }

            // Variation: look for percentage pattern specifically in the -percPrice span
            let variation = null;
            // Primary pattern for variation: span with -percPrice class
            const varMatch = html.match(/-percPrice\">\s*<strong>\s*([+-]?[\d,.]+)\s*%\s*<\/strong>/i);
            if (varMatch && varMatch[1]) {
                variation = parseFloat(varMatch[1].replace(',', '.'));
            } else {
                // Fallback for variation
                const varMatchAlt = html.match(/([+-]?[\d,.]+)\s*%\s*<\/span>/i);
                if (varMatchAlt && varMatchAlt[1]) {
                    variation = parseFloat(varMatchAlt[1].replace(',', '.'));
                }
            }

            if (!price && attempts < maxAttempts) {
                logger.warn(`B_ITA Scraper: No price found for ${isin} on attempt ${attempts}. Retrying...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            return { 
                success: !!price, 
                price, 
                variation, 
                url: finalUrl,
                isin
            };
        } catch (err) {
            if (attempts < maxAttempts) {
                logger.warn(`B_ITA Scraper attempt ${attempts} failed for ${isin}: ${err.message}. Retrying...`);
                await new Promise(r => setTimeout(r, 2000 * attempts));
                continue;
            }
            console.error(`B_ITA Scraper error for ${isin} after ${maxAttempts} attempts:`, err.message);
            return { success: false, error: err.message, url: searchUrl, isin };
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

app.get('/api/history', (req, res) => {
    const { portfolioId } = req.query;
    let query = `SELECT * FROM portfolio_history `;
    let params = [];
    if (portfolioId === 'null' || portfolioId === '') {
        query += `WHERE portfolioId IS NULL `;
    } else if (portfolioId) {
        query += `WHERE portfolioId = ? `;
        params.push(portfolioId);
    }
    query += `ORDER BY date DESC`;
    res.json(database.db.prepare(query).all(...params));
});

app.post('/api/history', (req, res) => {
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

app.delete('/api/history/:id', (req, res) => {
    database.db.prepare(`DELETE FROM portfolio_history WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});

// app.use(cors()); // Moved to top
// app.use(express.json()); // Moved to top
// app.use(express.urlencoded({ extended: true })); // Moved to top

// ════════════════════════════════════════════════════════════════════════════
// ASSETS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/assets', (req, res) => {
    // Return all assets except CASH, with a flag indicating if they have an active position
    const rows = database.db.prepare(`
        SELECT a.*, 
               CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition,
               IFNULL(t.balance, 0) as totalQuantity,
               IFNULL(t.totalCostAsset, 0) as totalCostAssetCurr
        FROM assets a
        LEFT JOIN (
            SELECT assetTicker, 
                   SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance,
                   SUM(CASE 
                        WHEN type = 'BUY' THEN (quantity * price + commission + tax)
                        WHEN type = 'SELL' THEN -(quantity * (SELECT AVG(price) FROM transactions t2 WHERE t2.assetTicker = transactions.assetTicker AND t2.type = 'BUY'))
                        ELSE 0 
                   END) as totalCostAsset
            FROM transactions 
            GROUP BY assetTicker
        ) t ON a.ticker = t.assetTicker
        WHERE a.ticker != 'CASH' AND (a.type != 'Cash' OR a.type IS NULL) 
        ORDER BY a.name ASC
    `).all();

    const today = new Date().toISOString().split('T')[0];

    // Add sparkline data (last 7 days from cache)
    const result = rows.map(a => {
        let sparkline = [];
        if (historicalPricesCache[a.ticker]) {
            const history = historicalPricesCache[a.ticker];
            const dates = Object.keys(history).sort();
            sparkline = dates.slice(-7).map(d => history[d]);
        }
        const isToday = a.quoteDate === today;
        return { 
            ...a, 
            sparkline,
            changePercent: isToday ? a.changePercent : 0,
            changeValue: isToday ? a.changeValue : 0
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
    database.recalculateAll(liveRate);
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

app.post('/api/assets', async (req, res) => {
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
                    isin:         isin || null
                };
            }
        }

        const existing = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(assetData.ticker);
        if (existing && assetData.ticker) return res.status(400).send('Asset already in monitoring list');

        database.db.prepare(`
            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, forwardPE, dividendYield, eps, beta, nextDividendDate, country, dataSource, isin, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            assetData.id, assetData.ticker, assetData.name, assetData.type,
            assetData.exchange, assetData.currency, assetData.currentPrice,
            assetData.changePercent, assetData.pe, assetData.forwardPE || null,
            assetData.dividendYield || null, assetData.eps || null, assetData.beta || null,
            assetData.nextDividendDate || null, assetData.country,
            assetData.dataSource || 'YF', assetData.isin || null
        );

        res.status(201).json(assetData);
    } catch (err) {
        console.error('Add asset error:', err);
        res.status(500).send('Failed to add asset: ' + err.message);
    }
});

app.put('/api/assets/:id', (req, res) => {
    const { targetPrice, stopLoss, isMonitored, dataSource, isin, name, type, exchange, currency, currentPrice, changePercent, pe } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (type !== undefined) { updates.push("type = ?"); params.push(type); }
    if (exchange !== undefined) { updates.push("exchange = ?"); params.push(exchange); }
    if (currency !== undefined) { updates.push("currency = ?"); params.push(currency); }
    if (currentPrice !== undefined) { updates.push("currentPrice = ?"); params.push(currentPrice); }
    if (changePercent !== undefined) { updates.push("changePercent = ?"); params.push(changePercent); }
    if (pe !== undefined) { updates.push("pe = ?"); params.push(pe); }
    if (targetPrice !== undefined) { updates.push("targetPrice = ?"); params.push(targetPrice); }
    if (req.body.targetPrice2 !== undefined) { updates.push("targetPrice2 = ?"); params.push(req.body.targetPrice2); }
    if (stopLoss !== undefined) { updates.push("stopLoss = ?"); params.push(stopLoss); }
    if (req.body.volatilityAlert !== undefined) { updates.push("volatilityAlert = ?"); params.push(req.body.volatilityAlert); }
    if (isMonitored !== undefined) { updates.push("isMonitored = ?"); params.push(isMonitored); }
    if (dataSource !== undefined) { updates.push("dataSource = ?"); params.push(dataSource); }
    if (isin !== undefined) { updates.push("isin = ?"); params.push(isin); }

    // Clear error if data source or ISIN is changed
    if (dataSource !== undefined || isin !== undefined) {
        updates.push("lastUpdateError = NULL");
        updates.push("updatedAt = datetime('now')");
    }

    if (updates.length > 0) {
        params.push(req.params.id);
        params.push(req.params.id);
        const sql = `UPDATE assets SET ${updates.join(', ')} WHERE id = ? OR ticker = ?`;
        database.db.prepare(sql).run(...params);
        
        // Auto-rebuild history if metadata changed (currency, ticker, etc.)
        triggerHistoryRebuild(null); 
    }
    res.json(database.db.prepare(`SELECT * FROM assets WHERE id = ? OR ticker = ?`).get(req.params.id, req.params.id));
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

app.get('/api/watchlist', (req, res) => {
    try {
        const rows = database.db.prepare(`
            SELECT a.*, 
                   CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition
            FROM assets a
            LEFT JOIN (
                SELECT assetTicker, 
                       SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
                FROM transactions 
                GROUP BY assetTicker
            ) t ON a.ticker = t.assetTicker
            WHERE (a.inWatchlist = 1 OR (a.isMonitored = 1 AND (t.balance IS NULL OR t.balance <= 0.0001)))
              AND a.ticker != 'CASH'
            ORDER BY a.ticker ASC
        `).all();
        
        const today = new Date().toISOString().split('T')[0];
        const result = rows.map(a => {
            let sparkline = [];
            if (historicalPricesCache[a.ticker]) {
                const history = historicalPricesCache[a.ticker];
                const dates = Object.keys(history).sort();
                sparkline = dates.slice(-7).map(d => history[d]);
            }
            const isToday = a.quoteDate === today;
            return { 
                ...a, 
                sparkline,
                changePercent: isToday ? (a.changePercent || 1) : 0,
                changeValue: isToday ? (a.changeValue || 0) : 0
            };
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/watchlist', async (req, res) => {
    const { ticker } = req.body;
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
                    INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, changeValue, pe, country, updatedAt, inWatchlist)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)
                `).run(
                    normalizedTicker,
                    normalizedTicker,
                    metadata.name,
                    metadata.type,
                    metadata.exchange,
                    metadata.currency,
                    metadata.currentPrice,
                    metadata.changePercent,
                    metadata.changeValue || 0,
                    metadata.pe,
                    metadata.country
                );
                asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
            } else {
                return res.status(404).send('Ticker not found on Yahoo Finance');
            }
        } else {
            // 3. Mark existing asset as inWatchlist
            database.db.prepare(`UPDATE assets SET inWatchlist = 1 WHERE ticker = ?`).run(normalizedTicker);
            asset.inWatchlist = 1;
        }

        res.json(asset);
        triggerHistoryRebuild(null);
    } catch (err) {
        console.error('Watchlist add error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/watchlist/:ticker', (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        // Do NOT touch isMonitored: assets in portfolio must keep receiving price updates.
        database.db.prepare(`UPDATE assets SET inWatchlist = 0 WHERE ticker = ?`).run(ticker);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/watchlist/performance', async (req, res) => {
    try {
        const now = Date.now();
        if (now - watchlistPerformanceCache.lastUpdated < WATCHLIST_PERF_CACHE_TTL) {
            return res.json(watchlistPerformanceCache.data);
        }

        const watchlist = database.db.prepare(`
            SELECT a.ticker 
            FROM assets a
            LEFT JOIN (
                SELECT assetTicker, 
                       SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
                FROM transactions 
                GROUP BY assetTicker
            ) t ON a.ticker = t.assetTicker
            WHERE (a.inWatchlist = 1 OR (a.isMonitored = 1 AND (t.balance IS NULL OR t.balance <= 0.0001)))
              AND a.ticker != 'CASH'
        `).all();
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

app.get('/api/assets/:ticker/details', async (req, res) => {
    const { ticker } = req.params;
    try {
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'calendarEvents', 'fundProfile']
        });
        res.json(summary);
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

// ─── NOTIFICATIONS API ──────────────────────────────────────────────────────

app.get('/api/notifications', (req, res) => {
    try {
        const rows = database.db.prepare(`
            SELECT * FROM notifications 
            ORDER BY date DESC 
            LIMIT 50
        `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/:id/read', (req, res) => {
    try {
        database.db.prepare(`UPDATE notifications SET isRead = 1 WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/read-all', (req, res) => {
    try {
        database.db.prepare(`UPDATE notifications SET isRead = 1`).run();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/notifications/:id', (req, res) => {
    try {
        database.db.prepare(`DELETE FROM notifications WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/notifications', (req, res) => {
    try {
        database.db.prepare(`DELETE FROM notifications`).run();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIOS API
// ════════════════════════════════════════════════════════════════════════════

async function getAllPortfolioStats(liveRate = null) {
    if (!liveRate) {
        liveRate = await getEurUsdRate();
    }
    database.recalculateAll(liveRate);
    const rows = database.db.prepare(`SELECT * FROM portfolios ORDER BY createdAt ASC`).all();
    
    // SINGLE SOURCE OF TRUTH: Use Performance Engine for all dashboard metrics
    const perfData = await calculatePerformanceHistory(null, 'ALL', false, true);
    const globalPoints = perfData.dataPoints || [];
    const individual = perfData.individual || {};

    let totalValueEUR = 0;
    let totalNetValueEUR = 0;
    let totalTaxEUR = 0;
    let globalChangeEUR = 0;

    const today = new Date();
    for (const p of rows) {
        const rate = p.currency === 'USD' ? liveRate : 1;
        
        p.changeValue = p.performance1D || 0;
        const prevValue = (p.totalValue || 0) - p.changeValue;
        p.changePercent = prevValue > 0 ? (p.changeValue / prevValue) * 100 : 0;

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

        globalChangeEUR += p.changeValue / rate;
        const details = await getPortfolioDetails(p.id, liveRate);
        p.roi = details.roi || 0;
        p.twr = details.twr || 0;
        p.xirr = details.xirr || 0;
        p.totalTax = details.totalLatentTax || 0;
        p.netValue = (p.totalValue || 0) - p.totalTax;
        
        totalValueEUR += (p.totalValue || 0) / rate;
        totalTaxEUR += p.totalTax / rate;
        totalNetValueEUR += p.netValue / rate;
    }

    const heldAssetsRaw = database.db.prepare(`
        SELECT a.ticker, a.name, a.changePercent, a.currentPrice, a.currency, a.quoteDate, h.netQty
        FROM assets a
        JOIN (
            SELECT assetTicker, 
                   SUM(CASE WHEN type = 'BUY' THEN quantity ELSE -quantity END) as netQty 
            FROM transactions 
            WHERE assetTicker IS NOT NULL AND assetTicker != 'CASH'
            GROUP BY assetTicker 
            HAVING netQty > 0.001
        ) h ON a.ticker = h.assetTicker
    `).all();

    const todayStr = new Date().toISOString().split('T')[0];
    const heldAssets = heldAssetsRaw.map(a => {
        const isToday = a.quoteDate === todayStr;
        const changePct = isToday ? (a.changePercent || 0) : 0;
        const rate = (a.currency === 'USD') ? liveRate : 1;
        const absChange = (a.currentPrice * changePct / 100) * a.netQty / rate;
        return { ticker: a.ticker, name: a.name, changePercent: changePct, absChange };
    }).sort((a,b) => b.changePercent - a.changePercent);

    const lastPoint = globalPoints.at(-1) || { value: 0, profit: 0, netDeposits: 0 };

    return {
        portfolios: rows,
        totalValue: totalValueEUR,
        totalNetValue: totalNetValueEUR,
        totalTax: totalTaxEUR,
        totalChange: globalChangeEUR,
        totalGain: lastPoint.profit || 0,
        investedCapital: totalNetValueEUR - (lastPoint.profit || 0),
        changePercent: (totalValueEUR - globalChangeEUR) > 0 ? (globalChangeEUR / (totalValueEUR - globalChangeEUR)) * 100 : 0,
        topWinners: heldAssets.slice(0, 2),
        topLosers: heldAssets.slice(-2).reverse()
    };
}

app.get('/api/portfolios', async (req, res) => {
    try {
        const stats = await getAllPortfolioStats();
        res.json({
            portfolios: stats.portfolios,
            global: {
                totalValue: stats.totalValue,
                totalNetValue: stats.totalNetValue,
                totalTax: stats.totalTax,
                totalGain: stats.totalGain,
                investedCapital: stats.investedCapital,
                changeValue: stats.totalChange,
                changePercent: stats.changePercent,
                topWinners: stats.topWinners,
                topLosers: stats.topLosers
            }
        });
    } catch (err) {
        console.error('API Error /api/portfolios:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper to calculate holdings for a portfolio
/**
 * Helper to calculate ALL details for a portfolio (holdings, taxes, allocation, dividends, etc.)
 * This is the SINGLE SOURCE OF TRUTH for portfolio content.
 */
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
                stopLoss: asset ? asset.stopLoss : 0
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

app.get('/api/portfolios/:id', async (req, res) => {
    try {
        const data = await getPortfolioDetails(req.params.id);
        res.json(data);
    } catch (err) {
        res.status(err.message === 'Portfolio non trovato' ? 404 : 500).json({ error: err.message });
    }
});

app.get('/api/analytics/global-allocation', async (req, res) => {
    try {
        const portfolios = database.db.prepare('SELECT id FROM portfolios').all();
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
                percent: totalGrossValue > 0 ? Math.round((value / totalGrossValue) * 1000) / 10 : 0
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


app.post('/api/portfolios', (req, res) => {
    console.log('POST /api/portfolios:', req.body);
    const { name, type, currency, startDate, initialCash, color, losses } = req.body;

    if (!name) return res.status(400).json({ error: 'Portfolio name is required' });

    const cash  = parseFloat(initialCash || 0);
    const start = startDate || new Date().toISOString().split('T')[0];
    const pColor = color || '#6366f1';

    const result = database.db.prepare(`
        INSERT INTO portfolios (name, type, currency, startDate, initialCash, currentCash, totalValue, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type || 'Investimento', currency || 'EUR', start, cash, cash, cash, pColor);

    const portfolioId = result.lastInsertRowid;
    triggerHistoryRebuild(portfolioId);
    
    // Handle initial losses if provided
    if (losses && typeof losses === 'object') {
        const stmt = database.db.prepare(`INSERT OR REPLACE INTO portfolio_losses (portfolioId, asset_type, amount) VALUES (?, ?, ?)`);
        for (const [type, amount] of Object.entries(losses)) {
            stmt.run(portfolioId, type, parseFloat(amount) || 0);
        }
    }

    const created = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    console.log('Created portfolio:', created);
    clearPerformanceCache();
    res.status(201).json(created);
});

app.put('/api/portfolios/:id', async (req, res) => {
    const existing = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Portfolio not found');

    const { name, type, currency, startDate, initialCash, color, losses } = req.body;
    database.db.prepare(`
        UPDATE portfolios SET name=?, type=?, currency=?, startDate=?, initialCash=?, color=? WHERE id=?
    `).run(
        name       || existing.name,
        type       || existing.type || 'Investimento',
        currency   || existing.currency,
        startDate  || existing.startDate,
        parseFloat(initialCash != null ? initialCash : existing.initialCash),
        color      || existing.color || '#6366f1',
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

app.delete('/api/portfolios/:id', (req, res) => {
    const row = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Portfolio not found');
    // ON DELETE CASCADE removes transactions automatically
    database.db.prepare(`DELETE FROM portfolios WHERE id = ?`).run(req.params.id);
    console.log(`Deleted portfolio ${req.params.id}`);
    
    // Trigger global rebuild to update aggregate charts
    triggerHistoryRebuild(null);
    
    clearPerformanceCache();
    res.json(row);
});

app.post('/api/portfolios/:id/reconcile', async (req, res) => {
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
            // true for forceRefresh and true for includeIndividual
            const perfData = await calculatePerformanceHistory(p.id, 'ALL', true, true);
            const dataPoints = perfData.dataPoints || [];
            const insert = database.db.prepare(`
                INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            database.db.transaction(() => {
                for (const pt of dataPoints) {
                    insert.run(p.id, pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                }
            })();
        }
        
        logger.info('Rebuilding performance history: Step 4/4 - Recalculating Global...');
        const globalPoints = await calculatePerformanceHistory(null, 'ALL', true);
        const insertGlobal = database.db.prepare(`
            INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
            VALUES (NULL, ?, ?, ?, ?, ?)
        `);
        
        database.db.transaction(() => {
            for (const pt of globalPoints) {
                insertGlobal.run(pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
            }
        })();

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

app.get('/api/transactions', (req, res) => {
    const { portfolioId, assetTicker } = req.query;
    let query = `SELECT * FROM transactions WHERE 1=1 `;
    let params = [];
    
    if (portfolioId) {
        query += `AND portfolioId = ? `;
        params.push(portfolioId);
    }
    if (assetTicker) {
        query += `AND assetTicker = ? `;
        params.push(assetTicker);
    }
    
    query += `ORDER BY date ASC`;
    res.json(database.db.prepare(query).all(...params));
});

app.post('/api/transactions', async (req, res) => {
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
                isin || null
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
    refreshDividendProjections().catch(e => logger.error("Background Dividend Refresh Error:", e));

    res.status(201).json(database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(result.lastInsertRowid));
});

app.delete('/api/transactions/:id', async (req, res) => {
    const row = database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Transaction not found');
    
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
    refreshDividendProjections().catch(e => logger.error("Background Dividend Refresh Error:", e));

    res.json(row);
});

app.put('/api/transactions/:id', async (req, res) => {
    const { type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount } = req.body;
    const existing = database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Transaction not found');

    database.db.prepare(`
        UPDATE transactions 
        SET type = ?, assetTicker = ?, date = ?, quantity = ?, price = ?, commission = ?, tax = ?, exchangeRate = ?, amount = ?
        WHERE id = ?
    `).run(
        type || existing.type,
        sanitizeTicker(assetTicker) || existing.assetTicker,
        date || existing.date,
        parseFloat(quantity || 0),
        parseFloat(price || 0),
        parseFloat(commission || 0),
        parseFloat(tax || 0),
        parseFloat(exchangeRate || 1),
        parseFloat(amount || 0),
        req.params.id
    );

    database.recalculatePortfolio(existing.portfolioId);
    clearPerformanceCache();

    // Auto-rebuild history for this portfolio
    triggerHistoryRebuild(existing.portfolioId);

    // Auto-refresh dividend projections (non-blocking)
    refreshDividendProjections().catch(e => logger.error("Background Dividend Refresh Error:", e));

    res.json({ success: true });
});

// Get market movers (assets with today's quotes, sorted by % change)
app.get('/api/market/movers', async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        // Only return assets that have open positions (assetCount from portfolios or based on transactions)
        // or just all monitored assets that updated today. 
        // User requested: "riporta solo gli ASSET che hanno posizioni aperte"
        
        const rows = database.db.prepare(`
            SELECT a.* 
            FROM assets a
            JOIN (
                SELECT assetTicker, 
                       SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance 
                FROM transactions 
                GROUP BY assetTicker 
                HAVING balance > 0.0001
            ) t ON a.ticker = t.assetTicker
            WHERE a.quoteDate = ?
            ORDER BY ABS(a.changePercent) DESC
            LIMIT 10
        `).all(todayStr);

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
                                INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, forwardPE, dividendYield, eps, beta, nextDividendDate, country, isManual, dataSource, isin, updatedAt)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
                                null, null, null, null, null, // forwardPE, dividendYield, eps, beta, nextDividendDate
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
app.get('/api/tax-rates', (req, res) => {
    try {
        const rates = database.db.prepare(`SELECT * FROM tax_rates ORDER BY asset_type ASC`).all();
        res.json(rates);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tax-rates', (req, res) => {
    try {
        const { rates } = req.body;
        if (!Array.isArray(rates)) return res.status(400).json({ error: 'Formato non valido' });
        
        database.db.transaction(() => {
            database.db.prepare(`DELETE FROM tax_rates`).run();
            const stmt = database.db.prepare(`INSERT INTO tax_rates (asset_type, rate) VALUES (?, ?)`);
            for (const r of rates) if (r.asset_type) stmt.run(r.asset_type, parseFloat(r.rate) || 0);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', (req, res) => {
    res.json(database.getSettings());
});

app.put('/api/settings', (req, res) => {
    for (const [key, value] of Object.entries(req.body)) {
        database.setSetting(key, value);
    }
    res.json(database.getSettings());
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
        res.status(500).send('Search failed');
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
async function calculatePerformanceHistory(portfolioIds, range = '1Y', forceRefresh = false, includeIndividual = false) {
    const pIdsInput = portfolioIds === null ? null : (Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds]);
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const rangeKey = range || 'ALL';
    const cacheKey = `history_${pIdsInput ? pIdsInput.sort().join(',') : 'global'}_${rangeKey}_${includeIndividual}`;

    // 1. Check Cache (1 minute TTL for dashboard-level history)
    const CACHE_SHORT_TTL = 60 * 1000; 
    if (!forceRefresh && performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < CACHE_SHORT_TTL)) {
        return performanceResultsCache[cacheKey].data;
    }

    const isGlobal = !pIdsInput || pIdsInput.length === 0;
    const portfolios = isGlobal 
        ? database.db.prepare('SELECT * FROM portfolios').all()
        : database.db.prepare(`SELECT * FROM portfolios WHERE id IN (${pIdsInput.join(',')})`).all();

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
    const watchlistTickers = isGlobal 
        ? database.db.prepare('SELECT ticker FROM assets WHERE inWatchlist = 1').all().map(a => a.ticker)
        : [];
    const rawTickers = [...new Set([...portfolioTickers, ...watchlistTickers].filter(t => t && t !== 'CASH'))];
    
    logger.info(`Performance history sync: processing ${rawTickers.length} tickers (Portfolios: ${portfolioTickers.length}, Watchlist: ${watchlistTickers.length})`);

    if (portfolios.length === 0 && watchlistTickers.length === 0) {
        return includeIndividual ? { dataPoints: [], individual: {} } : [];
    }

    const hasNonEur = isGlobal || portfolios.some(p => p.currency !== 'EUR') || rawTickers.some(t => assetMetadataCache[t]?.currency === 'USD');
    const uniqueTickers = [...rawTickers];
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

    const dataPoints = [];
    let currentDate = new Date(startDate);

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

    const formatDate = (date) => {
        const d = new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

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
                    pAssets += shares * (price / rate);
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

                dayValue += pValue;
                dayProfit += pProfit;
                dayCash += pCash;
                dayAssets += pAssetsVal;
                dayNetDeposits += (portfolioStates[p.id].netDeposits / (p.currency === 'USD' ? (fxRates['USD']?.[dateStr] || 1) : 1));

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
            events: dayEvents
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

                const perfData = await calculatePerformanceHistory(p.id, 'ALL', true, true);
                const dataPoints = perfData.dataPoints || [];
                const insert = database.db.prepare(`
                    INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                
                database.db.transaction(() => {
                    for (const pt of dataPoints) {
                        insert.run(p.id, pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                    }
                })();
            }

            // Always rebuild global to keep it in sync
            const perfDataGlobal = await calculatePerformanceHistory(null, 'ALL', true);
            const globalPoints = Array.isArray(perfDataGlobal) ? perfDataGlobal : (perfDataGlobal.dataPoints || []);
            const insertGlobal = database.db.prepare(`
                INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
                VALUES (NULL, ?, ?, ?, ?, ?)
            `);
            
            database.db.transaction(() => {
                for (const pt of globalPoints) {
                    insertGlobal.run(pt.date, pt.value, pt.cash || 0, pt.assets || 0, pt.netDeposits || 0);
                }
            })();

            // Clear cache to ensure charts refresh with new historical points
            clearPerformanceCache();

            logger.info(`Background history rebuild completed for ${portfolioId ? 'portfolio ' + portfolioId : 'ALL'}`);
        } catch (err) {
            logger.error(`Failed background history rebuild for ${portfolioId || 'ALL'}`, err);
        }
    });
}

// ─── ANALYTICS ENDPOINTS ──────────────────────────────────────────────────────

app.get('/api/analytics/portfolio-performance/:id', async (req, res) => {
    try {
        const { range } = req.query;
        const portfolioId = req.params.id;
        const cacheKey = `portfolio_perf_${portfolioId}_${range || 'ALL'}`;

        if (performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < CACHE_TTL)) {
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

app.get('/api/analytics/global-performance', async (req, res) => {
    try {
        const { range } = req.query;
        const cacheKey = `global_perf_${range || 'ALL'}`;

        if (performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < CACHE_TTL)) {
            return res.json(performanceResultsCache[cacheKey].data);
        }

        const dataPoints = await calculatePerformanceHistory(null, range);

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

// ─── HISTORY ENDPOINT ──────────────────────────────────────────────────────────


app.get('/api/analytics/history', (req, res) => {
    try {
        const portfolios = database.db.prepare('SELECT id, name, currency FROM portfolios').all();
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

        // Sort by year desc, then realized gain desc
        allClosed.sort((a, b) => b.year - a.year || b.realizedGain - a.realizedGain);
        res.json(allClosed);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/dividends', (req, res) => {
    try {
        const portfolios = database.db.prepare('SELECT id, name, currency FROM portfolios').all();
        let allDividends = [];

        for (const p of portfolios) {
            const divs = database.db.prepare("SELECT * FROM transactions WHERE portfolioId = ? AND type = 'DIVIDEND'").all(p.id);
            allDividends = allDividends.concat(divs.map(d => ({
                ...d,
                portfolioName: p.name
            })));
        }
        // Return flat list for frontend to group/sort
        res.json(allDividends);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dividends/manual-projections', (req, res) => {
    try {
        const data = database.db.prepare(`SELECT m.*, a.name FROM manual_dividend_projections m JOIN assets a ON m.ticker = a.ticker ORDER BY exDate ASC`).all();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/dividends/projections', (req, res) => {
    try {
        const { ticker, exDate, amount } = req.body;
        if (!ticker || !exDate || !amount) return res.status(400).json({ error: 'Missing fields' });
        const year = parseInt(exDate.substring(0, 4));
        database.db.prepare(`
            INSERT INTO dividend_projections (ticker, name, exDate, amount, totalAmount, yield, tag, year, isCustom)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(ticker, null, exDate, parseFloat(amount), parseFloat(amount), 0, 'MANUALE', year);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/dividends/projections/:id', (req, res) => {
    try {
        const { exDate, amount } = req.body;
        const year = parseInt(exDate.substring(0, 4));
        database.db.prepare(`
            UPDATE dividend_projections 
            SET exDate = ?, amount = ?, totalAmount = ?, year = ?, tag = 'MANUALE', isCustom = 1
            WHERE id = ?
        `).run(exDate, parseFloat(amount), parseFloat(amount), year, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dividends/projections/:id', (req, res) => {
    try {
        database.db.prepare(`DELETE FROM dividend_projections WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dividends/projections/:id/confirm', async (req, res) => {
    try {
        const { portfolioId, ticker, amount, date } = req.body;
        if (!portfolioId || !ticker || !amount || !date) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        
        database.db.prepare(`
            INSERT INTO transactions (portfolioId, type, assetTicker, date, amount, quantity, price, commission, tax, exchangeRate)
            VALUES (?, 'DIVIDEND', ?, ?, ?, 0, 0, 0, 0, 1)
        `).run(portfolioId, ticker, date, parseFloat(amount));
        
        database.db.prepare(`DELETE FROM dividend_projections WHERE id = ?`).run(req.params.id);
        database.recalculatePortfolio(portfolioId);
        
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Core function to recalculate and refresh dividend projections in the database.
 * This can be called manually or automatically after transactions (BUY/SELL).
 */
async function refreshDividendProjections() {
    try {
        const now = new Date();
        const currentYear = now.getFullYear();
        const lastYear = currentYear - 1;
        const liveRate = await getEurUsdRate();
        const BOND_TYPES = ['Bond', 'ETF Obblig', 'Deposito Vincolato', 'ETF Monetario'];

        // Get open positions (only assets currently held)
        const openPositions = database.db.prepare(`
            SELECT * FROM (
                SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                       SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance,
                       a.type as assetType,
                       a.currency as currency,
                       COALESCE(a.name, 'N/A') as name
                FROM transactions t
                LEFT JOIN assets a ON t.assetTicker = a.ticker
                GROUP BY ticker
            )
            WHERE balance > 0.0001
        `).all();

        const allDivTx = database.db.prepare(`
            SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker, t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
            FROM transactions t JOIN portfolios p ON t.portfolioId = p.id WHERE t.type = 'DIVIDEND'
        `).all();

        const toEUR = (amount, currency, exchangeRate) => {
            if (currency === 'USD' && liveRate > 0) return amount / liveRate;
            if (exchangeRate && exchangeRate !== 1) return amount / exchangeRate;
            return amount;
        };

        const newProjections = [];

        const projectionPromises = openPositions.map(async (pos) => {
            const ticker = pos.ticker;
            const isBond = BOND_TYPES.includes(pos.assetType) || ticker.startsWith('CD_') || ticker === 'Sconosciuto';
            
            if (isBond) {
                const lastYearDivs = allDivTx.filter(d => d.ticker === ticker && d.date.startsWith(lastYear.toString()));
                lastYearDivs.forEach(d => {
                    const newDate = `${currentYear}-${d.date.substring(5)}`;
                    if (newDate > now.toISOString().split('T')[0]) {
                        const amtEUR = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
                        newProjections.push({ ticker, name: pos.name, date: newDate, tag: 'STORICO', amount: 0, totalAmount: amtEUR, yield: 0 });
                    }
                });
            } else if (ticker && !ticker.startsWith('CD_') && ticker !== 'Sconosciuto') {
                try {
                    const summary = await yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'calendarEvents'] }).catch(() => null);
                    if (summary && summary.summaryDetail && summary.summaryDetail.dividendRate > 0) {
                        const annualRate = summary.summaryDetail.dividendRate;
                        const assetYield = summary.summaryDetail.dividendYield || 0;
                        const freq = summary.summaryDetail.dividendFrequency || 4;
                        const currencyYF = summary.summaryDetail.currency || pos.currency;
                        
                        let nextDateStr = null;
                        const ce = summary.calendarEvents || {};
                        const dDate = ce.dividendDate || ce.exDividendDate;
                        
                        if (dDate) {
                            nextDateStr = new Date(dDate).toISOString().split('T')[0];
                        }
                        
                        if (nextDateStr && nextDateStr >= now.toISOString().split('T')[0]) {
                            const perPayment = (annualRate * pos.balance) / freq;
                            const amtEUR = toEUR(perPayment, currencyYF, null);
                            const unitAmount = toEUR(annualRate / freq, currencyYF, null);
                            newProjections.push({ ticker, name: pos.name, date: nextDateStr, tag: 'YF', amount: unitAmount, totalAmount: amtEUR, yield: assetYield });
                        } else if (annualRate > 0) {
                            const histLastYear = allDivTx.filter(d => d.ticker === ticker && d.date.startsWith(lastYear.toString()));
                            if (histLastYear.length > 0) {
                                const months = [...new Set(histLastYear.map(d => d.date.substring(5, 7)))];
                                months.forEach(m => {
                                    const nextDate = `${currentYear}-${m}-20`;
                                    if (nextDate > now.toISOString().split('T')[0]) {
                                        const perPayment = (annualRate * pos.balance) / months.length;
                                        const amtEUR = toEUR(perPayment, currencyYF, null);
                                        const unitAmount = toEUR(annualRate / months.length, currencyYF, null);
                                        newProjections.push({ ticker, name: pos.name, date: nextDate, tag: 'SIMULATO', amount: unitAmount, totalAmount: amtEUR, yield: assetYield });
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
            database.db.prepare(`DELETE FROM dividend_projections WHERE tag != 'MANUALE' AND year = ?`).run(currentYear);
            const insert = database.db.prepare(`
                INSERT INTO dividend_projections (ticker, name, exDate, amount, totalAmount, yield, tag, year)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const p of projs) {
                insert.run(p.ticker, p.name, p.date, p.amount, p.totalAmount, p.yield, p.tag, currentYear);
            }
        });
        tx(newProjections);
        return newProjections.length;
    } catch (err) {
        logger.error('refreshDividendProjections error', err);
        throw err;
    }
}

app.post('/api/dividends/projections/reset', async (req, res) => {
    try {
        const count = await refreshDividendProjections();
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
                   a.name as name
            FROM transactions t LEFT JOIN assets a ON t.assetTicker = a.ticker
            GROUP BY ticker HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) > 0.0001
        `).all();

        const allDivTx = database.db.prepare(`
            SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker, t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
            FROM transactions t JOIN portfolios p ON t.portfolioId = p.id WHERE t.type = 'DIVIDEND' AND t.date LIKE ?
        `).all(currentYear + '-%');

        const savedProjections = database.db.prepare(`SELECT * FROM dividend_projections WHERE year = ?`).all(currentYear);

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
            
            listItems.push({
                id: null, ticker: d.ticker, name: pos.name, date: d.date, tag: 'REGISTRATO',
                amount: null, totalAmount: amtEUR, annualProjected: 0, yield: 0
            });
        });

        // Projected
        savedProjections.forEach(p => {
            const m = parseInt(p.exDate.split('-')[1]) - 1;
            const amtEUR = p.totalAmount;
            projectedByMonth[m] += amtEUR;
            totalExpected += amtEUR;
            tickersByMonth[m].add(p.ticker);
            listItems.push({
                id: p.id, ticker: p.ticker, name: p.name, date: p.exDate, tag: p.tag,
                amount: p.amount, totalAmount: amtEUR, annualProjected: 0, yield: p.yield, isCustom: p.isCustom
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
app.get('/api/analytics/current-month-dividends', async (req, res) => {
    try {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const monthStr = currentMonth.toString().padStart(2, '0');
        const yearMonth = `${currentYear}-${monthStr}`;

        // Get projected dividends for this month
        const projections = database.db.prepare(`
            SELECT SUM(totalAmount) as total, COUNT(*) as count 
            FROM dividend_projections 
            WHERE exDate LIKE ?
        `).get(yearMonth + '%');

        // Get already received dividends for this month from transactions
        const received = database.db.prepare(`
            SELECT SUM(amount) as total, COUNT(*) as count 
            FROM transactions 
            WHERE type = 'DIVIDEND' AND date LIKE ?
        `).get(yearMonth + '%');

        const totalAmount = (projections.total || 0) + (received.total || 0);
        const totalCount = (projections.count || 0) + (received.count || 0);

        const MONTH_NAMES_LONG = [
            'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
            'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
        ];

        res.json({
            monthName: MONTH_NAMES_LONG[currentMonth - 1],
            year: currentYear,
            count: totalCount,
            amount: totalAmount,
            hasDividends: totalCount > 0
        });
    } catch (err) {
        logger.error('Current month dividends error', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/reports', async (req, res) => {
    try {
        const portfolios = database.db.prepare('SELECT * FROM portfolios').all();
        if (portfolios.length === 0) return res.json({ error: 'No portfolios found' });

        const allTransactions = database.db.prepare('SELECT * FROM transactions ORDER BY date ASC').all();
        const assets = database.db.prepare('SELECT * FROM assets').all();
        const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

        const today = new Date();
        const range = req.query.range || '1Y'; // Default to 1 Year

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

        const portfolioData = await calculatePerformanceHistory(null, range, false, true);
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

        // 2. Diversification
        const diversification = {
            geography: {},
            assetType: {}
        };

        for (const p of portfolios) {
            const holdings = {};
            const pTxs = allTransactions.filter(t => t.portfolioId === p.id);
            for (const t of pTxs) {
                if (t.type === 'BUY') holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + t.quantity;
                if (t.type === 'SELL') holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - t.quantity;
            }
            for (const [ticker, shares] of Object.entries(holdings)) {
                if (shares <= 0.0001) continue;
                const a = assetMap[ticker];
                if (!a) continue;
                const value = shares * (a.currentPrice / (pTxs.filter(tx => tx.assetTicker === ticker && tx.exchangeRate).at(-1)?.exchangeRate || 1));

                const geo = a.country || 'Unknown';
                const type = a.type || 'Other';
                diversification.geography[geo] = (diversification.geography[geo] || 0) + value;
                diversification.assetType[type] = (diversification.assetType[type] || 0) + value;
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

app.get('/api/backups', (req, res) => {
    res.json(backupManager.listBackups());
});

app.post('/api/backups/manual', async (req, res) => {
    try {
        const metadata = await backupManager.createBackup(false);
        res.json(metadata);
    } catch (err) {
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

app.get('/api/market/movers', (req, res) => {
    try {
        // Get assets with non-zero price, ordered by absolute change percent
        // We filter out CASH and assets without a price.
        const rows = database.db.prepare(`
            SELECT DISTINCT a.* FROM assets a
            WHERE a.ticker != 'CASH' 
            AND a.currentPrice > 0
            ORDER BY ABS(a.changePercent) DESC
            LIMIT 10
        `).all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// ─── Telegram Test Endpoints ────────────────────────────────────────────────
app.post('/api/settings/telegram/test-tp', async (req, res) => {
    try {
        const msg = `🎯 *TARGET RAGGIUNTO TEST*\n\n*Titolo:* AAPL\n*Prezzo Attuale:* 190.50\n*Target:* 190.00`;
        await sendTelegramMessage(escapeV2(msg));
        res.json({ success: true, message: 'Test TP sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/telegram/test-sl', async (req, res) => {
    try {
        const msg = `⚠️ *STOP LOSS TEST*\n\n*Titolo:* TSLA\n*Prezzo Attuale:* 165.20\n*Soglia SL:* 170.00`;
        await sendTelegramMessage(escapeV2(msg));
        res.json({ success: true, message: 'Test SL sent' });
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
        const settings = database.getSettings();
        if (settings.telegramEnabled !== 'true') {
            return res.json({ success: false, error: 'Telegram is globally disabled in settings.' });
        }
        await sendMarketStatusTelegram();
        res.json({ success: true, message: 'Notification triggered. Check your Telegram chat.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/backups/restore', async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).send('Filename required');
        
        // This will restart the app
        await backupManager.restoreBackup(filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/backups/:filename', (req, res) => {
    try {
        backupManager.deleteBackup(req.params.filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// RESET DATA
// ════════════════════════════════════════════════════════════════════════════

// ══ PURGE PERFORMANCE HISTORY ONLY ══
app.post('/api/admin/purge-performance', (req, res) => {
    const tables = ['portfolio_history', 'portfolio_losses', 'asset_quotes'];
    for (const table of tables) {
        try { database.db.prepare(`DELETE FROM ${table}`).run(); } catch (e) {}
    }
    logger.info('Performance history purged.');
    clearPerformanceCache();
    res.json({ success: true, message: 'Performance history purged. Portfolios and transactions were kept.' });
});

// ══ FULL APPLICATION RESET ══
app.post('/api/reset-data', (req, res) => {
    logger.info('Initiating full application data reset...');
    
    // 1. Clear ALL tables in correct dependency order (transactions first due to FK)
    const tables = [
        'notifications', 'portfolio_history', 'portfolio_losses', 'asset_quotes', 
        'dividend_projections', 'transactions', 'portfolios', 'assets', 
        'tax_rates', 'settings', 'test'
    ];
    
    try {
        database.db.transaction(() => {
            for (const table of tables) {
                try {
                    database.db.prepare(`DELETE FROM ${table}`).run();
                } catch (err) {
                    logger.warn(`Skip table ${table} during reset: ${err.message}`);
                }
            }
        })();

        // 2. Re-initialize default settings and tax rates
        database.initDb();
        
        // 3. FORCE-CLEAR ALL MEMORY CACHES
        clearPerformanceCache();
        lastUpdateTime = 0; // Force immediate update of new assets (if any)
        
        logger.info('FULL RESET COMPLETED: All data wiped and re-initialized.');
        res.json({ success: true, message: 'Application has been fully reset to factory defaults.' });
    } catch (err) {
        logger.error('CRITICAL ERROR DURING FULL RESET:', err);
        res.status(500).json({ error: 'Full reset failed: ' + err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// NEWS API ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/news', (req, res) => {
    try {
        const settings = database.getSettings();
        let disabledSources = [];
        try { disabledSources = JSON.parse(settings.disabledNewsSources || '[]'); } catch (e) {}

        const placeholders = disabledSources.map(() => '?').join(',');
        const query = disabledSources.length > 0
            ? `SELECT * FROM global_news WHERE publisher NOT IN (${placeholders}) ORDER BY publishedAt DESC LIMIT 20`
            : `SELECT * FROM global_news ORDER BY publishedAt DESC LIMIT 20`;
            
        const rows = database.db.prepare(query).all(...disabledSources);
        res.json(rows);
    } catch (err) {
        logger.error('/api/news error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/news/sources', (req, res) => {
    try {
        const settings = database.getSettings();
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

// ─── HTML page routes ───────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    const file = isMobile(req) ? 'dashboard_mobile.html' : 'dashboard.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/portfolio', (req, res) => {
    const file = isMobile(req) ? 'portfolio_detail_mobile.html' : 'portfolio_detail.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/market', (req, res) => {
    const file = isMobile(req) ? 'market_mobile.html' : 'market_overview.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/reports', (req, res) => {
    const file = isMobile(req) ? 'reports_mobile.html' : 'reports.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/history', (req, res) => {
    const file = isMobile(req) ? 'history_mobile.html' : 'history.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/dividend', (req, res) => {
    const file = isMobile(req) ? 'dividend_mobile.html' : 'dividend.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/settings', (req, res) => {
    const file = isMobile(req) ? 'settings_mobile.html' : 'settings.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/notifications', (req, res) => {
    const file = isMobile(req) ? 'notifications_mobile.html' : 'notifications.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

app.get('/watchlist', (req, res) => {
    const file = isMobile(req) ? 'watchlist_mobile.html' : 'watchlist.html';
    res.sendFile(path.join(__dirname, '../public', file));
});

// Legacy /assets route → redirect to /market
app.get('/assets', (req, res) => res.redirect('/market'));

// Default → dashboard
app.get('/', (req, res) => res.redirect('/dashboard'));
app.use((req, res) => res.redirect('/dashboard'));

// ════════════════════════════════════════════════════════════════════════════
// RESET DATA
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// MARKET DATA UPDATE  (runs on interval)
// ════════════════════════════════════════════════════════════════════════════

let globalLastMarketUpdate = Date.now();

async function updateMarketData(force = false) {
    const settings = database.getSettings();
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
                        quoteDate: new Date().toISOString().split('T')[0]
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
                    change: metadata.changePercent || asset.changePercent,
                    changeValue: metadata.changeValue || 0,
                    pe: metadata.pe || asset.pe,
                    forwardPE: metadata.forwardPE || asset.forwardPE,
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
                    SET currentPrice=?, changePercent=?, changeValue=?, preMarketChangePercent=?, postMarketChangePercent=?, pe=?, forwardPE=?, dividendYield=?, eps=?, beta=?, nextDividendDate=?, name=?, currency=?, exchange=?, country=?, quoteDate=?, lastUpdateError=NULL, updatedAt=datetime('now')
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
                    updateData.nextDividendDate,
                    updateData.name,
                    updateData.currency,
                    updateData.exchange,
                    updateData.country,
                    updateData.quoteDate,
                    asset.ticker
                );
                logger.info(`Successfully updated ${asset.ticker}: ${updateData.price} ${updateData.currency}`);

                // Alert Checks
                const newPrice = updateData.price;
                if (asset.targetPrice > 0 && newPrice >= asset.targetPrice) {
                    const existing = database.db.prepare(`
                        SELECT id FROM notifications 
                        WHERE ticker = ? AND type = 'TARGET_PROFIT' AND date(date) = date('now')
                    `).get(asset.ticker);
                    if (!existing) {
                        database.db.prepare(`
                            INSERT INTO notifications (type, title, message, ticker)
                            VALUES (?, ?, ?, ?)
                        `).run('TARGET_PROFIT', 'TARGET PROFIT', `${asset.ticker}: ${newPrice} (Target TP: ${asset.targetPrice})`, asset.ticker);
                        
                        // Telegram Notification
                        const msg = `🏆 *TARGET PROFIT*\n\n*Titolo:* ${escapeV2(asset.ticker)}\n*Prezzo Attuale:* ${newPrice}\n*Target TP:* ${asset.targetPrice}`;
                        sendTelegramMessage(msg).catch(e => logger.error('Telegram Target Alert failed', e));
                    }
                }
                if (asset.stopLoss > 0 && newPrice <= asset.stopLoss) {
                    const existing = database.db.prepare(`
                        SELECT id FROM notifications 
                        WHERE ticker = ? AND type = 'STOP_LOSS' AND date(date) = date('now')
                    `).get(asset.ticker);
                    if (!existing) {
                        database.db.prepare(`
                            INSERT INTO notifications (type, title, message, ticker)
                            VALUES (?, ?, ?, ?)
                        `).run('STOP_LOSS', 'STOP LOSS', `${asset.ticker}: ${newPrice} (Soglia SL: ${asset.stopLoss})`, asset.ticker);
                        
                        // Telegram Notification
                        const msg = `⚠️ *STOP LOSS*\n\n*Titolo:* ${escapeV2(asset.ticker)}\n*Prezzo Attuale:* ${newPrice}\n*Soglia SL:* ${asset.stopLoss}`;
                        sendTelegramMessage(msg).catch(e => logger.error('Telegram Stop Alert failed', e));
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
    database.recalculateAll(liveRate);
    globalLastMarketUpdate = Date.now();
    logger.info(`Market data update cycle completed.`);
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
let lastUpdateTime = Date.now();
let lastBackupDate = ''; // 'YYYY-MM-DD'
let lastSnapshotDate = ''; // 'YYYY-MM-DD'
let lastDailyReportDate = ''; // 'YYYY-MM-DD'
let lastTelegramStatusTime = 0;

// ─── News Sync Engine ───────────────────────────────────────────────────────
async function syncNews() {
    try {
        logger.info('Starting Financial News Sync...');
        
        // 1. Get tickers and names from Watchlist or active Portfolios
        const allTrackedAssets = database.db.prepare(`
            SELECT a.ticker, a.name 
            FROM assets a
            LEFT JOIN (
                SELECT assetTicker, SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
                FROM transactions
                GROUP BY assetTicker
            ) t ON a.ticker = t.assetTicker
            WHERE a.inWatchlist = 1 OR IFNULL(t.balance, 0) > 0.0001
        `).all().filter(a => a.ticker && a.ticker !== 'CASH' && !a.ticker.startsWith('CD_'));
        
        const assets = allTrackedAssets; // Use the objects directly
        let newsSaved = 0;

        // Clear existing news to ensure a clean start with the new filtering
        database.db.prepare(`DELETE FROM global_news`).run();

        for (const asset of assets) {
            const t = asset.ticker;
            const name = asset.name || '';
            const tickerBase = t.split('.')[0].toUpperCase();
            const tickerFull = t.toUpperCase();

            try {
                const results = await yahooFinance.search(t, { newsCount: 10 });
                if (results && results.news) {
                    for (const n of results.news) {
                        const uuid = String(n.uuid || '');
                        const title = String(n.title || '');
                        const publisher = String(n.publisher || 'Unknown');
                        const link = String(n.link || '');
                        
                        let publishedAt;
                        if (n.providerPublishTime instanceof Date) {
                            publishedAt = Math.floor(n.providerPublishTime.getTime() / 1000);
                        } else if (typeof n.providerPublishTime === 'number') {
                            publishedAt = n.providerPublishTime;
                        } else {
                            publishedAt = Math.floor(Date.now() / 1000);
                        }

                        if (!uuid || !title || !link) continue; 

                        // Strict Relevance Filter
                        const related = (n.relatedTickers || []).map(rt => rt.toUpperCase());
                        const upperTitle = title.toUpperCase();
                        
                        let isRelevant = false;
                        if (related.length > 0) {
                            isRelevant = related.includes(tickerFull) || related.includes(tickerBase);
                        } else {
                            isRelevant = upperTitle.includes(tickerFull) || 
                                         upperTitle.includes(tickerBase) || 
                                         (name && upperTitle.includes(name.toUpperCase()));
                        }

                        if (!isRelevant) continue;
                        
                        const stmt = database.db.prepare(`
                            INSERT OR IGNORE INTO global_news (uuid, ticker, title, publisher, link, publishedAt)
                            VALUES (?, ?, ?, ?, ?, ?)
                        `);
                        const info = stmt.run(uuid, String(t), title, publisher, link, publishedAt);
                        if (info.changes > 0) newsSaved++;
                    }
                }
            } catch (e) {
                logger.warn(`Failed to fetch news for ${t}: ${e.message}`);
            }
        }
        
        // 2. Obsolescence: Limit global_news to 100 latest items
        database.db.prepare(`
            DELETE FROM global_news 
            WHERE uuid NOT IN (
                SELECT uuid FROM global_news ORDER BY publishedAt DESC LIMIT 100
            )
        `).run();
        
        logger.info(`News Sync completed. Saved ${newsSaved} new articles.`);
    } catch (err) {
        logger.error('Error during news sync:', err);
    }
}

setInterval(() => {
    syncNews().catch(e => logger.error(e));
}, 2 * 60 * 60 * 1000); // 2 hours

setTimeout(syncNews, 10000); // Run first sync 10s after startup



setInterval(async () => {
    const settings = database.getSettings();
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const status = getMarketStatus();
    
    // 1. Market Data Update
    const freqMs = parseInt(settings.updateFrequency || 5) * 60 * 1000;
    if (freqMs > 0 && Date.now() - lastUpdateTime >= freqMs) {
        updateMarketData();
        lastUpdateTime = Date.now();
    }

    // 2. Telegram Periodic Status
    const tgStatusEnabled = settings.marketStatusTelegramEnabled === 'true';
    const tgIntervalMin = parseInt(settings.marketStatusInterval || 60);

    // Periodic during market hours
    if (tgStatusEnabled && status.anyOpen && tgIntervalMin > 0) {
        if (Date.now() - lastTelegramStatusTime >= tgIntervalMin * 60 * 1000) {
            logger.info('Sending periodic market status to Telegram...');
            sendMarketStatusTelegram().catch(e => logger.error('Periodic Telegram status failed', e));
            lastTelegramStatusTime = Date.now();
        }
    }

    // Daily Summary at 22:15 CET
    const nowHour = now.getHours();
    const nowMin = now.getMinutes();
    if (tgStatusEnabled && nowHour === 22 && nowMin === 15 && lastDailyReportDate !== todayStr) {
        logger.info('Sending daily summary to Telegram (Scheduled)...');
        sendMarketStatusTelegram().catch(e => logger.error('Scheduled Telegram report failed', e));
        lastDailyReportDate = todayStr;
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
            const portfolios = database.db.prepare(`SELECT id FROM portfolios`).all();
            portfolios.forEach(p => database.savePortfolioSnapshot(p.id, liveRate));
            database.savePortfolioSnapshot(null, liveRate); // Global snapshot
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
    });
}

module.exports = {
    app,
    calculatePerformanceHistory,
    updateMarketData,
    getEurUsdRate,
    syncNews,
    sendMarketStatusTelegram
};
