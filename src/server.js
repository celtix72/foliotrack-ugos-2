'use strict';

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const dotenv     = require('dotenv');
const YahooFinance = require('yahoo-finance2').default;
const axios      = require('axios');

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
const database = require('./database');
const backupManager = require('./backup_manager');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CACHING LAYER ──────────────────────────────────────────────────────────
const historicalPricesCache = {}; // { ticker: { date: price } }
let performanceResultsCache = {}; // { cacheKey: { data, timestamp } }
let eurUsdCache = { rate: 1.08, timestamp: 0 };
const EUR_USD_TTL = 5 * 60 * 1000; // 5 minutes

async function getEurUsdRate() {
    if (Date.now() - eurUsdCache.timestamp < EUR_USD_TTL) {
        return eurUsdCache.rate;
    }
    try {
        const quote = await yahooFinance.quote('EURUSD=X');
        if (quote && quote.regularMarketPrice) {
            eurUsdCache = { rate: quote.regularMarketPrice, timestamp: Date.now() };
            return eurUsdCache.rate;
        }
    } catch (err) {
        console.warn('Failed to fetch EUR/USD rate:', err.message);
    }
    return eurUsdCache.rate; // Return last known rate on failure
}

function clearPerformanceCache() {
    performanceResultsCache = {};
    console.log('Performance result cache invalidated.');
}

// ─── BORSA ITALIANA SCRAPER ──────────────────────────────────────────────────
async function B_ITA(isin, assetType = '') {
    const searchUrl = `https://www.borsaitaliana.it/borsa/search/scheda.html?code=${isin}&lang=it`;
    try {
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
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

        // Variation: look for percentage pattern
        let variation = null;
        const varMatch = html.match(/([+-]?[\d,.]+)\s*%\s*<\/span>/i);
        if (varMatch && varMatch[1]) {
            variation = parseFloat(varMatch[1].replace(',', '.'));
        }

        return { 
            success: !!price, 
            price, 
            variation, 
            url: finalUrl,
            isin
        };
    } catch (err) {
        console.error(`B_ITA Scraper error for ${isin}:`, err.message);
        return { success: false, error: err.message, url: searchUrl, isin };
    }
}
// ────────────────────────────────────────────────────────────────────────────

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// ────────────────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════════════════════════════════════
// ASSETS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/assets', (req, res) => {
    // We don't want to show the pseudo 'CASH' asset in monitored lists or watchlist
    res.json(database.db.prepare("SELECT * FROM assets WHERE ticker != 'CASH' AND (type != 'Cash' OR type IS NULL) ORDER BY ticker ASC").all());
});

