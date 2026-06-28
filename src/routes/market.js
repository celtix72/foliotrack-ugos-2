const express = require('express');

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

router.get('/market/indices', requireAuth, async (req, res) => {
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


// Get market movers (assets with today's quotes, sorted by % change)
router.get('/market/movers', requireAuth, async (req, res) => {
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
router.get('/validate-ticker', requireAuth, async (req, res) => {
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
        const results = await yahooFinance.search(query);
        // Filter out any result that has "CASH" as symbol to avoid confusion
        const filtered = (results.quotes || []).filter(q => q.symbol !== 'CASH');
        res.json(filtered);
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
        lastUpdate: globalLastMarketUpdate
    });
});



router.post('/market-sync', requireAuth, requireAdmin, async (req, res) => {
    try {
        logger.info('Manual market sync triggered.');
        updateMarketData(true); // force = true
        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
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
