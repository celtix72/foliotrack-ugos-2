const express = require('express');
const { isValidQuotePrice } = require('../utils/finance');
const {
    mapYahooToGoogleTicker,
    mapGoogleToYahooTicker,
    fetchGoogleFinanceQuote,
    resolveGoogleTicker
} = require('../services/googleFinance');

/**
 * Unified search helper querying both Google Finance and Yahoo Finance.
 * Cross-references tickers between both services.
 */
async function performUnifiedSearch(query, yf, bItaFn = null) {
    const raw = (query || '').trim();
    if (!raw || raw.length < 2) return [];

    const suggestions = [];
    const seenSymbols = new Set();

    // 0. If user typed an Italian/Euro bond ISIN (e.g. IT0005583486 or XS...)
    const isItIsin = (/^IT[0-9A-Z]{10}$/i.test(raw) || /^XS[0-9]{10}$/i.test(raw));
    if (isItIsin && typeof bItaFn === 'function') {
        try {
            const cleanIsin = raw.toUpperCase();
            const bRes = await bItaFn(cleanIsin, 'Bond');
            if (bRes && bRes.success && bRes.price > 0) {
                const sym = bRes.isin || cleanIsin;
                suggestions.push({
                    symbol: sym,
                    ticker: sym,
                    googleTicker: null,
                    name: bRes.name || `BTP ${sym}`,
                    exchange: `${bRes.price} EUR • XMIL (Borsa Italiana)`,
                    exchDisp: 'XMIL',
                    type: 'Bond',
                    quoteType: 'BOND',
                    currency: 'EUR',
                    price: bRes.price,
                    changePercent: bRes.variation || 0,
                    isRealtime: 1,
                    source: 'B_ITA',
                    isin: sym
                });
                seenSymbols.add(sym);
            }
        } catch (e) {}
    }

    // 1. If user typed a Google Finance ticker format (e.g. ENI:BIT, AAPL:NASDAQ, VWRL:AMS)
    if (raw.includes(':')) {
        try {
            const cleanG = raw.toUpperCase();
            const gf = await fetchGoogleFinanceQuote(cleanG);
            if (gf && gf.success && gf.price > 0) {
                const ySym = mapGoogleToYahooTicker(cleanG);
                const isEtf = (gf.name || '').toLowerCase().includes('etf') || (gf.name || '').toLowerCase().includes('ucits');
                const exchPart = cleanG.split(':')[1] || 'GF';
                suggestions.push({
                    symbol: ySym,
                    ticker: ySym,
                    googleTicker: cleanG,
                    name: gf.name || cleanG,
                    exchange: `${gf.currency} • ${exchPart} (Google Finance)`,
                    exchDisp: exchPart,
                    type: isEtf ? 'ETF' : 'Equity',
                    quoteType: isEtf ? 'ETF' : 'EQUITY',
                    currency: gf.currency || 'EUR',
                    price: gf.price,
                    isRealtime: gf.isRealtime ? 1 : 0,
                    source: 'GF'
                });
                seenSymbols.add(ySym.toUpperCase());
                seenSymbols.add(cleanG);
            }
        } catch (e) {}
    }

    // 2. Query Yahoo Finance in parallel
    try {
        const yfResults = await yf.search(raw).catch(() => ({ quotes: [] }));
        const quotes = (yfResults.quotes || []).filter(q => q.symbol && q.symbol !== 'CASH');

        for (const q of quotes) {
            const symUpper = q.symbol.toUpperCase();
            if (seenSymbols.has(symUpper)) continue;
            seenSymbols.add(symUpper);

            const gTicker = mapYahooToGoogleTicker(q.symbol, null, q.exchDisp || q.exch);

            suggestions.push({
                symbol: q.symbol,
                ticker: q.symbol,
                googleTicker: gTicker,
                name: q.shortname || q.longname || q.symbol,
                exchange: q.exchDisp || q.exch || '',
                exchDisp: q.exchDisp || q.exch || '',
                type: q.quoteType || 'Equity',
                quoteType: q.quoteType || 'EQUITY',
                currency: q.currency || ''
            });
        }
    } catch (e) {}

    // 3. Fallback: if no suggestions found yet, try candidate Google Finance resolution
    if (suggestions.length === 0 && !raw.includes(':') && /^[A-Za-z0-9.\-_]{1,10}$/.test(raw)) {
        try {
            const resolvedG = await resolveGoogleTicker(raw);
            if (resolvedG) {
                const gf = await fetchGoogleFinanceQuote(resolvedG);
                if (gf && gf.success && gf.price > 0) {
                    const ySym = mapGoogleToYahooTicker(resolvedG);
                    const isEtf = (gf.name || '').toLowerCase().includes('etf') || (gf.name || '').toLowerCase().includes('ucits');
                    const exchPart = resolvedG.split(':')[1] || 'GF';
                    suggestions.push({
                        symbol: ySym,
                        ticker: ySym,
                        googleTicker: resolvedG,
                        name: gf.name || resolvedG,
                        exchange: `${gf.currency} • ${exchPart} (Google Finance)`,
                        exchDisp: exchPart,
                        type: isEtf ? 'ETF' : 'Equity',
                        quoteType: isEtf ? 'ETF' : 'EQUITY',
                        currency: gf.currency || 'USD',
                        price: gf.price,
                        isRealtime: gf.isRealtime ? 1 : 0,
                        source: 'GF'
                    });
                }
            }
        } catch (e) {}
    }

    return suggestions;
}