app.post('/api/assets/manual-update', (req, res) => {
    const { ticker, price, date, type, country } = req.body;
    if (!ticker) return res.status(400).send('Ticker is required');
    
    database.db.prepare(`
        UPDATE assets 
        SET currentPrice = ?, updatedAt = ?, isManual = 1, changePercent = 0,
            type = COALESCE(?, type), country = COALESCE(?, country)
        WHERE ticker = ?
    `).run(
        parseFloat(price), 
        date || new Date().toISOString().split('T')[0], 
        type || null,
        country || null,
        ticker
    );
    
    database.recalculateAll();
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

app.post('/api/assets', async (req, res) => {
    try {
        const { ticker, name, type, currency, exchange, pe, currentPrice, changePercent } = req.body;

        let assetData = {
            id:           ticker || `MANUAL-${Date.now()}`,
            ticker:       ticker || '',
            name:         name   || ticker || 'Unknown',
            type:         type   || 'Other',
            exchange:     exchange || 'Unknown',
            currency:     currency || 'USD',
            currentPrice: parseFloat(currentPrice || 0),
            changePercent:parseFloat(changePercent || 0),
            pe:           pe ? parseFloat(pe) : null
        };

        if (ticker) {
            const quote = await yahooFinance.quote(ticker).catch(() => null);
            let country = null;
            try {
                const summary = await yahooFinance.quoteSummary(ticker, { modules: ["summaryProfile"] });
                country = summary.summaryProfile ? summary.summaryProfile.country : null;
            } catch (e) { console.warn(`Could not fetch summaryProfile for ${ticker}`); }

            if (quote) {
                assetData = {
                    id:           ticker,
                    ticker,
                    name:         name || quote.shortName || quote.longName || ticker,
                    type:         type || (quote.quoteType === 'EQUITY' ? 'Stock' : quote.quoteType || 'Other'),
                    exchange:     exchange || quote.fullExchangeName || quote.exchange || 'Unknown',
                    currency:     currency || quote.currency || 'USD',
                    currentPrice: parseFloat(currentPrice || quote.regularMarketPrice || 0),
                    changePercent:parseFloat(changePercent || quote.regularMarketChangePercent || 0),
                    pe:           pe ? parseFloat(pe) : (quote.trailingPE || quote.forwardPE || null),
                    country:      country
                };
            }
        }

        const existing = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(assetData.ticker);
        if (existing && assetData.ticker) return res.status(400).send('Asset already in monitoring list');

        database.db.prepare(`
            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            assetData.id, assetData.ticker, assetData.name, assetData.type,
            assetData.exchange, assetData.currency, assetData.currentPrice,
            assetData.changePercent, assetData.pe, assetData.country
        );

        res.status(201).json(assetData);
    } catch (err) {
        console.error('Add asset error:', err);
        res.status(500).send('Failed to add asset: ' + err.message);
    }
});

app.put('/api/assets/:id', (req, res) => {
    const existing = database.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Asset not found');

    const updated = { ...existing, ...req.body };
    database.db.prepare(`
        UPDATE assets SET name=?, type=?, exchange=?, currency=?, currentPrice=?, changePercent=?, pe=?, targetPrice=?, stopLoss=?, updatedAt=datetime('now')
        WHERE id=?
    `).run(updated.name, updated.type, updated.exchange, updated.currency,
           updated.currentPrice, updated.changePercent, updated.pe, 
           updated.targetPrice || null, updated.stopLoss || null, req.params.id);

    res.json(database.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id));
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
            // 2. Fetch from Yahoo Finance if not in DB
            try {
                const quote = await yahooFinance.quote(normalizedTicker);
                if (quote) {
                    database.db.prepare(`
                        INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, updatedAt, inWatchlist)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)
                    `).run(
                        normalizedTicker,
                        normalizedTicker,
                        quote.shortName || quote.longName || normalizedTicker,
                        quote.quoteType === 'EQUITY' ? 'Stock' : quote.quoteType || 'Other',
                        quote.fullExchangeName || quote.exchange || 'Unknown',
                        quote.currency || 'USD',
                        quote.regularMarketPrice || 0,
                        quote.regularMarketChangePercent || 0,
                        quote.trailingPE || null
                    );
                    asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(normalizedTicker);
                } else {
                    return res.status(404).send('Ticker not found on Yahoo Finance');
                }
            } catch (yfErr) {
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
    const asset = database.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
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

app.get('/api/portfolios', (req, res) => {
    const rows = database.db.prepare(`SELECT * FROM portfolios ORDER BY createdAt ASC`).all();
    res.json(rows);
});

// Helper to calculate holdings for a portfolio
async function calculateHoldings(portfolio, transactions, liveRate) {
    const lots        = {};   
    const openMap     = {};   

    for (const t of transactions) {
        const qty    = t.quantity     || 0;
        const price  = t.price        || 0;
        const comm   = t.commission   || 0;
        const tax    = t.tax          || 0;
        const fx     = t.exchangeRate || 1;

        if (t.type === 'BUY' && t.assetTicker) {
            const totalCost    = (qty * price + comm + tax) / fx;
            const costPerShare = qty > 0 ? totalCost / qty : 0;
            if (!lots[t.assetTicker])    lots[t.assetTicker] = [];
            if (!openMap[t.assetTicker]) openMap[t.assetTicker] = { shares: 0, totalCostInPCurr: 0 };
            
            lots[t.assetTicker].push({ qty, costPerShare });
            openMap[t.assetTicker].shares           += qty;
            openMap[t.assetTicker].totalCostInPCurr += totalCost;
        }

        if (t.type === 'SELL' && t.assetTicker) {
            let remaining  = qty;
            const lotsCopy = lots[t.assetTicker] || [];
            let costBasis  = 0;
            while (remaining > 0 && lotsCopy.length > 0) {
                const lot  = lotsCopy[0];
                const used = Math.min(lot.qty, remaining);
                costBasis  += used * lot.costPerShare;
                lot.qty    -= used;
                remaining  -= used;
                if (lot.qty <= 0) lotsCopy.shift();
            }
            lots[t.assetTicker] = lotsCopy;
            if (openMap[t.assetTicker]) {
                openMap[t.assetTicker].shares           -= qty;
                openMap[t.assetTicker].totalCostInPCurr -= costBasis;
                if (openMap[t.assetTicker].shares <= 0.0001) delete openMap[t.assetTicker];
            }
        }
    }

    const holdings = Object.entries(openMap)
        .filter(([, h]) => h.shares > 0.0001)
        .map(([ticker, h]) => {
            const asset  = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
            const curPx  = asset ? asset.currentPrice : 0;
            const rate = (asset && asset.currency === 'USD' && portfolio.currency === 'EUR') ? liveRate : 1;
            const curPxP = (asset && asset.currency !== portfolio.currency) ? curPx / rate : curPx;
            const curVal = h.shares * curPxP;
            return {
                ticker, 
                shares: h.shares,
                type: asset ? asset.type : 'Stock',
                currentValue: curVal,
                currency: portfolio.currency
            };
        });
    return holdings;
}

app.get('/api/analytics/global-allocation', async (req, res) => {
    try {
        const portfolios = database.db.prepare('SELECT * FROM portfolios').all();
        const liveRate = await getEurUsdRate();
        const typeMap = {};
        let totalValue = 0;

        for (const p of portfolios) {
            const transactions = database.db.prepare('SELECT * FROM transactions WHERE portfolioId = ?').all(p.id);
            const holdings = await calculateHoldings(p, transactions, liveRate);
            
            // For global, we assume all portfolios are in the same base for visualization (e.g. EUR)
            // If they are in different currencies, we'd need FX conversion here.
            // For now, most users use the same base or we assume EUR as default.
            for (const h of holdings) {
                const tp = h.type || 'Other';
                typeMap[tp] = (typeMap[tp] || 0) + h.currentValue;
                totalValue += h.currentValue;
            }
        }

        const allocation = Object.entries(typeMap).map(([type, value]) => ({
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

app.get('/api/portfolios/:id', async (req, res) => {
    const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio non trovato' });

    const liveRate = await getEurUsdRate();

    const transactions = database.db.prepare(`
        SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC
    `).all(req.params.id);

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
            const totalCost    = (qty * price + comm + tax) / fx;
            const costPerShare = qty > 0 ? totalCost / qty : 0;
            if (!lots[t.assetTicker])    lots[t.assetTicker] = [];
            if (!openMap[t.assetTicker]) openMap[t.assetTicker] = { shares: 0, totalCostInPCurr: 0, totalCostInAssetCurr: 0 };
            
            const totalCostAssetCurr = (qty * price + comm + tax);
            const costPerShareAsset  = qty > 0 ? totalCostAssetCurr / qty : 0;
            
            lots[t.assetTicker].push({ qty, costPerShare, costPerShareAssetCurr: costPerShareAsset });
            openMap[t.assetTicker].shares              += qty;
            openMap[t.assetTicker].totalCostInPCurr    += totalCost;
            openMap[t.assetTicker].totalCostInAssetCurr += totalCostAssetCurr;
        }

        if (t.type === 'SELL' && t.assetTicker) {
            let remaining  = qty;
            const proceeds = (qty * price - comm - tax) / fx;
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
            const net = (qty && price) ? ((qty * price - comm - tax) / fx) : (amount / fx);
            dividends.push({ ticker: t.assetTicker, date: t.date, year, amount: net, tax: tax / fx });
        }
    }

    // Open holdings enriched with current price & unrealized P/L
    const holdings = Object.entries(openMap)
        .filter(([, h]) => h.shares > 0.0001)
        .map(([ticker, h]) => {
            const asset  = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
            const curPx  = asset ? asset.currentPrice : 0;
            
            // Use live rate for USD conversion if the portfolio is in EUR
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
                unrealizedGainPct: Math.round(uGainPct * 100) / 100
            };
        });

    // Asset allocation by type, currency, and country
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
        type, value: Math.round(value * 100) / 100,
        percent: totalAssetsValue > 0 ? Math.round((value / totalAssetsValue) * 1000) / 10 : 0
    })).sort((a, b) => b.value - a.value);

    const currencyAllocation = Object.entries(currMap).map(([type, value]) => ({
        type, value: Math.round(value * 100) / 100,
        percent: totalAssetsValue > 0 ? Math.round((value / totalAssetsValue) * 1000) / 10 : 0
    })).sort((a, b) => b.value - a.value);

    const countryAllocation = Object.entries(counMap).map(([type, value]) => ({
        type, value: Math.round(value * 100) / 100,
        percent: totalAssetsValue > 0 ? Math.round((value / totalAssetsValue) * 1000) / 10 : 0
    })).sort((a, b) => b.value - a.value);

    // Closed positions
    const closedPositions = Object.values(closedByKey).map(c => {
        const asset = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(c.ticker);
        const gPct = c.totalCostBasis > 0 ? Math.round((c.realizedGain / c.totalCostBasis) * 10000) / 100 : 0;
        return { ...c, name: asset ? asset.name : c.ticker, gainPct: gPct,
            totalProceeds: Math.round(c.totalProceeds * 100) / 100,
            totalCostBasis: Math.round(c.totalCostBasis * 100) / 100,
            realizedGain: Math.round(c.realizedGain * 100) / 100 };
    }).sort((a, b) => parseInt(b.year) - parseInt(a.year) || b.realizedGain - a.realizedGain);

    // Dividends by year
    const divYearMap = {};
    let totalDividends = 0;
    for (const d of dividends) {
        if (!divYearMap[d.year]) divYearMap[d.year] = { year: d.year, total: 0, items: [] };
        divYearMap[d.year].total += d.amount;
        divYearMap[d.year].items.push(d);
        totalDividends += d.amount;
    }
    const dividendGroups = Object.values(divYearMap).sort((a, b) => parseInt(b.year) - parseInt(a.year));

    res.json({ 
        ...portfolio, 
        transactions, 
        holdings, 
        allocation, 
        currencyAllocation,
        countryAllocation,
        closedPositions, 
        dividendGroups, 
        totalDividends: Math.round(totalDividends * 100) / 100 
    });
});


app.post('/api/portfolios', (req, res) => {
    console.log('POST /api/portfolios:', req.body);
    const { name, currency, startDate, initialCash } = req.body;

    if (!name) return res.status(400).json({ error: 'Portfolio name is required' });

    const cash  = parseFloat(initialCash || 0);
    const start = startDate || new Date().toISOString().split('T')[0];

    const result = database.db.prepare(`
        INSERT INTO portfolios (name, currency, startDate, initialCash, currentCash, totalValue)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, currency || 'EUR', start, cash, cash, cash);

    const created = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(result.lastInsertRowid);
    console.log('Created portfolio:', created);
    clearPerformanceCache();
    res.status(201).json(created);
});

app.put('/api/portfolios/:id', (req, res) => {
    const existing = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Portfolio not found');

    const { name, currency, startDate, initialCash } = req.body;
    database.db.prepare(`
        UPDATE portfolios SET name=?, currency=?, startDate=?, initialCash=? WHERE id=?
    `).run(
        name       || existing.name,
        currency   || existing.currency,
        startDate  || existing.startDate,
        parseFloat(initialCash != null ? initialCash : existing.initialCash),
        req.params.id
    );

    database.recalculatePortfolio(req.params.id);
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

app.post('/api/portfolios/:id/reconcile', (req, res) => {
    const { actualCash, date } = req.body;
    const portfolioId = req.params.id;

    if (actualCash == null) return res.status(400).send('actualCash is required');

    // 1. Ensure current data is accurate
    database.recalculatePortfolio(portfolioId);
    
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

    // 3. Final recalculation
    database.recalculatePortfolio(portfolioId);
    if (typeof clearPerformanceCache === 'function') clearPerformanceCache();

    res.json({ 
        message: 'Reconciliation successful', 
        diff, 
        newCash: actualCash 
    });
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

app.post('/api/transactions', (req, res) => {
    const { portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount, destinationPortfolioId } = req.body;

    if (!portfolioId) return res.status(400).send('portfolioId is required');

    const result = database.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        parseInt(portfolioId), type, assetTicker || '',
        date || new Date().toISOString().split('T')[0],
        parseFloat(quantity || 0), parseFloat(price || 0),
        parseFloat(commission || 0), parseFloat(tax || 0),
        parseFloat(exchangeRate || 1), parseFloat(amount || 0)
    );

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
        database.recalculatePortfolio(destinationPortfolioId);
    }

    database.recalculatePortfolio(portfolioId);
    clearPerformanceCache();

    res.status(201).json(database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(result.lastInsertRowid));
});

app.delete('/api/transactions/:id', (req, res) => {
    const row = database.db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Transaction not found');
    
    database.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(req.params.id);
    database.recalculatePortfolio(row.portfolioId);
    
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
        const quote = await yahooFinance.quote(ticker);
        if (!quote) return res.json({ valid: false });

        let country = null;
        let detailedType = quote.quoteType === 'EQUITY' ? 'Azionario' : (quote.quoteType || 'Altro');

        try {
            const summary = await yahooFinance.quoteSummary(ticker, { 
                modules: ["summaryProfile", "assetProfile", "fundProfile"] 
            });

            if (summary.summaryProfile && summary.summaryProfile.country) {
                country = summary.summaryProfile.country;
            } else if (summary.assetProfile && summary.assetProfile.country) {
                country = summary.assetProfile.country;
            }

            if (quote.quoteType === 'ETF') {
                const fp = summary.fundProfile;
                const nameStr = (quote.longName || quote.shortName || "").toLowerCase();
                
                if (fp && fp.categoryName) {
                    detailedType = `ETF ${fp.categoryName}`;
                } else if (nameStr.includes('bond') || nameStr.includes('obbligazion')) {
                    detailedType = 'ETF Obbligazionario';
                } else if (nameStr.includes('equity') || nameStr.includes('azionario') || nameStr.includes('world') || nameStr.includes('stock')) {
                    detailedType = 'ETF Azionario';
                } else if (nameStr.includes('monetary') || nameStr.includes('monetario') || nameStr.includes('cash') || nameStr.includes('rate')) {
                    detailedType = 'ETF Monetario';
                } else {
                    detailedType = 'ETF';
                }
            }
        } catch (e) {
            console.error("Metadata fetch failed for", ticker, e.message);
        }

        res.json({
            valid: true,
            ticker,
            name: quote.shortName || quote.longName || ticker,
            currency: quote.currency || 'USD',
            exchange: quote.fullExchangeName || quote.exchange || '',
            type: detailedType,
            country: country || 'N/A',
            currentPrice: quote.regularMarketPrice || 0,
            changePercent: quote.regularMarketChangePercent || 0,
            pe: quote.trailingPE || quote.forwardPE || null
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
app.post('/api/transactions/bulk', (req, res) => {
    const { portfolioId, transactions } = req.body;
    if (!portfolioId || !transactions || !transactions.length) {
        return res.status(400).send('portfolioId and transactions[] required');
    }

    const portfolio = database.db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return res.status(404).send('Portfolio not found');

    const insertTx = database.db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAsset = database.db.prepare(`
        INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const results = [];
    const importMany = database.db.transaction((txs) => {
        for (const t of txs) {
            try {
                // Auto-add asset to watchlist if not already there
                if (t.assetTicker) {
                    database.db.prepare(`
                        INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, updatedAt)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                    `).run(
                        t.assetTicker, 
                        t.assetTicker, 
                        t.assetName || t.assetTicker,
                        t.assetType || 'Stock', 
                        t.assetExchange || '',
                        t.assetCurrency || 'USD', 
                        t.assetPrice || 0,
                        0, 
                        t.assetPe || null,
                        t.assetCountry || 'N/A',
                        0
                    );
                }

                insertTx.run(
                    parseInt(portfolioId),
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
                results.push({ ok: true, ticker: t.assetTicker, date: t.date });
            } catch (err) {
                results.push({ ok: false, ticker: t.assetTicker, error: err.message });
            }
        }
    });

    importMany(transactions);
    database.recalculatePortfolio(portfolioId);
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

app.get('/api/analytics/portfolio-performance/:id', async (req, res) => {
    try {
        const { range } = req.query; // 1M, 3M, 6M, 1Y, ALL
        const portfolioId = req.params.id;

        const cacheKey = `portfolio_${portfolioId}_${range}`;
        const cached = performanceResultsCache[cacheKey];
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(cached.data);
        }
        console.log(`Cache miss for ${cacheKey}. Calculating...`);

        const portfolio = database.db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
        if (!portfolio) return res.status(404).send('Portfolio not found');

        const transactions = database.db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC').all(portfolioId);
        
        const today = new Date();
        let startDate;
        
        switch (range) {
            case '1M': startDate = new Date(today); startDate.setMonth(today.getMonth() - 1); break;
            case '3M': startDate = new Date(today); startDate.setMonth(today.getMonth() - 3); break;
            case '6M': startDate = new Date(today); startDate.setMonth(today.getMonth() - 6); break;
            case '1Y': startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 1); break;
            default:   startDate = new Date(portfolio.startDate || (transactions.length > 0 ? transactions[0].date : today));
        }

        const uniqueTickers = [...new Set(transactions.map(t => t.assetTicker).filter(Boolean))];
        const historicalPrices = {}; 

        // Fetch historical data for all tickers
        for (const ticker of uniqueTickers) {
            try {
                if (historicalPricesCache[ticker]) {
                    historicalPrices[ticker] = historicalPricesCache[ticker];
                    continue;
                }

                const qStart = (transactions.find(t => t.assetTicker === ticker)?.date) || startDate.toISOString().split('T')[0];
                const chartResult = await yahooFinance.chart(ticker, {
                    period1: qStart,
                    period2: today.toISOString().split('T')[0],
                    interval: '1d'
                });
                
                if (chartResult && chartResult.quotes) {
                    historicalPrices[ticker] = Object.fromEntries(
                        chartResult.quotes
                            .filter(h => h.date)
                            .map(h => [new Date(h.date).toISOString().split('T')[0], h.adjclose || h.close || 0])
                    );
                } else {
                    historicalPrices[ticker] = {};
                }
                // Save to global market cache
                historicalPricesCache[ticker] = historicalPrices[ticker];

            } catch (err) {
                console.warn(`Failed to fetch history for ${ticker}:`, err.message);
                historicalPrices[ticker] = {};
            }
        }

        const dataPoints = [];
        let currentDate = new Date(startDate);
        
        while (currentDate <= today) {
            const dateStr = currentDate.toISOString().split('T')[0];
            
            // 1. Reconstruct state on this date
            let cash = portfolio.initialCash;
            let netDeposits = portfolio.initialCash;
            const holdings = {};
            const events = [];

            for (const t of transactions) {
                if (t.date > dateStr) break;

                const qty    = t.quantity     || 0;
                const price  = t.price        || 0;
                const comm   = t.commission   || 0;
                const tax    = t.tax          || 0;
                const fx     = t.exchangeRate || 1;
                const amount = t.amount       || 0;

                if (t.date === dateStr && ['BUY', 'SELL', 'DIVIDEND'].includes(t.type)) {
                    events.push({
                        type: t.type,
                        ticker: t.assetTicker,
                        amount: amount || (qty * price) // fallback for buy/sell
                    });
                }

                switch (t.type) {
                    case 'DEPOSIT':    
                        cash += amount; 
                        netDeposits += amount;
                        break;
                    case 'WITHDRAWAL': 
                        cash -= amount; 
                        netDeposits -= amount;
                        break;
                    case 'TAX':        cash -= amount; break;
                    case 'DIVIDEND':   cash += (amount || (qty * price - comm - tax)) / fx; break;
                    case 'BUY':
                        cash -= (qty * price + comm + tax) / fx;
                        holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + qty;
                        break;
                    case 'SELL':
                        cash += (qty * price - comm - tax) / fx;
                        holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - qty;
                        break;
                }
            }

            // 2. Calculate asset value on this date
            let assetValue = 0;
            for (const [ticker, shares] of Object.entries(holdings)) {
                if (shares <= 0.0001) continue;
                
                let price = 0;
                const tickerPrices = historicalPrices[ticker] || {};
                price = tickerPrices[dateStr];

                if (price === undefined) {
                    const availableDates = Object.keys(tickerPrices).filter(d => d < dateStr).sort();
                    if (availableDates.length > 0) {
                        price = historicalPrices[ticker][availableDates[availableDates.length - 1]];
                    } else {
                        const asset = database.db.prepare('SELECT currentPrice FROM assets WHERE ticker = ?').get(ticker);
                        price = asset ? asset.currentPrice : 0;
                    }
                }

                const lastFxTx = transactions.filter(t => t.assetTicker === ticker && t.date <= dateStr && t.exchangeRate).at(-1);
                const rate = lastFxTx ? lastFxTx.exchangeRate : 1;
                assetValue += shares * (price / rate);
            }

            dataPoints.push({
                date: dateStr,
                value: Math.round((cash + assetValue) * 100) / 100,
                profit: Math.round((cash + assetValue - netDeposits) * 100) / 100,
                cash: Math.round(cash * 100) / 100,
                assets: Math.round(assetValue * 100) / 100,
                events: events
            });

            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Save to performance cache
        performanceResultsCache[cacheKey] = {
            data: dataPoints,
            timestamp: Date.now()
        };

        res.json(dataPoints);
    } catch (err) {
        console.error('Portfolio performance error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/global-performance', async (req, res) => {
    try {
        const { range } = req.query; // 1W, 1M, 3M, 1Y, ALL

        const cacheKey = `global_${range}`;
        const cached = performanceResultsCache[cacheKey];
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(cached.data);
        }
        console.log(`Cache miss for ${cacheKey}. Calculating...`);

        const portfolios = database.db.prepare('SELECT * FROM portfolios').all();
        if (portfolios.length === 0) return res.json([]);

        const allTransactions = database.db.prepare('SELECT * FROM transactions ORDER BY date ASC').all();
        const today = new Date();
        let startDate;

        switch (range) {
            case '1W': startDate = new Date(today); startDate.setDate(today.getDate() - 7); break;
            case '1M': startDate = new Date(today); startDate.setMonth(today.getMonth() - 1); break;
            case '3M': startDate = new Date(today); startDate.setMonth(today.getMonth() - 3); break;
            case '1Y': startDate = new Date(today); startDate.setFullYear(today.getFullYear() - 1); break;
            default:   startDate = new Date(allTransactions.length > 0 ? allTransactions[0].date : today);
        }

        const uniqueTickers = [...new Set(allTransactions.map(t => t.assetTicker).filter(Boolean))];
        const historicalPrices = {};

        // Fetch historical data for all unique tickers
        for (const ticker of uniqueTickers) {
            try {
                if (historicalPricesCache[ticker]) {
                    historicalPrices[ticker] = historicalPricesCache[ticker];
                    continue;
                }

                const qStart = (allTransactions.find(t => t.assetTicker === ticker)?.date) || startDate.toISOString().split('T')[0];
                const chartResult = await yahooFinance.chart(ticker, {
                    period1: qStart,
                    period2: today.toISOString().split('T')[0],
                    interval: '1d'
                });
                if (chartResult && chartResult.quotes) {
                    historicalPrices[ticker] = Object.fromEntries(
                        chartResult.quotes
                            .filter(h => h.date)
                            .map(h => [new Date(h.date).toISOString().split('T')[0], h.adjclose || h.close || 0])
                    );
                } else {
                    historicalPrices[ticker] = {};
                }
                historicalPricesCache[ticker] = historicalPrices[ticker];
            } catch (err) {
                console.warn(`Failed to fetch history for ${ticker}:`, err.message);
                historicalPrices[ticker] = {};
            }
        }

        const dataPoints = [];
        let currentDate = new Date(startDate);

        while (currentDate <= today) {
            const dateStr = currentDate.toISOString().split('T')[0];
            let globalTotalValue = 0;
            let globalNetDeposits = 0;

            for (const p of portfolios) {
                let cash = p.initialCash;
                let pNetDeposits = p.initialCash;
                const holdings = {};
                const pTransactions = allTransactions.filter(t => t.portfolioId === p.id && t.date <= dateStr);

                for (const t of pTransactions) {
                    const qty    = t.quantity     || 0;
                    const price  = t.price        || 0;
                    const comm   = t.commission   || 0;
                    const tax    = t.tax          || 0;
                    const fx     = t.exchangeRate || 1;
                    const amount = t.amount       || 0;

                    switch (t.type) {
                    case 'DEPOSIT':    
                        cash += amount; 
                        pNetDeposits += amount;
                        break;
                    case 'WITHDRAWAL': 
                        cash -= amount; 
                        pNetDeposits -= amount;
                        break;
                        case 'TAX':        cash -= amount; break;
                        case 'DIVIDEND':   cash += (amount || (qty * price - comm - tax)) / fx; break;
                        case 'BUY':
                            cash -= (qty * price + comm + tax) / fx;
                            holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + qty;
                            break;
                        case 'SELL':
                            cash += (qty * price - comm - tax) / fx;
                            holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - qty;
                            break;
                    }
                }

                let assetValue = 0;
                for (const [ticker, shares] of Object.entries(holdings)) {
                    if (shares <= 0.0001) continue;
                    let price = 0;
                    const tickerPrices = historicalPrices[ticker] || {};
                    price = tickerPrices[dateStr];

                    if (price === undefined) {
                        const availableDates = Object.keys(tickerPrices).filter(d => d < dateStr).sort();
                        if (availableDates.length > 0) {
                            price = historicalPrices[ticker][availableDates[availableDates.length - 1]];
                        } else {
                            const asset = database.db.prepare('SELECT currentPrice FROM assets WHERE ticker = ?').get(ticker);
                            price = asset ? asset.currentPrice : 0;
                        }
                    }
                    const lastFxTx = pTransactions.filter(t => t.assetTicker === ticker && t.exchangeRate).at(-1);
                    const rate = lastFxTx ? lastFxTx.exchangeRate : 1;
                    assetValue += shares * (price / rate);
                }

                globalTotalValue += (cash + assetValue);
                globalNetDeposits += pNetDeposits;
            }

            dataPoints.push({
                date: dateStr,
                value: Math.round(globalTotalValue * 100) / 100,
                profit: Math.round((globalTotalValue - globalNetDeposits) * 100) / 100
            });

            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Save to performance cache
        performanceResultsCache[cacheKey] = {
            data: dataPoints,
            timestamp: Date.now()
        };

        res.json(dataPoints);
    } catch (err) {
        console.error('Global performance error:', err);
        res.status(500).json({ error: err.message });
    }
});

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
                        case 'DIVIDEND': cash += (amount || (qty * (t.price || 0) - (t.commission || 0) - (t.tax || 0))) / fx; break;
                        case 'BUY': cash -= (qty * (t.price || 0) + (t.commission || 0) + (t.tax || 0)) / fx; holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + qty; break;
                        case 'SELL': cash += (qty * (t.price || 0) - (t.commission || 0) - (t.tax || 0)) / fx; holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - qty; break;
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

async function updateMarketData() {
    const assets = database.db.prepare(`SELECT * FROM assets`).all();
    if (assets.length === 0) return;
    console.log(`Updating market data for ${assets.length} assets...`);

    for (const asset of assets) {
        if (!asset.ticker || asset.ticker === 'CASH' || asset.isManual === 1) continue;
        try {
            const quote = await yahooFinance.quote(asset.ticker);
            if (!quote) {
                console.warn(`No quote for ${asset.ticker}, marking as manual.`);
                database.db.prepare(`UPDATE assets SET isManual=1 WHERE ticker=?`).run(asset.ticker);
                continue;
            }

            let country = asset.country;
            if (!country) {
                try {
                    const summary = await yahooFinance.quoteSummary(asset.ticker, { modules: ["summaryProfile"] });
                    country = summary.summaryProfile ? summary.summaryProfile.country : null;
                } catch (e) { /* ignore summaryProfile errors */ }
            }

            database.db.prepare(`
                UPDATE assets
                SET currentPrice=?, changePercent=?, pe=?, name=?, currency=?, exchange=?, country=?, updatedAt=datetime('now')
                WHERE ticker=?
            `).run(
                quote.regularMarketPrice      || asset.currentPrice,
                quote.regularMarketChangePercent || asset.changePercent,
                quote.trailingPE || quote.forwardPE || asset.pe,
                quote.shortName  || quote.longName  || asset.name,
                quote.currency   || asset.currency,
                quote.fullExchangeName || quote.exchange || asset.exchange,
                country,
                asset.ticker
            );

            // Alert Checks
            const newPrice = quote.regularMarketPrice || asset.currentPrice;
            if (asset.targetPrice > 0 && newPrice >= asset.targetPrice) {
                // Check if already notified in last 24h
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
        } catch (err) {
            console.error(`Failed to update ${asset.ticker}:`, err.message);
            if (err.message.includes('Not Found') || err.message.includes('404')) {
                database.db.prepare(`UPDATE assets SET isManual=1 WHERE ticker=?`).run(asset.ticker);
            }
        }
    }
    database.recalculateAll();
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
let lastUpdateTime = Date.now();
let lastBackupDate = ''; // 'YYYY-MM-DD'

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
            console.log(`Starting scheduled backup (${backupFreq})...`);
            try {
                await backupManager.createBackup(true);
                lastBackupDate = todayStr;
            } catch (e) {
                console.error('Scheduled backup failed:', e);
            }
        }
    }
}, 60_000);

// Run once at startup
updateMarketData();

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    console.log(`FolioTrack server running on port ${PORT}`);
    console.log(`Database: ${require('./database').db.name}`);
});
