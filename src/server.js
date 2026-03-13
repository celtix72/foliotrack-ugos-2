'use strict';

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const dotenv     = require('dotenv');
const YahooFinance = require('yahoo-finance2').default;

dotenv.config();

const yahooFinance = new YahooFinance();
const { db, getSettings, setSetting, recalculatePortfolio, recalculateAll } = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CACHING LAYER ──────────────────────────────────────────────────────────
const historicalPricesCache = {}; // { ticker: { date: price } }
let performanceResultsCache = {}; // { cacheKey: { data, timestamp } }

function clearPerformanceCache() {
    performanceResultsCache = {};
    console.log('Performance result cache invalidated.');
}

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// ────────────────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════════════════════════════════════
// ASSETS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/assets', (req, res) => {
    const rows = db.prepare(`SELECT * FROM assets ORDER BY name ASC`).all();
    res.json(rows);
});

app.get('/api/assets/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Asset not found');
    res.json(row);
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
                    pe:           pe ? parseFloat(pe) : (quote.trailingPE || quote.forwardPE || null)
                };
            }
        }

        const existing = db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(assetData.ticker);
        if (existing && assetData.ticker) return res.status(400).send('Asset already in monitoring list');

        db.prepare(`
            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            assetData.id, assetData.ticker, assetData.name, assetData.type,
            assetData.exchange, assetData.currency, assetData.currentPrice,
            assetData.changePercent, assetData.pe
        );

        res.status(201).json(assetData);
    } catch (err) {
        console.error('Add asset error:', err);
        res.status(500).send('Failed to add asset: ' + err.message);
    }
});

app.put('/api/assets/:id', (req, res) => {
    const existing = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Asset not found');

    const updated = { ...existing, ...req.body };
    db.prepare(`
        UPDATE assets SET name=?, type=?, exchange=?, currency=?, currentPrice=?, changePercent=?, pe=?, updatedAt=datetime('now')
        WHERE id=?
    `).run(updated.name, updated.type, updated.exchange, updated.currency,
           updated.currentPrice, updated.changePercent, updated.pe, req.params.id);

    res.json(db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id));
});

app.delete('/api/assets/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Asset not found');
    db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id);
    res.json(row);
});

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIOS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/portfolios', (req, res) => {
    const rows = db.prepare(`SELECT * FROM portfolios ORDER BY createdAt ASC`).all();
    res.json(rows);
});

app.get('/api/portfolios/:id', (req, res) => {
    const portfolio = db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!portfolio) return res.status(404).send('Portfolio not found');

    const transactions = db.prepare(
        `SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`
    ).all(req.params.id);

    // FIFO lots per ticker
    const lots        = {};   // { ticker: [{qty, costPerShare}] }
    const openMap     = {};   // { ticker: {shares, totalCostInPCurr} }
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
            if (!openMap[t.assetTicker]) openMap[t.assetTicker] = { shares: 0, totalCostInPCurr: 0 };
            lots[t.assetTicker].push({ qty, costPerShare });
            openMap[t.assetTicker].shares           += qty;
            openMap[t.assetTicker].totalCostInPCurr += totalCost;
        }

        if (t.type === 'SELL' && t.assetTicker) {
            let remaining  = qty;
            const proceeds = (qty * price - comm - tax) / fx;
            const lotsCopy = lots[t.assetTicker] || [];
            let costBasis  = 0;
            while (remaining > 0 && lotsCopy.length > 0) {
                const lot  = lotsCopy[0];
                const used = Math.min(lot.qty, remaining);
                costBasis += used * lot.costPerShare;
                lot.qty   -= used;
                remaining -= used;
                if (lot.qty <= 0) lotsCopy.shift();
            }
            lots[t.assetTicker] = lotsCopy;
            if (openMap[t.assetTicker]) {
                openMap[t.assetTicker].shares           -= qty;
                openMap[t.assetTicker].totalCostInPCurr -= costBasis;
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
            const asset  = db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
            const curPx  = asset ? asset.currentPrice : 0;
            const lastFx = transactions.filter(t => t.assetTicker === ticker && t.exchangeRate).at(-1);
            const rate   = lastFx ? lastFx.exchangeRate : 1;
            const curPxP = (asset && asset.currency !== portfolio.currency) ? curPx / rate : curPx;
            const curVal = h.shares * curPxP;
            const avgCost = h.shares > 0 ? h.totalCostInPCurr / h.shares : 0;
            const uGain  = curVal - h.totalCostInPCurr;
            const uGainPct = h.totalCostInPCurr > 0 ? (uGain / h.totalCostInPCurr) * 100 : 0;
            return {
                ticker, shares: Math.round(h.shares * 10000) / 10000,
                name: asset ? asset.name : ticker,
                currentPrice: curPx, currentPriceInPCurr: curPxP,
                currency: asset ? asset.currency : portfolio.currency,
                type: asset ? asset.type : 'Stock',
                totalCostInPCurr: Math.round(h.totalCostInPCurr * 100) / 100,
                avgCost: Math.round(avgCost * 10000) / 10000,
                currentValue: Math.round(curVal * 100) / 100,
                unrealizedGain: Math.round(uGain * 100) / 100,
                unrealizedGainPct: Math.round(uGainPct * 100) / 100
            };
        });

    // Asset allocation by type
    const totalAssetsValue = holdings.reduce((s, h) => s + h.currentValue, 0);
    const allocMap = {};
    for (const h of holdings) { const tp = h.type || 'Other'; allocMap[tp] = (allocMap[tp] || 0) + h.currentValue; }
    const allocation = Object.entries(allocMap).map(([type, value]) => ({
        type, value: Math.round(value * 100) / 100,
        percent: totalAssetsValue > 0 ? Math.round((value / totalAssetsValue) * 1000) / 10 : 0
    })).sort((a, b) => b.value - a.value);

    // Closed positions
    const closedPositions = Object.values(closedByKey).map(c => {
        const asset = db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(c.ticker);
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

    res.json({ ...portfolio, transactions, holdings, allocation, closedPositions, dividendGroups, totalDividends: Math.round(totalDividends * 100) / 100 });
});


app.post('/api/portfolios', (req, res) => {
    console.log('POST /api/portfolios:', req.body);
    const { name, currency, startDate, initialCash } = req.body;

    if (!name) return res.status(400).json({ error: 'Portfolio name is required' });

    const cash  = parseFloat(initialCash || 0);
    const start = startDate || new Date().toISOString().split('T')[0];

    const result = db.prepare(`
        INSERT INTO portfolios (name, currency, startDate, initialCash, currentCash, totalValue)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, currency || 'EUR', start, cash, cash, cash);

    const created = db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(result.lastInsertRowid);
    console.log('Created portfolio:', created);
    clearPerformanceCache();
    res.status(201).json(created);
});