/**
 * Market Router (search, indices, news, market status/sync)
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        requireAdmin,
        database,
        logger,
        yahooFinance,
        getEurUsdRate,
        getMarketStatus,
        isUSMarket,
        isAssetQuoteFromToday,
        fetchAssetMetadata,
        clearPerformanceCache,
        updateMarketData,
        syncNews,
        eurUsdCache,
        APP_VERSION,
        globalLastMarketUpdate,
        B_ITA,
    } = dependencies;

    const indicesCache = {};
    const INDICES_CACHE_TTL = 60 * 1000;

// ─── MARKET SEARCH API ───────────────────────────────────────────────────────

router.get('/market/search', requireAuth, async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    try {
        const suggestions = await performUnifiedSearch(q, yahooFinance, B_ITA);
        res.json(suggestions);
    } catch (err) {
        console.error('Search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Diagnostic scraper test for Borsa Italiana
router.get('/market/scrape-test', requireAuth, requireAdmin, async (req, res) => {
    const isin = (req.query.isin || '').trim().toUpperCase();
    const type = (req.query.type || 'obbligazioni').trim();
    if (!isin) return res.status(400).json({ success: false, error: 'ISIN is required' });
    try {
        const result = await B_ITA(isin, type);
        const formattedVariation = (result && result.variation !== undefined && result.variation !== null)
            ? `${result.variation >= 0 ? '+' : ''}${result.variation}%`
            : '0.0%';
        res.json({
            ...result,
            variation: formattedVariation,
            numericVariation: result?.variation ?? 0
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


router.get('/market/indices', requireAuth, async (req, res) => {
    const symbols = ['FTSEMIB.MI', 'BTC-USD', '^GSPC', '^IXIC'];
    const names = {
        'FTSEMIB.MI': 'FTSE MIB',
        'BTC-USD': 'BTC',
        '^GSPC': 'S&P 500',
        '^IXIC': 'NASDAQ'
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


// Get market movers (assets with today's quotes, sorted by % change)
router.get('/market/movers', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const todayStr = new Date().toISOString().split('T')[0];
        const marketStatus = getMarketStatus();
        const rate = await getEurUsdRate();
        
        // Return assets that have open positions for THIS user
        let rows = database.db.prepare(`
            SELECT a.*, t.balance as totalQuantity 
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
              AND IFNULL(a.type, '') NOT IN ('Liquidità', 'Conto Deposito', 'Buono Postale')
              AND a.ticker NOT LIKE 'CD_%'
              AND a.ticker NOT LIKE 'BP_%'
        `).all(userId);

        rows = rows.filter(a => {
            const isUS = isUSMarket(a);
            const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
            
            // Exclude if the market did not open today (stale intraday data)
            if (!openedToday) return false;

            const isToday = isAssetQuoteFromToday ? isAssetQuoteFromToday(a, isUS, openedToday, todayStr) : (a.quoteDate === todayStr);
            if (!isToday) return false;
            
            return Math.abs(a.changePercent) > 0;
        })
          .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
          .slice(0, 10).map(a => {
            const dailyGainLocal = (a.changeValue || 0) * (a.totalQuantity || 0);
            a.dailyGainEUR = (a.currency === 'USD') ? (dailyGainLocal / rate) : dailyGainLocal;
            return a;
        });

        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Validate a ticker against Yahoo Finance and Borsa Italiana
router.get('/validate-ticker', requireAuth, async (req, res) => {
    let ticker = (req.query.ticker || "").trim().toUpperCase();
    let isin = (req.query.isin || "").trim().toUpperCase();
    if (!ticker && !isin) return res.status(400).send('Ticker or ISIN required');

    // If ticker is an ISIN (e.g. IT0005583486 or XS...) and isin param wasn't passed, infer isin
    const tickerIsIsin = /^IT[0-9A-Z]{10}$/.test(ticker) || /^XS[0-9]{10}$/.test(ticker);
    if (!isin && tickerIsIsin) {
        isin = ticker;
    }

    if (ticker === 'CASH' || ticker.startsWith('CASH_')) {
        return res.json({
            valid: true,
            ticker,
            name: 'Liquidità',
            currency: 'EUR',
            exchange: 'CASH',
            type: 'Liquidità',
            currentPrice: 1,
            pe: null,
            country: 'Italy'
        });
    }

    if (ticker.startsWith('CD_')) {
        return res.json({
            valid: true,
            ticker,
            name: ticker,
            currency: 'EUR',
            exchange: 'MANUAL',
            type: 'Conto Deposito',
            currentPrice: 1,
            pe: null,
            country: 'Italy',
            dataSource: 'MANUAL'
        });
    }

    if (ticker.startsWith('BP_')) {
        return res.json({
            valid: true,
            ticker,
            name: ticker,
            currency: 'EUR',
            exchange: 'MANUAL',
            type: 'Buono Postale',
            currentPrice: 1,
            pe: null,
            country: 'Italy',
            dataSource: 'MANUAL'
        });
    }

    // BTP* tickers are virtual Italian bond labels — if ISIN is provided, query B_ITA for live quote
    if (ticker.startsWith('BTP')) {
        let livePrice = 0;
        let liveChange = 0;
        let bondName = ticker;
        if (isin && (/^IT[0-9A-Z]{10}$/.test(isin) || /^XS[0-9]{10}$/.test(isin)) && typeof B_ITA === 'function') {
            try {
                const bRes = await B_ITA(isin, 'Bond');
                if (bRes && bRes.success && bRes.price > 0) {
                    livePrice = bRes.price;
                    liveChange = bRes.variation || 0;
                    if (bRes.name) bondName = bRes.name;
                }
            } catch (e) {}
        }
        return res.json({
            valid: true,
            isBTP: true,
            ticker,
            name: bondName,
            currency: 'EUR',
            exchange: 'XMIL',
            type: 'Bond',
            currentPrice: livePrice,
            changePercent: liveChange,
            pe: null,
            country: 'Italy',
            dataSource: 'B_ITA',
            isin: isin || null
        });
    }

    let yTicker = ticker;
    let gTicker = req.query.googleTicker;
    if (ticker && ticker.includes(':')) {
        gTicker = ticker;
        yTicker = mapGoogleToYahooTicker(ticker);
    }

    try {
        let metadata = null;

        // If ISIN is provided or ticker itself is an Italian bond ISIN, query B_ITA directly
        const isItIsin = (isin && (/^IT[0-9A-Z]{10}$/.test(isin) || /^XS[0-9]{10}$/.test(isin))) || tickerIsIsin;
        if (isItIsin && typeof B_ITA === 'function') {
            const targetIsin = isin || ticker;
            try {
                const bResult = await B_ITA(targetIsin, 'Bond');
                if (bResult && bResult.success && bResult.price > 0) {
                    const priceValid = isValidQuotePrice(bResult.price, { ticker: yTicker || targetIsin, isin: targetIsin, type: 'Bond', dataSource: 'B_ITA' }).valid;
                    metadata = {
                        ticker: yTicker || targetIsin,
                        name: bResult.name || yTicker || targetIsin,
                        currentPrice: priceValid ? bResult.price : 0,
                        changePercent: priceValid ? (bResult.variation || 0) : 0,
                        quoteType: 'Bond',
                        type: 'Bond',
                        exchange: 'XMIL',
                        currency: 'EUR',
                        country: 'Italy',
                        dataSource: 'B_ITA',
                        isin: targetIsin
                    };
                }
            } catch (bErr) {
                logger.warn(`B_ITA validation error for ${targetIsin}: ${bErr.message}`);
            }
        }

        if (!metadata) {
            metadata = await fetchAssetMetadata(yTicker, gTicker);
        }

        // Fallback to ISIN if ticker fails or is just a label (like ROM39)
        if ((!metadata || yTicker.length < 3) && isin && isin.length >= 10 && !metadata && typeof B_ITA === 'function') {
            const isItIsinFallback = /^IT[0-9A-Z]{10}$/.test(isin) || /^XS[0-9]{10}$/.test(isin);
            if (isItIsinFallback) {
                const bResult = await B_ITA(isin, 'Bond');
                if (bResult && bResult.success) {
                    const priceValid = isValidQuotePrice(bResult.price, { ticker: yTicker, isin, type: 'Bond', dataSource: 'B_ITA' }).valid;
                    metadata = {
                        ticker: yTicker || isin,
                        name: bResult.name || yTicker || isin,
                        currentPrice: priceValid ? bResult.price : 0,
                        changePercent: priceValid ? (bResult.variation || 0) : 0,
                        quoteType: 'Bond',
                        type: 'Bond',
                        exchange: 'XMIL',
                        currency: 'EUR',
                        country: 'Italy',
                        dataSource: 'B_ITA',
                        isin: isin
                    };
                }
            }
        }

        if (!metadata) return res.json({ valid: false });

        res.json({
            valid: true,
            ...metadata,
            ticker: metadata.ticker || yTicker,
            googleTicker: metadata.googleTicker || gTicker
        });
    } catch {
        // Try search fallback
        try {
            const results = await performUnifiedSearch(ticker, yahooFinance, B_ITA);
            res.json({ valid: false, suggestions: results.slice(0, 5) });
        } catch {
            res.json({ valid: false, suggestions: [] });
        }
    }
});

// ════════════════════════════════════════════════════════════════════════════

router.get('/fx-rate', requireAuth, async (req, res) => {
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

router.get('/asset-search', requireAuth, async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).send('query is required');
    try {
        const results = await performUnifiedSearch(query, yahooFinance, B_ITA);
        res.json(results);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: err.message });
    }
});


router.get('/market/exchange-rate', requireAuth, async (req, res) => {
    try {
        const rate = await getEurUsdRate();
        res.json({ pair: 'EURUSD', rate, timestamp: eurUsdCache.timestamp });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch rate' });
    }
});

// ─── MARKET INDICES ────────────────────────────────────────────────────────────

router.get('/indices', requireAuth, async (req, res) => {
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

router.get('/market-status', (req, res) => {
    res.json({
        ...getMarketStatus(),
        lastUpdate: dependencies.globalLastMarketUpdate || globalLastMarketUpdate,
        isSyncing: Boolean(dependencies.isUpdatingMarketData),
        syncProgress: dependencies.marketUpdateProgress || { current: 0, total: 0 }
    });
});

router.post('/market-sync', requireAuth, async (req, res) => {
    try {
        const userId = req.user ? req.user.id : 'unknown';
        logger.info(`Manual market sync triggered by user ${userId}.`);
        const startTime = Date.now();
        await updateMarketData(true);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`Manual market sync completed in ${elapsed}s.`);
        res.json({ 
            success: true, 
            message: `Sincronizzazione completata in ${elapsed}s`,
            lastUpdate: dependencies.globalLastMarketUpdate || globalLastMarketUpdate
        });
    } catch (err) {
        logger.error('Error during manual market sync:', err);
        res.status(500).json({ error: err.message });
    }
});

// ══ PURGE PERFORMANCE HISTORY ══
router.post('/admin/purge-performance', requireAuth, (req, res) => {
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

router.get('/news', requireAuth, (req, res) => {
    try {
        const filter = req.query.filter; // 'portfolio' or undefined

        // Collect all tickers owned (portfolio) + watchlist for this user
        const portfolioTickers = database.db.prepare(`
            SELECT DISTINCT assetTicker AS ticker
            FROM transactions
            WHERE assetTicker IS NOT NULL AND assetTicker != 'CASH'
        `).all().map(r => r.ticker);

        const watchlistTickers = database.db.prepare(`
            SELECT DISTINCT ticker FROM user_watchlist WHERE user_id = ?
        `).all(req.user.id).map(r => r.ticker);

        const allTickers = [...new Set([...portfolioTickers, ...watchlistTickers])];

        let assetNames = [];
        if (allTickers.length > 0) {
            const placeholders = allTickers.map(() => '?').join(',');
            assetNames = database.db.prepare(
                `SELECT ticker, name FROM assets WHERE ticker IN (${placeholders})`
            ).all(...allTickers);
        }

        // Build match terms for filtering and tagging
        const matchTerms = [];
        for (const t of allTickers) {
            matchTerms.push({ value: t.split('.')[0].toLowerCase(), label: t });
        }
        for (const a of assetNames) {
            if (a.name && a.name.length > 2) {
                const cleanName = a.name.replace(/\b(SPA|INC|LLC|CORP|LTD|PLC|NV|S\.P\.A\.|S\.R\.L\.)\b/gi, '').trim().toLowerCase();
                if (cleanName.length > 2) {
                    matchTerms.push({ value: cleanName, label: a.ticker });
                }
            }
        }

        let rows = [];

        // Escape regex function
        const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        if (filter === 'portfolio') {
            if (matchTerms.length === 0) {
                return res.json([]);
            }

            // Fetch a larger batch to filter in memory for precise regex matching
            const recentNews = database.db.prepare(`
                SELECT * FROM news_articles 
                WHERE user_id = ? 
                ORDER BY pubDate DESC LIMIT 200
            `).all(req.user.id);

            // Filter using word boundaries
            rows = recentNews.filter(r => {
                const title = (r.title || '').toLowerCase();
                for (const term of matchTerms) {
                    const regex = new RegExp(`\\b${escapeRegExp(term.value)}\\b`, 'i');
                    if (regex.test(title)) return true;
                }
                return false;
            }).slice(0, 50);

        } else {
            // Default: all news
            rows = database.db.prepare('SELECT * FROM news_articles WHERE user_id = ? ORDER BY pubDate DESC LIMIT 50').all(req.user.id);
        }

        // Tag each row with matched tickers using precise word boundaries
        const taggedRows = rows.map(r => {
            const title = (r.title || '').toLowerCase();
            const matchedTags = new Set();
            for (const term of matchTerms) {
                const regex = new RegExp(`\\b${escapeRegExp(term.value)}\\b`, 'i');
                if (regex.test(title)) {
                    matchedTags.add(term.label);
                }
            }
            return { ...r, matchedTags: Array.from(matchedTags) };
        });

        res.json(taggedRows);
    } catch (err) {
        logger.error('/api/news error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/settings/news-sources', requireAuth, (req, res) => {
    try {
        const rows = database.db.prepare('SELECT * FROM news_sources WHERE user_id = ? ORDER BY created_at ASC').all(req.user.id);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/settings/news-sources', requireAuth, express.json(), (req, res) => {
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

router.put('/settings/news-sources/:id', requireAuth, express.json(), (req, res) => {
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

router.delete('/settings/news-sources/:id', requireAuth, (req, res) => {
    try {
        const stmt = database.db.prepare('DELETE FROM news_sources WHERE id = ? AND user_id = ?');
        stmt.run(req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



router.get('/news/sources', requireAuth, (req, res) => {
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

router.post('/news/sources', requireAuth, express.json(), (req, res) => {
    try {
        const { disabledSources } = req.body;
        if (!Array.isArray(disabledSources)) return res.status(400).json({ error: 'Must be an array' });
        database.setSetting('disabledNewsSources', JSON.stringify(disabledSources));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
    return router;
};
