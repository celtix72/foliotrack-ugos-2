'use strict';

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const dotenv     = require('dotenv');
const YahooFinance = require('yahoo-finance2').default;
const axios      = require('axios');
const fs         = require('fs');

const LOG_FILE = path.join(__dirname, '../logs/app.log');

const logger = {
    info: (msg) => {
        const line = `${new Date().toISOString()} [INFO] ${msg}\n`;
        process.stdout.write(line);
        fs.appendFileSync(LOG_FILE, line);
    },
    error: (msg, err) => {
        const errMsg = err ? ` - Error: ${err.message || err}` : '';
        const line = `${new Date().toISOString()} [ERROR] ${msg}${errMsg}\n`;
        process.stderr.write(line);
        fs.appendFileSync(LOG_FILE, line);
    },
    warn: (msg) => {
        const line = `${new Date().toISOString()} [WARN] ${msg}\n`;
        process.stdout.write(line);
        fs.appendFileSync(LOG_FILE, line);
    }
};

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const database = require('./database');
const backupManager = require('./backup_manager');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CACHING LAYER ──────────────────────────────────────────────────────────
const historicalPricesCache = {}; // { ticker: { date: price } }
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
    try {
        const quote = await yahooFinance.quote(ticker).catch(err => {
            if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
                throw new Error('YF_RATE_LIMIT');
            }
            return null;
        });
        if (!quote) return null;

        let country = 'N/A';
        let detailedType = quote.quoteType === 'EQUITY' ? 'Azionario' : (quote.quoteType || 'Altro');

        const summary = await yahooFinance.quoteSummary(ticker, { 
            modules: ["summaryProfile", "assetProfile", "fundProfile"] 
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
                detailedType = `${quote.quoteType === 'ETF' ? 'ETF' : 'Fondo'} ${fp.categoryName}`;
            } else if (nameStr.includes('bond') || nameStr.includes('obbligazion')) {
                detailedType = `${quote.quoteType === 'ETF' ? 'ETF' : 'Fondo'} Obbligazionario`;
            } else if (nameStr.includes('equity') || nameStr.includes('azionario') || nameStr.includes('world') || nameStr.includes('stock')) {
                detailedType = `${quote.quoteType === 'ETF' ? 'ETF' : 'Fondo'} Azionario`;
            } else if (nameStr.includes('monetary') || nameStr.includes('monetario') || nameStr.includes('cash') || nameStr.includes('rate')) {
                detailedType = `${quote.quoteType === 'ETF' ? 'ETF' : 'Fondo'} Monetario`;
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
            pe: quote.trailingPE || quote.forwardPE || null,
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
    console.log('Performance result cache invalidated.');
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
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
    // Remove encoded characters and restrict to common ticker symbols
    return ticker.replace(/%[0-9A-F]{2}/gi, '').replace(/[^A-Z0-9.\-_:=]/gi, '').toUpperCase();
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
        SELECT a.*, CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition
        FROM assets a
        LEFT JOIN (
            SELECT assetTicker, 
                   SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance 
            FROM transactions 
            GROUP BY assetTicker
        ) t ON a.ticker = t.assetTicker
        WHERE a.ticker != 'CASH' AND (a.type != 'Cash' OR a.type IS NULL) 
        ORDER BY a.name ASC
    `).all();

    // Add sparkline data (last 7 days from cache)
    const result = rows.map(a => {
        let sparkline = [];
        if (historicalPricesCache[a.ticker]) {
            const history = historicalPricesCache[a.ticker];
            const dates = Object.keys(history).sort();
            sparkline = dates.slice(-7).map(d => history[d]);
        }
        return { ...a, sparkline };
    });

    res.json(result);
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
                    country:      metadata.country,
                    dataSource:   dataSource || 'YF',
                    isin:         isin || null
                };
            }
        }

        const existing = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(assetData.ticker);
        if (existing && assetData.ticker) return res.status(400).send('Asset already in monitoring list');

        database.db.prepare(`
            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, dataSource, isin, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            assetData.id, assetData.ticker, assetData.name, assetData.type,
            assetData.exchange, assetData.currency, assetData.currentPrice,
            assetData.changePercent, assetData.pe, assetData.country,
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
    if (stopLoss !== undefined) { updates.push("stopLoss = ?"); params.push(stopLoss); }
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

// ─── WATCHLIST API ──────────────────────────────────────────────────────────

app.get('/api/watchlist', (req, res) => {
    try {
        const rows = database.db.prepare(`
            SELECT * FROM assets 
            WHERE inWatchlist = 1 
            ORDER BY ticker ASC
        `).all();
        res.json(rows);
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
    } catch (err) {
        console.error('Watchlist add error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/watchlist/:ticker', (req, res) => {
    try {
        database.db.prepare(`UPDATE assets SET inWatchlist = 0 WHERE ticker = ?`).run(req.params.ticker.toUpperCase());
        res.json({ success: true });
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

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIOS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/portfolios', async (req, res) => {
    try {
        const liveRate = await getEurUsdRate();
        database.recalculateAll(liveRate);
        const rows = database.db.prepare(`SELECT * FROM portfolios ORDER BY createdAt ASC`).all();
        
        const todayStr = new Date().toISOString().split('T')[0];
        
        // 1. Calculate Global Variation using Chart Engine
        const globalPoints = await calculatePerformanceHistory(null, '1W');
        let globalChangeValue = 0;
        let globalChangePercent = 0;
        let globalTotalValue = 0;

        if (globalPoints.length > 0) {
            const lastPoint = globalPoints[globalPoints.length - 1];
            globalTotalValue = lastPoint.value;
            
            if (globalPoints.length > 1) {
                const lastPoint = globalPoints[globalPoints.length - 1];
                const prevPoint = globalPoints[globalPoints.length - 2];
                // Profit-based variation (Independent of capital movements)
                globalChangeValue = lastPoint.profit - prevPoint.profit;
                if (prevPoint.value > 0) {
                    globalChangePercent = (globalChangeValue / prevPoint.value) * 100;
                }
            }
        }

        // 2. Calculate Totals including Taxes
        let totalGrossValue = 0;
        let totalTax = 0;

        for (const p of rows) {
            const pPoints = await calculatePerformanceHistory([p.id], '1W');
            if (pPoints.length > 0) {
                const lastP = pPoints[pPoints.length - 1];
                p.totalValue = lastP.value;
                if (pPoints.length > 1) {
                    const lastP = pPoints[pPoints.length - 1];
                    const prevP = pPoints[pPoints.length - 2];
                    // Profit-based variation
                    p.changeValue = lastP.profit - prevP.profit;
                    p.changePercent = prevP.value > 0 ? (p.changeValue / prevP.value) * 100 : 0;
                } else {
                    p.changeValue = 0;
                    p.changePercent = 0;
                }
            } else {
                p.changeValue = 0;
                p.changePercent = 0;
            }

            // Calculate tax for this portfolio
            const details = await getPortfolioDetails(p.id, liveRate);
            p.totalTax = details.totalLatentTax;
            p.netValue = p.totalValue - p.totalTax;
            
            totalGrossValue += p.totalValue;
            totalTax += p.totalTax;
        }

        res.json({
            portfolios: rows,
            global: {
                totalValue: totalGrossValue,
                totalNetValue: totalGrossValue - totalTax,
                totalTax: totalTax,
                changePercent: globalChangePercent,
                changeValue: globalChangeValue
            }
        });
    } catch (err) {
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

    if (!liveRate) {
        liveRate = await getEurUsdRate();
    }

    // FIFO lots per ticker
    const lots        = {};   // { ticker: [{qty, costPerShare, costPerShareAssetCurr}] }
    const openMap     = {};   // { ticker: {shares, totalCostInPCurr, totalCostInAssetCurr} }
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
            const totalCost    = (t.amount || (qty * price + comm + tax)) / fx;
            const costPerShare = qty > 0 ? totalCost / qty : 0;
            if (!lots[t.assetTicker])    lots[t.assetTicker] = [];
            if (!openMap[t.assetTicker]) openMap[t.assetTicker] = { shares: 0, totalCostInPCurr: 0, totalCostInAssetCurr: 0 };
            
            const totalCostAssetCurr = (t.amount || (qty * price + comm + tax));
            const costPerShareAsset  = qty > 0 ? totalCostAssetCurr / qty : 0;
            
            lots[t.assetTicker].push({ qty, costPerShare, costPerShareAssetCurr: costPerShareAsset });
            openMap[t.assetTicker].shares              += qty;
            openMap[t.assetTicker].totalCostInPCurr    += totalCost;
            openMap[t.assetTicker].totalCostInAssetCurr += totalCostAssetCurr;
        }

        if (t.type === 'SELL' && t.assetTicker) {
            let remaining  = qty;
            const proceeds = (t.amount || (qty * price - comm - tax)) / fx;
            const lotsCopy = lots[t.assetTicker] || [];
            let costBasis          = 0;
            let costBasisAssetCurr = 0;
            while (remaining > 0 && lotsCopy.length > 0) {
                const lot  = lotsCopy[0];
                const used = Math.min(lot.qty, remaining);
                costBasis          += used * lot.costPerShare;
                costBasisAssetCurr += used * (lot.costPerShareAssetCurr || 0);
                lot.qty   -= used;
                remaining -= used;
                if (lot.qty <= 0) lotsCopy.shift();
            }
            lots[t.assetTicker] = lotsCopy;
            if (openMap[t.assetTicker]) {
                openMap[t.assetTicker].shares              -= qty;
                openMap[t.assetTicker].totalCostInPCurr    -= costBasis;
                openMap[t.assetTicker].totalCostInAssetCurr -= costBasisAssetCurr;
                if (openMap[t.assetTicker].shares <= 0.0001) delete openMap[t.assetTicker];
            }
            const rGain = proceeds - costBasis;
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
            const curPx  = asset ? asset.currentPrice : 0;
            
            // FX rate for this specific asset conversion
            const rate = (asset && asset.currency === 'USD' && portfolio.currency === 'EUR') ? liveRate : 1;
            
            const curPxP = (asset && asset.currency !== portfolio.currency) ? curPx / rate : curPx;
            const curVal = h.shares * curPxP;
            const avgCost = h.shares > 0 ? h.totalCostInPCurr / h.shares : 0;
            const avgCostAsset = h.shares > 0 ? h.totalCostInAssetCurr / h.shares : 0;
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
                isin: asset ? asset.isin : null,
                dataSource: asset ? asset.dataSource : 'YF',
                country: asset ? asset.country : 'Global',
                lastUpdateError: asset ? asset.lastUpdateError : null
            };
        });

    const taxRates = database.db.prepare(`SELECT asset_type, rate FROM tax_rates`).all();
    const trMap = {};
    taxRates.forEach(r => trMap[r.asset_type] = r.rate);

    const losses = database.db.prepare(`SELECT asset_type, amount FROM portfolio_losses WHERE portfolioId = ?`).all(portfolioId);
    const lossMap = {};
    losses.forEach(l => lossMap[l.asset_type] = l.amount);

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
    const typeMap = {};
    const currMap = {};
    const counMap = {};

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
        type, value, percent: totalAssetsValue > 0 ? (value / totalAssetsValue) * 100 : 0
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

    const liveTotalValue = Math.round((portfolio.currentCash + totalAssetsValue) * 100) / 100;

    // PROFIT-BASED VARIATION (Excluding capital moves)
    const history = await calculatePerformanceHistory([portfolioId], '1W');
    let changePercent = 0;
    if (history.length > 1) {
        const last = history[history.length - 1];
        const prev = history[history.length - 2];
        const profitChange = last.profit - prev.profit;
        if (prev.value > 0) {
            changePercent = (profitChange / prev.value) * 100;
        }
    }

    return {
        ...portfolio,
        totalValue: liveTotalValue,
        changePercent,
        transactions,
        holdings,
        allocation,
        currencyAllocation: Object.entries(currMap).map(([type, value]) => ({ type, value })),
        countryAllocation: Object.entries(counMap).map(([type, value]) => ({ type, value })),
        closedPositions,
        dividendGroups: Object.values(divYearMap).sort((a, b) => b.year - a.year),
        totalDividends,
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
        let totalValue = 0;

        for (const { id } of portfolios) {
            const details = await getPortfolioDetails(id, liveRate);
            const holdings = details.holdings;
            for (const h of holdings) {
                const tp = h.type || 'Other';
                typeMap[tp] = (typeMap[tp] || 0) + h.currentValue;
                totalValue += h.currentValue;
            }
        }

        const allocation = Object.entries(typeMap)
            .map(([type, value]) => ({
                type,
                value: Math.round(value * 100) / 100,
                percent: totalValue > 0 ? Math.round((value / totalValue) * 1000) / 10 : 0
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
    const { name, currency, startDate, initialCash, color, losses } = req.body;

    if (!name) return res.status(400).json({ error: 'Portfolio name is required' });

    const cash  = parseFloat(initialCash || 0);
    const start = startDate || new Date().toISOString().split('T')[0];
    const pColor = color || '#6366f1';

    const result = database.db.prepare(`
        INSERT INTO portfolios (name, currency, startDate, initialCash, currentCash, totalValue, color)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, currency || 'EUR', start, cash, cash, cash, pColor);

    const portfolioId = result.lastInsertRowid;

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

    const { name, currency, startDate, initialCash, color, losses } = req.body;
    database.db.prepare(`
        UPDATE portfolios SET name=?, currency=?, startDate=?, initialCash=?, color=? WHERE id=?
    `).run(
        name       || existing.name,
        currency   || existing.currency,
        startDate  || existing.startDate,
        parseFloat(initialCash != null ? initialCash : existing.initialCash),
        color      || existing.color || '#6366f1',
        req.params.id
    );

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
        performanceResultsCache = {};
        
        const portfolios = database.db.prepare('SELECT id FROM portfolios').all();
        logger.info(`Rebuilding performance history: Step 3/4 - Recalculating for ${portfolios.length} portfolios...`);
        
        for (const p of portfolios) {
            const dataPoints = await calculatePerformanceHistory(p.id, 'ALL');
            const insert = database.db.prepare(`
                INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue)
                VALUES (?, ?, ?, ?, ?)
            `);
            
            database.db.transaction(() => {
                for (const pt of dataPoints) {
                    insert.run(p.id, pt.date, pt.value, pt.cash || 0, pt.assets || 0);
                }
            })();
        }
        
        logger.info('Rebuilding performance history: Step 4/4 - Recalculating Global...');
        const globalPoints = await calculatePerformanceHistory(null, 'ALL');
        const insertGlobal = database.db.prepare(`
            INSERT OR REPLACE INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue)
            VALUES (NULL, ?, ?, ?, ?)
        `);
        
        database.db.transaction(() => {
            for (const pt of globalPoints) {
                insertGlobal.run(pt.date, pt.value, pt.cash || 0, pt.assets || 0);
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

app.get('/api/transactions', (req, res) => {
    const { portfolioId } = req.query;
    if (portfolioId) {
        return res.json(database.db.prepare(`SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`).all(portfolioId));
    }
    res.json(database.db.prepare(`SELECT * FROM transactions ORDER BY date ASC`).all());
});

app.post('/api/transactions', async (req, res) => {
    const { portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount, destinationPortfolioId, isin, dataSource } = req.body;

    if (!portfolioId) return res.status(400).send('portfolioId is required');

    const sanitizedTicker = sanitizeTicker(assetTicker);

    // Auto-create/update asset with ISIN and Data Source
    if (sanitizedTicker && sanitizedTicker !== 'CASH') {
        const existingAsset = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(sanitizedTicker);
        if (existingAsset) {
            database.db.prepare(`UPDATE assets SET isin = COALESCE(?, isin), dataSource = COALESCE(?, dataSource) WHERE ticker = ?`)
                .run(isin || null, dataSource || null, sanitizedTicker);
        } else {
            const metadata = await fetchAssetMetadata(sanitizedTicker).catch(() => null) || {};
            database.db.prepare(`
                INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(
                sanitizedTicker, sanitizedTicker, metadata.name || sanitizedTicker, metadata.type || 'Stock', metadata.exchange || 'N/A', 
                metadata.currency || 'USD', metadata.currentPrice || 0, metadata.changePercent || 0, metadata.pe || null, metadata.country || 'N/A', 0,
                dataSource || 'YF', isin || null
            );
        }
    }

    const result = database.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        parseInt(portfolioId), type, sanitizedTicker || '',
        date || new Date().toISOString().split('T')[0],
        parseFloat(quantity || 0), parseFloat(price || 0),
        parseFloat(commission || 0), parseFloat(tax || 0),
        parseFloat(exchangeRate || 1), parseFloat(amount || 0)
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
    res.json(row);
});

app.put('/api/transactions/:id', (req, res) => {
    const { type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount } = req.body;
    const existing = database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Transaction not found');

    database.db.prepare(`
        UPDATE transactions 
        SET type = ?, assetTicker = ?, date = ?, quantity = ?, price = ?, commission = ?, tax = ?, exchangeRate = ?, amount = ?
        WHERE id = ?
    `).run(
        type || existing.type,
        assetTicker || existing.assetTicker,
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
    const ticker = (req.query.ticker || "").toUpperCase();
    if (!ticker) return res.status(400).send('Ticker required');

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

    try {
        const metadata = await fetchAssetMetadata(ticker);
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
            } else {
                res.json({ valid: false, suggestions: [] });
            }
        } catch {
            res.json({ valid: false, suggestions: [] });
        }
    }
});

// Bulk import: save multiple validated transactions at once
app.post('/api/transactions/bulk', async (req, res) => {
    const { portfolioId, transactions } = req.body;
    if (!portfolioId || !transactions || !transactions.length) {
        return res.status(400).json({ error: 'portfolioId and transactions[] required' });
    }
    // If portfolioId is provided, check if it exists (unless it's a dummy value for multi-import)
    const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio && portfolioId !== 'all' && portfolioId !== 0 && portfolioId !== '0') {
        return res.status(404).json({ error: 'Portfolio not found' });
    }

    const insertTx = database.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const results = [];
    const affectedPortfolios = new Set();
    if (portfolioId !== 'all') affectedPortfolios.add(parseInt(portfolioId));

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
                
                if (isNaN(targetId)) throw new Error('Invalid portfolio mapping');
                affectedPortfolios.add(targetId);

                // Auto-add or update asset with ISIN/DataSource
                if (t.assetTicker) {
                    const sanitizedTicker = sanitizeTicker(t.assetTicker);
                    const existingAsset = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(sanitizedTicker);
                    if (existingAsset) {
                        database.db.prepare(`UPDATE assets SET isin = COALESCE(?, isin), dataSource = COALESCE(?, dataSource) WHERE ticker = ?`)
                            .run(t.isin || null, t.dataSource || null, sanitizedTicker);
                    } else {
                        database.db.prepare(`
                            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                        `).run(
                            t.assetId || null, 
                            sanitizedTicker, 
                            t.assetName || sanitizedTicker, 
                            t.assetType || 'Stock', 
                            t.assetExchange || 'N/A', 
                            t.assetCurrency || 'USD', 
                            t.assetPrice || 0,
                            0, 
                            t.assetPe || null,
                            t.assetCountry || 'N/A',
                            0,
                            t.dataSource || 'YF',
                            t.isin || null
                        );
                    }
                }

                insertTx.run(
                    targetId,
                    t.type,
                    t.assetTicker || '',
                    t.date,
                    parseFloat(t.quantity || 0),
                    parseFloat(t.price || 0),
                    parseFloat(t.commission || 0),
                    parseFloat(t.tax || 0),
                    parseFloat(t.exchangeRate || 1),
                    parseFloat(t.amount || 0)
                );
                results.push({ ok: true, ticker: t.assetTicker, date: t.date, portfolioId: targetId });
            } catch (err) {
                results.push({ ok: false, ticker: t.assetTicker, error: err.message });
            }
        }
    });

    importMany(transactions);
    
    // Recalculate ALL affected portfolios
    for (const pid of affectedPortfolios) {
        database.recalculatePortfolio(pid);
    }
    
    clearPerformanceCache();
    res.json({ imported: results.filter(r => r.ok).length, results });
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
async function calculatePerformanceHistory(portfolioIds, range) {
    // Standardize input: null, single ID, or array
    const pIdsInput = portfolioIds === null ? null : (Array.isArray(portfolioIds) ? portfolioIds : [portfolioIds]);
    
    const isGlobal = !pIdsInput || pIdsInput.length === 0;
    const portfolios = isGlobal 
        ? database.db.prepare('SELECT * FROM portfolios').all()
        : database.db.prepare(`SELECT * FROM portfolios WHERE id IN (${pIdsInput.join(',')})`).all();

    if (portfolios.length === 0) return [];

    const pIds = portfolios.map(p => p.id);
    const allTransactions = database.db.prepare(`
        SELECT * FROM transactions 
        WHERE portfolioId IN (${pIds.join(',')}) 
        ORDER BY date ASC
    `).all();

    const today = new Date();
    let startDate;
    
    switch (range) {
        case '1D':  startDate = new Date(today); startDate.setDate(today.getDate() - 1); break;
        case '1W':  startDate = new Date(today); startDate.setDate(today.getDate() - 7); break;
        case '1M':  startDate = new Date(today); startDate.setMonth(today.getMonth() - 1); break;
        case '3M':  startDate = new Date(today); startDate.setMonth(today.getMonth() - 3); break;
        case '6M':  startDate = new Date(today); startDate.setMonth(today.getMonth() - 6); break;
        case '1Y':  startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 1); break;
        case '2Y':  startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 2); break;
        case 'YTD': startDate = new Date(today.getFullYear(), 0, 1); break;
        default: {
            const firstDate = allTransactions.length > 0 ? allTransactions[0].date : null;
            startDate = firstDate ? new Date(firstDate) : new Date(today);
            if (startDate > today) startDate = new Date(today);
        }
    }
    logger.info(`[DEBUG] calculatePerformanceHistory: range=${range}, startDate=${startDate.toISOString()}, tickersCount=${[...new Set(allTransactions.map(t => t.assetTicker).filter(Boolean))].length}`);

    const uniqueTickers = [...new Set(allTransactions.map(t => t.assetTicker).filter(Boolean))];
    const historicalPrices = {};
    const fxRates = {};

    // 1. Fetch historical EUR/USD if any portfolio is EUR
    const hasEurPortfolio = portfolios.some(p => p.currency === 'EUR');
    if (hasEurPortfolio) {
        try {
            const fxCacheKey = `EUR_USD_history_${startDate.toISOString().split('T')[0]}_${today.toISOString().split('T')[0]}`;
            if (historicalPricesCache[fxCacheKey]) {
                fxRates['USD'] = historicalPricesCache[fxCacheKey];
            } else {
                const fxResult = await yahooFinance.chart('EURUSD=X', {
                    period1: startDate.toISOString().split('T')[0],
                    period2: today.toISOString().split('T')[0],
                    interval: '1d'
                });
                if (fxResult && fxResult.quotes) {
                    const sanitizedRates = {};
                    let lastValidRate = 1.0;
                    
                    // Sort quotes by date to ensure proper forward-filling
                    const sortedQuotes = fxResult.quotes
                        .filter(h => h.date)
                        .sort((a, b) => new Date(a.date) - new Date(b.date));

                    for (const h of sortedQuotes) {
                        const dateStr = new Date(h.date).toISOString().split('T')[0];
                        let currentRate = h.adjclose || h.close;
                        
                        // SANITIZATION: Yahoo Finance often returns 1.0 for EURUSD=X on holidays or gaps.
                        // Also handle occasional null/zero values.
                        if ((!currentRate || currentRate <= 0 || currentRate === 1.0) && lastValidRate > 0 && lastValidRate !== 1.0) {
                            currentRate = lastValidRate;
                        } else if (currentRate && currentRate > 0 && currentRate !== 1.0) {
                            lastValidRate = currentRate;
                        } else if (!currentRate || currentRate <= 0) {
                            // If we have no lastValidRate yet, we'll have to skip this date 
                            // to let the fallback logic handle it later
                            continue;
                        }
                        
                        sanitizedRates[dateStr] = currentRate;
                    }
                    
                    fxRates['USD'] = sanitizedRates;
                    historicalPricesCache[fxCacheKey] = fxRates['USD'];
                }
            }
        } catch (err) { console.warn("Failed to fetch EURUSD history", err); }
    }

    // 2. Fetch historical data for all involved tickers (with parallelization and DB cache)
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
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
        logger.info(`[DEBUG] fetchTickerData: Starting for ${ticker}`);
        try {
            // Check In-Memory Cache first
            if (historicalPricesCache[ticker]) {
                historicalPrices[ticker] = historicalPricesCache[ticker];
                return;
            }

            // Check Persistent DB Cache
            const dbQuotes = database.db.prepare(`SELECT date, price FROM asset_quotes WHERE ticker = ? AND date >= ?`).all(ticker, startDate.toISOString().split('T')[0]);
            if (dbQuotes.length > 0) {
                historicalPrices[ticker] = Object.fromEntries(dbQuotes.map(q => [q.date, q.price]));
                historicalPricesCache[ticker] = historicalPrices[ticker];
                const latestDate = dbQuotes.map(q => q.date).sort().at(-1);
                const todayStr = new Date().toISOString().split('T')[0];
                if (latestDate >= todayStr) return; 
            }

            // Determine if we should use Borsa Italiana
            const assetMeta = assetMetadataCache[ticker];
            const isItIsin = assetMeta && assetMeta.isin && /^IT[0-9A-Z]{10}$/.test(assetMeta.isin);
            let pricesMap = null;

            if (isItIsin || (assetMeta && assetMeta.dataSource === 'B_ITA')) {
                const searchIsin = (assetMeta && assetMeta.isin) || ticker;
                pricesMap = await fetchBorsaItalianaHistory(ticker, searchIsin);
            }

            // Fallback to Yahoo Finance
            if (!pricesMap) {
                const qStart = (allTransactions.find(t => t.assetTicker === ticker)?.date) || startDate.toISOString().split('T')[0];
                const chartResult = await yahooFinance.chart(ticker, {
                    period1: qStart,
                    period2: today.toISOString().split('T')[0],
                    interval: '1d'
                }).catch(() => null);

                if (chartResult && chartResult.quotes) {
                    const validQuotes = chartResult.quotes
                        .filter(h => h.date && (h.adjclose || h.close) && (h.adjclose || h.close) > 0);
                    
                    pricesMap = Object.fromEntries(
                        validQuotes.map(h => [new Date(h.date).toISOString().split('T')[0], h.adjclose || h.close])
                    );
                }
            }

            if (pricesMap && Object.keys(pricesMap).length > 0) {
                historicalPrices[ticker] = pricesMap;
                historicalPricesCache[ticker] = pricesMap;

                // Save to DB Cache (UPSERT)
                const insertQuote = database.db.prepare(`INSERT OR REPLACE INTO asset_quotes (ticker, date, price) VALUES (?, ?, ?)`);
                const saveQuotes = database.db.transaction((quotes) => {
                    for (const [date, price] of Object.entries(pricesMap)) {
                        insertQuote.run(ticker, date, price);
                    }
                });
                saveQuotes(null);
            } else {
                historicalPrices[ticker] = {};
            }
        } catch (err) {
            console.warn(`Failed to fetch history for ${ticker}:`, err.message);
            historicalPrices[ticker] = {};
        }
    };

    // Move assetMetadataCache creation HERE, BEFORE fetchTickerData uses it!
    const assetMetadataCache = {}; // Cache to avoid DB queries inside the date loop
    const allAssets = database.db.prepare('SELECT ticker, currency, currentPrice, type, isin, dataSource FROM assets').all();
    for (const a of allAssets) assetMetadataCache[a.ticker] = a;

    await Promise.all(uniqueTickers.map(ticker => fetchTickerData(ticker)));

    const dataPoints = [];
    let currentDate = new Date(startDate);

    // Initial state and metadata caching per portfolio
    const portfolioStates = {};

    for (const p of portfolios) {
        portfolioStates[p.id] = {
            cash: p.initialCash || 0,
            netDeposits: p.initialCash || 0,
            holdings: {},
            lastTxPrices: {} 
        };
        
        // Fast-forward initial state to startDate
        const startDateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
        const initialTx = allTransactions.filter(t => t.portfolioId === p.id && t.date < startDateStr);
        for (const t of initialTx) {
            const qty = t.quantity || 0, price = t.price || 0, comm = t.commission || 0, tax = t.tax || 0, fx = t.exchangeRate || 1, amount = t.amount || 0;
            if (t.assetTicker && price > 0) {
                portfolioStates[p.id].lastTxPrices[t.assetTicker] = price;
            }
            switch (t.type) {
                case 'DEPOSIT':    portfolioStates[p.id].cash += amount; portfolioStates[p.id].netDeposits += amount; break;
                case 'WITHDRAWAL': portfolioStates[p.id].cash -= amount; portfolioStates[p.id].netDeposits -= amount; break;
                case 'TAX':        portfolioStates[p.id].cash -= amount; break;
                case 'TRANSFER':   portfolioStates[p.id].cash -= amount; break;
                case 'DIVIDEND': {
                    const divAmt = (t.amount || (qty * price - comm - tax)) / fx;
                    portfolioStates[p.id].cash += divAmt; 
                    break;
                }
                case 'BUY':
                    portfolioStates[p.id].cash -= (t.amount || (qty * price + comm + tax)) / fx;
                    portfolioStates[p.id].holdings[t.assetTicker] = (portfolioStates[p.id].holdings[t.assetTicker] || 0) + qty;
                    break;
                case 'SELL':
                    portfolioStates[p.id].cash += (t.amount || (qty * price - comm - tax)) / fx;
                    portfolioStates[p.id].holdings[t.assetTicker] = (portfolioStates[p.id].holdings[t.assetTicker] || 0) - qty;
                    break;
            }
        }
    }

    const formatDate = (date) => {
        const d = new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    while (currentDate <= today) {
        const dateStr = formatDate(currentDate);
        let dayValue = 0, dayProfit = 0, dayCash = 0, dayAssets = 0;
        const dayEvents = [];

        const todayStr = today.toISOString().split('T')[0];
        const isToday = dateStr === todayStr;

        // Check for manual overrides for this specific date
        // CRITICAL FIX: For the CURRENT day, we skip the snapshot and use live calculation 
        // to avoid discrepancies between outdated snapshots and new transactions.
        const manualTotal = (!isToday && (isGlobal 
            ? database.db.prepare('SELECT totalValue, cashValue, assetValue FROM portfolio_history WHERE portfolioId IS NULL AND date = ?').get(dateStr)
            : database.db.prepare(`SELECT SUM(totalValue) as totalValue, SUM(cashValue) as cashValue, SUM(assetValue) as assetValue FROM portfolio_history WHERE portfolioId IN (${pIds.join(',')}) AND date = ?`).get(dateStr)));

        if (manualTotal && manualTotal.totalValue !== null) {
            dayValue = manualTotal.totalValue;
            dayCash = manualTotal.cashValue || 0;
            dayAssets = manualTotal.assetValue || 0;
            // For profit, we still need netDeposits calculation to keep track of state
            for (const p of portfolios) {
                const state = portfolioStates[p.id];
                const dayTx = allTransactions.filter(t => t.portfolioId === p.id && t.date === dateStr);
                for (const t of dayTx) {
                    const amount = t.amount || 0;
                    if (t.type === 'DEPOSIT') state.netDeposits += amount;
                    else if (t.type === 'WITHDRAWAL') state.netDeposits -= amount;
                    
                    if (['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'].includes(t.type)) {
                        const ticker = t.assetTicker || 'CASH';
                        const assetMeta = assetMetadataCache[ticker];
                        dayEvents.push({ 
                            type: t.type, 
                            ticker: ticker, 
                            assetName: assetMeta ? assetMeta.name : ticker,
                            portfolioName: p.name, 
                            amount: t.amount || ((t.quantity || 0) * (t.price || 0)) 
                        });
                    }
                    // We still need to update holdings state to keep it consistent if manual record missing for next day
                    const qty = t.quantity || 0, price = t.price || 0, comm = t.commission || 0, tax = t.tax || 0, fx = t.exchangeRate || 1;
                    switch (t.type) {
                        case 'DEPOSIT':    state.cash += amount; break;
                        case 'WITHDRAWAL': state.cash -= amount; break;
                        case 'TAX':        state.cash -= amount; break;
                        case 'TRANSFER':   state.cash -= amount; break;
                        case 'DIVIDEND': {
                            const divAmt = (t.amount || (qty * price - comm - tax)) / fx;
                            state.cash += divAmt; 
                            break;
                        }
                        case 'BUY':
                            state.cash -= (t.amount || (qty * price + comm + tax)) / fx;
                            state.holdings[t.assetTicker] = (state.holdings[t.assetTicker] || 0) + qty;
                            break;
                        case 'SELL':
                            state.cash += (t.amount || (qty * price - comm - tax)) / fx;
                            state.holdings[t.assetTicker] = (state.holdings[t.assetTicker] || 0) - qty;
                            break;
                    }
                }
            }
            let totalNetDeps = 0;
            for (const p of portfolios) totalNetDeps += portfolioStates[p.id].netDeposits;
            dayProfit = dayValue - totalNetDeps;
        } else {
            for (const p of portfolios) {
                const state = portfolioStates[p.id];
                const dayTx = allTransactions.filter(t => t.portfolioId === p.id && t.date === dateStr);

                for (const t of dayTx) {
                    const qty = t.quantity || 0, price = t.price || 0, comm = t.commission || 0, tax = t.tax || 0, fx = t.exchangeRate || 1, amount = t.amount || 0;
                    if (t.assetTicker && price > 0) {
                        state.lastTxPrices[t.assetTicker] = price;
                    }
                    if (['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'].includes(t.type)) {
                        const ticker = t.assetTicker || 'CASH';
                        const assetMeta = assetMetadataCache[ticker];
                        dayEvents.push({ 
                            type: t.type, 
                            ticker: ticker, 
                            assetName: assetMeta ? assetMeta.name : ticker,
                            portfolioName: p.name, 
                            amount: t.amount || (qty * price) 
                        });
                    }
                    switch (t.type) {
                        case 'DEPOSIT':    state.cash += amount; state.netDeposits += amount; break;
                        case 'WITHDRAWAL': state.cash -= amount; state.netDeposits -= amount; break;
                        case 'TAX':        state.cash -= amount; break;
                        case 'TRANSFER':   state.cash -= amount; break;
                        case 'DIVIDEND': {
                            const divAmt = (t.amount || (qty * price - comm - tax)) / fx;
                            state.cash += divAmt; 
                            break;
                        }
                        case 'BUY':
                            state.cash -= (t.amount || (qty * price + comm + tax)) / fx;
                            state.holdings[t.assetTicker] = (state.holdings[t.assetTicker] || 0) + qty;
                            break;
                        case 'SELL':
                            state.cash += (t.amount || (qty * price - comm - tax)) / fx;
                            state.holdings[t.assetTicker] = (state.holdings[t.assetTicker] || 0) - qty;
                            break;
                    }
                }

                let pAssets = 0;
                for (const [ticker, shares] of Object.entries(state.holdings)) {
                    if (shares <= 0.0001) continue;
                    
                    let price = historicalPrices[ticker]?.[dateStr];
                    const isToday = dateStr === today.toISOString().split('T')[0];

                    // If price is missing (undefined, null, or 0), try to find a fallback
                    if (!price || price === 0) {
                        const isToday = dateStr === today.toISOString().split('T')[0];
                        const assetMeta = assetMetadataCache[ticker];

                        // Priority 1: If it's today, try live price from cache
                        if (isToday && assetMeta && assetMeta.currentPrice > 0) {
                            price = assetMeta.currentPrice;
                        }

                        // Priority 2: Try most recent historical price (critical for weekends/holidays)
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
                            price = state.lastTxPrices[ticker];
                        }

                        // Priority 4: Final fallback to current asset price ONLY if no historical data at all
                        if (!price || price === 0) {
                            if (assetMeta && assetMeta.currentPrice > 0) price = assetMeta.currentPrice;
                            else if (assetMeta && assetMeta.type === 'Bond') price = 100.0; // Simulated par value for bonds
                            else price = 0;
                        }
                    }

                    const assetMeta = assetMetadataCache[ticker];
                    const aCurr = assetMeta ? assetMeta.currency : 'EUR';
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
                dayValue += (state.cash + pAssets);
                dayProfit += (state.cash + pAssets - state.netDeposits);
                dayCash += state.cash;
                dayAssets += pAssets;
            }
        }

        dataPoints.push({
            date: dateStr,
            value: Math.round(dayValue),
            profit: Math.round(dayProfit),
            cash: Math.round(dayCash),
            assets: Math.round(dayAssets),
            events: dayEvents
        });
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dataPoints;
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
                    const totalCost = (t.quantity * t.price + t.commission + t.tax) / t.exchangeRate;
                    holdingsMap[t.assetTicker].shares += t.quantity;
                    holdingsMap[t.assetTicker].costBasis += totalCost;

                } else if (t.type === 'SELL' && t.assetTicker) {
                    const sellQty = t.quantity;
                    const h = holdingsMap[t.assetTicker] || { shares: 0, costBasis: 0 };
                    const pmc = h.shares > 0 ? h.costBasis / h.shares : 0;
                    const sellCostBasis = sellQty * pmc;
                    const proceeds = (t.quantity * t.price - t.commission - t.tax) / t.exchangeRate;
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
                        totalProceeds: t.amount,
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

        // 1. Performance Comparison (Normalized to 100)
        const benchmarks = ['^GSPC', 'URTH']; // S&P 500, MSCI World
        
        // Helper to fetch normalized history
        const fetchHistory = async (ticker) => {
            try {
                const chart = await yahooFinance.chart(ticker, {
                    period1: dateStrStart,
                    period2: dateStrEnd,
                    interval: '1mo'
                });
                if (chart && chart.quotes && chart.quotes.length > 0) {
                    const firstPrice = chart.quotes[0].adjclose || chart.quotes[0].close;
                    return chart.quotes.map(h => ({
                        date: new Date(h.date).toISOString().split('T')[0].substring(0, 7), // YYYY-MM
                        value: ((h.adjclose || h.close) / firstPrice) * 100,
                        price: h.adjclose || h.close
                    }));
                }
            } catch (e) {
                console.warn(`Failed benchmark/asset fetch for ${ticker}:`, e.message);
            }
            return [];
        };

        // Identify all unique tickers needed for historical valuation
        const uniqueTickers = [...new Set(allTransactions.filter(t => t.assetTicker).map(t => t.assetTicker))];
        
        // Fetch benchmark and asset histories in parallel
        const histories = await Promise.all([
            fetchHistory('^GSPC'),
            fetchHistory('URTH'),
            ...uniqueTickers.map(t => fetchHistory(t))
        ]);

        const sp500 = histories[0];
        const msci = histories[1];
        const assetHistories = {};
        uniqueTickers.forEach((t, i) => {
            assetHistories[t] = Object.fromEntries(histories[i+2].map(h => [h.date, h.price]));
        });

        // Calculate Portfolio Monthly Performance (Global and Individual)
        const portfolioPerformance = [];
        const individualPortfolios = Object.fromEntries(portfolios.map(p => [p.id, { id: p.id, name: p.name, history: [], metrics: {} }]));
        
        let tempDate = new Date(startDate);
        tempDate.setDate(1); // Start of month

        while (tempDate <= today) {
            const currentMonthStr = tempDate.toISOString().substring(0, 7);
            const lastDayOfMonth = new Date(tempDate.getFullYear(), tempDate.getMonth() + 1, 0).toISOString().split('T')[0];
            
            // Calculate value at last day of month
            let totalVal = 0;
            let netDep = 0;

            for (const p of portfolios) {
                let cash = p.initialCash;
                let pNetDep = p.initialCash;
                const holdings = {};
                const pTxs = allTransactions.filter(t => t.portfolioId === p.id && t.date <= lastDayOfMonth);

                for (const t of pTxs) {
                    const qty = t.quantity || 0;
                    const amount = t.amount || 0;
                    const fx = t.exchangeRate || 1;
                    switch (t.type) {
                        case 'DEPOSIT': cash += amount; pNetDep += amount; break;
                        case 'WITHDRAWAL': cash -= amount; pNetDep -= amount; break;
                        case 'TAX': cash -= amount; break;
                        case 'DIVIDEND': cash += (t.amount || (qty * (t.price || 0) - (t.commission || 0) - (t.tax || 0))) / fx; break;
                        case 'BUY': cash -= (t.amount || (qty * (t.price || 0) + (t.commission || 0) + (t.tax || 0))) / fx; holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + qty; break;
                        case 'SELL': cash += (t.amount || (qty * (t.price || 0) - (t.commission || 0) - (t.tax || 0))) / fx; holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - qty; break;
                    }
                }

                let assetVal = 0;
                for (const [ticker, shares] of Object.entries(holdings)) {
                    if (shares <= 0.0001) continue;
                    const a = assetMap[ticker];
                    if (a) {
                        // Use historical price if available, otherwise fallback to current price
                        const histPrice = assetHistories[ticker]?.[currentMonthStr] || a.currentPrice;
                        const lastFxTx = pTxs.filter(tx => tx.assetTicker === ticker && tx.exchangeRate).at(-1);
                        const rate = lastFxTx ? lastFxTx.exchangeRate : 1;
                        assetVal += shares * (histPrice / rate);
                    }
                }
                const pVal = cash + assetVal;
                totalVal += pVal;
                netDep += pNetDep;
                individualPortfolios[p.id].history.push({ date: currentMonthStr, value: pVal, netDeposits: pNetDep });
            }

            portfolioPerformance.push({ date: currentMonthStr, value: totalVal, netDeposits: netDep });
            tempDate.setMonth(tempDate.getMonth() + 1);
        }

        // Normalize portfolio performance using ROI-based Index (100 base)
        const normalizeHistory = (history) => history.map(p => {
            const roi = p.netDeposits > 0 ? (p.value / p.netDeposits) - 1 : 0;
            return {
                date: p.date,
                value: (1 + roi) * 100,
                absoluteValue: p.value,
                profit: p.value - p.netDeposits,
                netDeposits: p.netDeposits
            };
        });

        const normalizedGlobal = normalizeHistory(portfolioPerformance);
        
        // Normalize each individual portfolio and calculate its metrics
        const riskFreeMonthly = 0.002;
        for (const pid in individualPortfolios) {
            const p = individualPortfolios[pid];
            p.history = normalizeHistory(p.history);
            
            const last = p.history[p.history.length - 1];
            const roi = last.netDeposits > 0 ? (last.absoluteValue / last.netDeposits) - 1 : 0;
            
            p.metrics = {
                totalROI: roi,
                currentValue: last.absoluteValue,
                contribution: normalizedGlobal[normalizedGlobal.length-1].absoluteValue > 0 ? 
                    (last.absoluteValue / normalizedGlobal[normalizedGlobal.length-1].absoluteValue) : 0,
                sharpeRatio: (() => {
                    const returns = [];
                    for (let i = 1; i < p.history.length; i++) {
                        const pVal = p.history[i-1].value;
                        const cVal = p.history[i].value;
                        if (pVal > 0) returns.push((cVal / pVal) - 1);
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
        const currentTotalValue = normalizedGlobal[normalizedGlobal.length - 1]?.absoluteValue || 0;
        const currentNetDeposits = normalizedGlobal[normalizedGlobal.length - 1]?.netDeposits || 0;
        const totalROI = currentNetDeposits > 0 ? (currentTotalValue / currentNetDeposits) - 1 : 0;

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
                const total = (t.quantity * t.price + (t.type==='BUY'?1:-1)*(t.commission+t.tax)) / (t.exchangeRate||1);
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

        res.json({
            performance: {
                portfolio: normalizedGlobal,
                individual: individualPortfolios,
                sp500,
                msci
            },
            diversification,
            dividends,
            metrics: {
                totalROI,
                annualizedROI: Math.pow(1 + totalROI, 1 / (portfolioPerformance.length / 12)) - 1,
                bestAsset: bestAsset.ticker === '-' ? '-' : `${bestAsset.name} (${bestAsset.ticker})`,
                sharpeRatio: (() => {
                    // Monthly returns for Sharpe Ratio based on ROI Index
                    const returns = [];
                    for (let i = 1; i < normalizedGlobal.length; i++) {
                        const prev = normalizedGlobal[i-1].value;
                        const curr = normalizedGlobal[i].value;
                        if (prev > 0) {
                            returns.push((curr / prev) - 1);
                        }
                    }
                    if (returns.length < 2) return 0;
                    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                    const stdDev = Math.sqrt(returns.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / returns.length);
                    return stdDev > 0 ? (mean - riskFreeMonthly) / stdDev : 0;
                })()
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
        if (!fs.existsSync(LOG_FILE)) return res.json([]);
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.trim().split('\n');
        // Return last 100 lines
        res.json(lines.slice(-100).reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/market-status', (req, res) => {
    res.json(getMarketStatus());
});

app.get('/api/market/movers', (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        // Assets that have a quote from today and have a non-zero current price
        // Order by absolute changePercent descending
        const rows = database.db.prepare(`
            SELECT DISTINCT a.* FROM assets a
            JOIN transactions t ON a.ticker = t.ticker
            WHERE a.ticker != 'CASH' 
            AND a.quoteDate = ? 
            AND a.currentPrice > 0
            ORDER BY ABS(a.changePercent) DESC
            LIMIT 10
        `).all(today);
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

app.post('/api/reset-data', (req, res) => {
    database.db.prepare(`DELETE FROM transactions`).run();
    database.db.prepare(`DELETE FROM portfolios`).run();
    database.db.prepare(`DELETE FROM assets`).run();
    database.db.prepare(`DELETE FROM notifications`).run();
    database.db.prepare(`DELETE FROM portfolio_history`).run();
    console.log('All application data has been reset.');
    clearPerformanceCache();
    res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// STATIC FILES  (must come AFTER all API routes)
// ════════════════════════════════════════════════════════════════════════════

app.use(express.static(path.join(__dirname, '../public')));

// ─── HTML page routes ───────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/portfolio', (req, res) => res.sendFile(path.join(__dirname, '../public/portfolio_detail.html')));
app.get('/market',    (req, res) => res.sendFile(path.join(__dirname, '../public/market_overview.html')));
app.get('/reports',   (req, res) => res.sendFile(path.join(__dirname, '../public/reports.html')));
app.get('/history',   (req, res) => res.sendFile(path.join(__dirname, '../public/history.html')));
app.get('/dividend',  (req, res) => res.sendFile(path.join(__dirname, '../public/dividend.html')));
app.get('/settings',  (req, res) => res.sendFile(path.join(__dirname, '../public/settings.html')));

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

async function updateMarketData(force = false) {
    const status = getMarketStatus();
    if (!force && !status.anyOpen) {
        logger.info('Skipping automatic market update: all markets are closed.');
        return;
    }
    const assets = database.db.prepare(`SELECT * FROM assets`).all();
    if (assets.length === 0) return;
    logger.info(`Updating market data for ${assets.length} assets...`);

    for (const asset of assets) {
        if (!asset.ticker || asset.ticker === 'CASH') continue;
        if (asset.isManual === 1 && (!asset.dataSource || asset.dataSource === 'YF')) continue;
        
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
                        currency: asset.currency,
                        exchange: asset.exchange,
                        country: asset.country,
                        quoteDate: new Date().toISOString().split('T')[0]
                    };
                }
            } else {
                // Default Yahoo Finance
                const metadata = await fetchAssetMetadata(asset.ticker);
                if (!metadata) {
                    throw new Error(`No metadata found for ${asset.ticker}`);
                }
                
                updateData = {
                    price: metadata.currentPrice || asset.currentPrice,
                    change: metadata.changePercent || asset.changePercent,
                    changeValue: metadata.changeValue || 0,
                    pe: metadata.pe || asset.pe,
                    name: metadata.name || asset.name,
                    currency: metadata.currency || asset.currency,
                    exchange: metadata.exchange || asset.exchange,
                    country: metadata.country || asset.country,
                    quoteDate: metadata.quoteDate || new Date().toISOString().split('T')[0]
                };
            }

            if (updateData) {
                database.db.prepare(`
                    UPDATE assets
                    SET currentPrice=?, changePercent=?, changeValue=?, pe=?, name=?, currency=?, exchange=?, country=?, quoteDate=?, lastUpdateError=NULL, updatedAt=datetime('now')
                    WHERE ticker=?
                `).run(
                    updateData.price,
                    updateData.change,
                    updateData.changeValue,
                    updateData.pe,
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
                        WHERE ticker = ? AND type = 'TARGET' AND date > datetime('now','-1 day')
                    `).get(asset.ticker);
                    if (!existing) {
                        database.db.prepare(`
                            INSERT INTO notifications (type, title, message, ticker)
                            VALUES (?, ?, ?, ?)
                        `).run('TARGET', 'Target Price Reached', `${asset.ticker} has reached your target of ${asset.targetPrice} (Price: ${newPrice})`, asset.ticker);
                    }
                }
                if (asset.stopLoss > 0 && newPrice <= asset.stopLoss) {
                    const existing = database.db.prepare(`
                        SELECT id FROM notifications 
                        WHERE ticker = ? AND type = 'STOP' AND date > datetime('now','-1 day')
                    `).get(asset.ticker);
                    if (!existing) {
                        database.db.prepare(`
                            INSERT INTO notifications (type, title, message, ticker)
                            VALUES (?, ?, ?, ?)
                        `).run('STOP', 'Stop Loss Triggered', `${asset.ticker} has dropped to your stop loss of ${asset.stopLoss} (Price: ${newPrice})`, asset.ticker);
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
    logger.info(`Market data update cycle completed.`);
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
let lastUpdateTime = Date.now();
let lastBackupDate = ''; // 'YYYY-MM-DD'
let lastSnapshotDate = ''; // 'YYYY-MM-DD'

setInterval(async () => {
    const settings = database.getSettings();
    const now = new Date();
    
    // 1. Market Data Update
    const freqMs = parseInt(settings.updateFrequency || 5) * 60 * 1000;
    if (freqMs > 0 && Date.now() - lastUpdateTime >= freqMs) {
        updateMarketData();
        lastUpdateTime = Date.now();
    }

    // 2. Scheduled Backups
    const backupFreq = settings.backupFrequency; // 'Daily', 'Weekly', 'None'
    const todayStr = now.toISOString().split('T')[0];
    
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
            const portfolios = database.db.prepare(`SELECT id FROM portfolios`).all();
            portfolios.forEach(p => database.savePortfolioSnapshot(p.id));
            database.savePortfolioSnapshot(null); // Global snapshot
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

app.listen(PORT, '0.0.0.0', () => {
    logger.info(`FolioTrack server running on port ${PORT}`);
    logger.info(`Database: ${require('./database').db.name}`);
});