app.put('/api/portfolios/:id', (req, res) => {
    const existing = db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).send('Portfolio not found');

    const { name, currency, startDate, initialCash } = req.body;
    db.prepare(`
        UPDATE portfolios SET name=?, currency=?, startDate=?, initialCash=? WHERE id=?
    `).run(
        name       || existing.name,
        currency   || existing.currency,
        startDate  || existing.startDate,
        parseFloat(initialCash != null ? initialCash : existing.initialCash),
        req.params.id
    );

    recalculatePortfolio(req.params.id);
    clearPerformanceCache();
    res.json(db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id));
});

app.delete('/api/portfolios/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Portfolio not found');
    // ON DELETE CASCADE removes transactions automatically
    db.prepare(`DELETE FROM portfolios WHERE id = ?`).run(req.params.id);
    console.log(`Deleted portfolio ${req.params.id}`);
    clearPerformanceCache();
    res.json(row);
});

// ════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/transactions', (req, res) => {
    const { portfolioId } = req.query;
    if (portfolioId) {
        return res.json(db.prepare(`SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`).all(portfolioId));
    }
    res.json(db.prepare(`SELECT * FROM transactions ORDER BY date ASC`).all());
});

app.post('/api/transactions', (req, res) => {
    const { portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount } = req.body;

    if (!portfolioId) return res.status(400).send('portfolioId is required');

    const result = db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        parseInt(portfolioId), type, assetTicker || '',
        date || new Date().toISOString().split('T')[0],
        parseFloat(quantity || 0), parseFloat(price || 0),
        parseFloat(commission || 0), parseFloat(tax || 0),
        parseFloat(exchangeRate || 1), parseFloat(amount || 0)
    );

    recalculatePortfolio(portfolioId);
    clearPerformanceCache();

    res.status(201).json(db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(result.lastInsertRowid));
});

app.delete('/api/transactions/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Transaction not found');
    db.prepare(`DELETE FROM transactions WHERE id = ?`).run(req.params.id);
    recalculatePortfolio(row.portfolioId);
    clearPerformanceCache();
    res.json(row);
});

// Validate a ticker against Yahoo Finance (used by bulk import)
app.get('/api/validate-ticker', async (req, res) => {
    const { ticker } = req.query;
    if (!ticker) return res.status(400).send('ticker required');
    try {
        const quote = await yahooFinance.quote(ticker);
        if (!quote) return res.json({ valid: false });
        res.json({
            valid: true,
            ticker,
            name: quote.shortName || quote.longName || ticker,
            currency: quote.currency || 'USD',
            exchange: quote.fullExchangeName || quote.exchange || '',
            type: quote.quoteType === 'EQUITY' ? 'Stock' : (quote.quoteType || 'Other'),
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

    const portfolio = db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return res.status(404).send('Portfolio not found');

    const insertTx = db.prepare(`
        INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, commission, tax, exchangeRate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAsset = db.prepare(`
        INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const results = [];
    const importMany = db.transaction((txs) => {
        for (const t of txs) {
            try {
                // Auto-add asset to watchlist if not already there and we have data
                if (t.assetTicker && t.assetName) {
                    insertAsset.run(
                        t.assetTicker, t.assetTicker, t.assetName,
                        t.assetType || 'Stock', t.assetExchange || '',
                        t.assetCurrency || 'USD', t.assetPrice || 0,
                        0, t.assetPe || null
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
    recalculatePortfolio(portfolioId);
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
    res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
    for (const [key, value] of Object.entries(req.body)) {
        setSetting(key, value);
    }
    res.json(getSettings());
});

// ════════════════════════════════════════════════════════════════════════════
// ASSET SEARCH
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/asset-search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).send('query is required');
    try {
        const results = await yahooFinance.search(query);
        res.json(results.quotes);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).send('Search failed');
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

        const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(portfolioId);
        if (!portfolio) return res.status(404).send('Portfolio not found');

        const transactions = db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC').all(portfolioId);
        
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
                const hist = await yahooFinance.historical(ticker, {
                    period1: qStart,
                    period2: today.toISOString().split('T')[0],
                    interval: '1d'
                });
                
                historicalPrices[ticker] = Object.fromEntries(
                    hist.map(h => [new Date(h.date).toISOString().split('T')[0], h.adjClose || h.close])
                );
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
            const holdings = {};

            for (const t of transactions) {
                if (t.date > dateStr) break;

                const qty    = t.quantity     || 0;
                const price  = t.price        || 0;
                const comm   = t.commission   || 0;
                const tax    = t.tax          || 0;
                const fx     = t.exchangeRate || 1;
                const amount = t.amount       || 0;

                switch (t.type) {
                    case 'DEPOSIT':    cash += amount; break;
                    case 'WITHDRAWAL': cash -= amount; break;
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
                
                let price = historicalPrices[ticker][dateStr];
                if (price === undefined) {
                    const availableDates = Object.keys(historicalPrices[ticker]).filter(d => d < dateStr).sort();
                    if (availableDates.length > 0) {
                        price = historicalPrices[ticker][availableDates[availableDates.length - 1]];
                    } else {
                        const asset = db.prepare('SELECT currentPrice FROM assets WHERE ticker = ?').get(ticker);
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
                cash: Math.round(cash * 100) / 100,
                assets: Math.round(assetValue * 100) / 100
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

        const portfolios = db.prepare('SELECT * FROM portfolios').all();
        if (portfolios.length === 0) return res.json([]);

        const allTransactions = db.prepare('SELECT * FROM transactions ORDER BY date ASC').all();
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
                const hist = await yahooFinance.historical(ticker, {
                    period1: qStart,
                    period2: today.toISOString().split('T')[0],
                    interval: '1d'
                });
                historicalPrices[ticker] = Object.fromEntries(
                    hist.map(h => [new Date(h.date).toISOString().split('T')[0], h.adjClose || h.close])
                );
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
            let globalTotal = 0;

            for (const p of portfolios) {
                let cash = p.initialCash;
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
                        case 'DEPOSIT':    cash += amount; break;
                        case 'WITHDRAWAL': cash -= amount; break;
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
                    let price = historicalPrices[ticker][dateStr];
                    if (price === undefined) {
                        const availableDates = Object.keys(historicalPrices[ticker]).filter(d => d < dateStr).sort();
                        if (availableDates.length > 0) {
                            price = historicalPrices[ticker][availableDates[availableDates.length - 1]];
                        } else {
                            const asset = db.prepare('SELECT currentPrice FROM assets WHERE ticker = ?').get(ticker);
                            price = asset ? asset.currentPrice : 0;
                        }
                    }
                    const lastFxTx = pTransactions.filter(t => t.assetTicker === ticker && t.exchangeRate).at(-1);
                    const rate = lastFxTx ? lastFxTx.exchangeRate : 1;
                    assetValue += shares * (price / rate);
                }

                globalTotal += (cash + assetValue);
            }

            dataPoints.push({
                date: dateStr,
                value: Math.round(globalTotal * 100) / 100
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
        const portfolios = db.prepare('SELECT id, name, currency FROM portfolios').all();
        let allClosed = [];

        for (const p of portfolios) {
            const trans = db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC').all(p.id);
            const assets = db.prepare('SELECT * FROM assets').all();
            const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

            let holdingsMap = {}; // Tracks running shares and costBasis for WAC
            let closed = [];

            for (const t of trans) {
                if (!t.assetTicker) continue;
                
                if (t.type === 'BUY') {
                    if (!holdingsMap[t.assetTicker]) holdingsMap[t.assetTicker] = { shares: 0, costBasis: 0 };
                    // Cost basis includes fees and tax in portfolio currency
                    const totalCost = (t.quantity * t.price + t.commission + t.tax) / t.exchangeRate;
                    holdingsMap[t.assetTicker].shares += t.quantity;
                    holdingsMap[t.assetTicker].costBasis += totalCost;

                } else if (t.type === 'SELL') {
                    const sellQty = t.quantity;
                    const h = holdingsMap[t.assetTicker] || { shares: 0, costBasis: 0 };
                    
                    // PMC is the weighted average price of current holdings
                    const pmc = h.shares > 0 ? h.costBasis / h.shares : 0;
                    const sellCostBasis = sellQty * pmc;
                    
                    // Proceeds net of fees and tax in portfolio currency
                    const proceeds = (t.quantity * t.price - t.commission - t.tax) / t.exchangeRate;
                    const year = t.date.split('-')[0];
                    const gain = proceeds - sellCostBasis;
                    const gainPct = sellCostBasis > 0 ? ((gain / sellCostBasis) * 100).toFixed(2) : 0;
                    const asset = assetMap[t.assetTicker] || { name: t.assetTicker };

                    closed.push({
                        ticker: t.assetTicker,
                        name: asset.name,
                        year,
                        quantity: sellQty,
                        pmc: Math.round(pmc * 100) / 100,
                        totalProceeds: Math.round(proceeds * 100) / 100,
                        totalCostBasis: Math.round(sellCostBasis * 100) / 100,
                        realizedGain: Math.round(gain * 100) / 100,
                        gainPct,
                        portfolioName: p.name
                    });

                    // Update running holdings for future sells
                    if (holdingsMap[t.assetTicker]) {
                        holdingsMap[t.assetTicker].shares -= sellQty;
                        holdingsMap[t.assetTicker].costBasis -= sellCostBasis;
                        if (holdingsMap[t.assetTicker].shares <= 0.0001) {
                            delete holdingsMap[t.assetTicker];
                        }
                    }
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
        const portfolios = db.prepare('SELECT id, name, currency FROM portfolios').all();
        let allDividends = [];

        for (const p of portfolios) {
            const divs = db.prepare("SELECT * FROM transactions WHERE portfolioId = ? AND type = 'DIVIDEND'").all(p.id);
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

// ════════════════════════════════════════════════════════════════════════════
// RESET DATA
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/reset-data', (req, res) => {
    db.prepare(`DELETE FROM transactions`).run();
    db.prepare(`DELETE FROM portfolios`).run();
    db.prepare(`DELETE FROM assets`).run();
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
// MARKET DATA UPDATE  (runs on interval)
// ════════════════════════════════════════════════════════════════════════════

async function updateMarketData() {
    const assets = db.prepare(`SELECT * FROM assets`).all();
    if (assets.length === 0) return;
    console.log(`Updating market data for ${assets.length} assets...`);

    for (const asset of assets) {
        if (!asset.ticker) continue;
        try {
            const quote = await yahooFinance.quote(asset.ticker);
            if (!quote) continue;

            const isOpen = quote.marketState === 'REGULAR'
                        || asset.type === 'Crypto'
                        || asset.type === 'CRYPTOCURRENCY';
            if (!isOpen) continue;

            db.prepare(`
                UPDATE assets
                SET currentPrice=?, changePercent=?, pe=?, name=?, currency=?, exchange=?, updatedAt=datetime('now')
                WHERE ticker=?
            `).run(
                quote.regularMarketPrice      || asset.currentPrice,
                quote.regularMarketChangePercent || asset.changePercent,
                quote.trailingPE || quote.forwardPE || asset.pe,
                quote.shortName  || quote.longName  || asset.name,
                quote.currency   || asset.currency,
                quote.fullExchangeName || quote.exchange || asset.exchange,
                asset.ticker
            );
        } catch (err) {
            console.error(`Failed to update ${asset.ticker}:`, err.message);
        }
    }
    recalculateAll();
}

let lastUpdateTime = Date.now();
setInterval(() => {
    const settings = getSettings();
    const freqMs   = parseInt(settings.updateFrequency || 5) * 60 * 1000;
    if (Date.now() - lastUpdateTime >= freqMs) {
        updateMarketData();
        lastUpdateTime = Date.now();
    }
}, 60_000);

// Run once at startup
updateMarketData();

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`FolioTrack server running on port ${PORT}`);
    console.log(`Database: ${require('./database').db.name}`);
});
