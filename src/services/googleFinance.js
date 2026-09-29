const axios = require('axios');

// In-memory cache for Google Finance quotes (TTL: 45 seconds)
const _gfCache = new Map();
const CACHE_TTL_MS = 45000;

/**
 * Maps a Yahoo Finance ticker to the equivalent Google Finance format: {TICKER}:{EXCHANGE}
 *
 * Supports:
 * - Italian stocks/ETFs: ENI.MI -> ENI:BIT, ISP.MI -> ISP:BIT
 * - German stocks/ETFs: SAP.DE -> SAP:ETR, VWCE.DE -> VWCE:ETR
 * - French stocks/ETFs: AIR.PA -> AIR:EPA
 * - Dutch stocks/ETFs: ASML.AS -> ASML:AMS
 * - Spanish stocks/ETFs: IBE.MC -> IBE:BME
 * - UK stocks/ETFs: SHEL.L -> SHEL:LON
 * - US stocks/ETFs: AAPL -> AAPL:NASDAQ, KO -> KO:NYSE, VOO -> VOO:NYSEARCA, BRK-B -> BRK.B:NYSE
 * - Major Indices: FTSEMIB.MI -> FTSEMIB:INDEXBIT, ^GSPC -> .INX:INDEXSP, ^IXIC -> .IXIC:INDEXNASDAQ
 */
function mapYahooToGoogleTicker(ticker, customGoogleTicker = null, exchange = null) {
    if (customGoogleTicker && typeof customGoogleTicker === 'string' && customGoogleTicker.trim().length > 0) {
        return customGoogleTicker.trim();
    }
    if (!ticker || typeof ticker !== 'string') return null;

    const t = ticker.trim().toUpperCase();

    // Already in Google Finance format (e.g. TDIV:AMS, ENI:BIT, AAPL:NASDAQ)
    if (t.includes(':')) return t;

    // Specific Index mappings
    if (t === 'FTSEMIB.MI' || t === '^FTSEMIB') return 'FTSEMIB:INDEXBIT';
    if (t === '^GSPC') return '.INX:INDEXSP';
    if (t === '^IXIC') return '.IXIC:INDEXNASDAQ';
    if (t === '^STOXX50E') return 'INDEXSTOXX:SX5E';
    if (t === '^DJI') return '.DJI:INDEXDJX';

    // European suffix mappings
    if (t.endsWith('.MI')) return `${t.slice(0, -3)}:BIT`;
    if (t.endsWith('.DE')) return `${t.slice(0, -3)}:ETR`;
    if (t.endsWith('.PA')) return `${t.slice(0, -3)}:EPA`;
    if (t.endsWith('.AS')) return `${t.slice(0, -3)}:AMS`;
    if (t.endsWith('.MC')) return `${t.slice(0, -3)}:BME`;
    if (t.endsWith('.L'))  return `${t.slice(0, -2)}:LON`;
    if (t.endsWith('.BR')) return `${t.slice(0, -3)}:EBR`;
    if (t.endsWith('.LS')) return `${t.slice(0, -3)}:ELI`;
    if (t.endsWith('.VI')) return `${t.slice(0, -3)}:VIE`;
    if (t.endsWith('.SW')) return `${t.slice(0, -3)}:SWX`;
    if (t.endsWith('.F'))  return `${t.slice(0, -2)}:FRA`;

    // US stock classes e.g. BRK-B -> BRK.B
    const cleanSym = t.replace('-', '.');

    // Exchange hint if provided
    if (exchange && typeof exchange === 'string') {
        const ex = exchange.toUpperCase();
        if (ex.includes('NASDAQ') || ex.includes('NMS') || ex.includes('NGS') || ex.includes('NCM')) {
            return `${cleanSym}:NASDAQ`;
        }
        if (ex.includes('ARCA') || ex.includes('PCX') || ex.includes('BATS') || ex.includes('ETF')) {
            return `${cleanSym}:NYSEARCA`;
        }
        if (ex.includes('NYSE') || ex.includes('NYQ')) {
            return `${cleanSym}:NYSE`;
        }
        if (ex.includes('AMEX') || ex.includes('ASE')) {
            return `${cleanSym}:AMEX`;
        }
    }

    // Known popular ETFs default to NYSEARCA or NASDAQ
    const arcaEtfs = new Set(['VOO', 'SPY', 'IVV', 'VTI', 'IWM', 'EEM', 'GLD', 'SLV', 'VEA', 'VWO', 'BND', 'AGG', 'SCHD', 'XLK', 'XLF', 'VUG']);
    if (arcaEtfs.has(cleanSym)) return `${cleanSym}:NYSEARCA`;
    if (cleanSym === 'QQQ') return 'QQQ:NASDAQ';

    // If pure US ticker format (e.g. AAPL, MSFT, KO)
    if (/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(cleanSym)) {
        return `${cleanSym}:NASDAQ`; // Candidate default
    }

    return null;
}

/**
 * Converts a Google Finance ticker (e.g. ENI:BIT, AAPL:NASDAQ, BRK.B:NYSE)
 * back to the standard Yahoo Finance ticker format (e.g. ENI.MI, AAPL, BRK-B).
 */
function mapGoogleToYahooTicker(googleTicker) {
    if (!googleTicker || typeof googleTicker !== 'string') return googleTicker;
    const clean = googleTicker.trim().toUpperCase();
    if (!clean.includes(':')) return clean;

    const [sym, exch] = clean.split(':');
    const exchMap = {
        'BIT': '.MI',
        'ETR': '.DE',
        'EPA': '.PA',
        'AMS': '.AS',
        'BME': '.MC',
        'LON': '.L',
        'EBR': '.BR',
        'ELI': '.LS',
        'VIE': '.VI',
        'SWX': '.SW',
        'FRA': '.F'
    };

    if (exchMap[exch]) {
        return `${sym}${exchMap[exch]}`;
    }

    if (['NASDAQ', 'NYSE', 'NYSEARCA', 'AMEX', 'BATS', 'INDEXNASDAQ', 'INDEXSP', 'INDEXDJX'].includes(exch)) {
        if (exch === 'INDEXSP' && sym === '.INX') return '^GSPC';
        if (exch === 'INDEXNASDAQ' && sym === '.IXIC') return '^IXIC';
        if (exch === 'INDEXDJX' && sym === '.DJI') return '^DJI';
        return sym.replace('.', '-');
    }

    if (exch === 'INDEXBIT' && sym === 'FTSEMIB') return 'FTSEMIB.MI';

    return sym;
}

// In-memory cache for resolved Google tickers so candidate probes happen only once
const _resolvedTickerCache = new Map();

/**
 * Resolves the valid, working Google Finance ticker for a given asset.
 * Tries known exchange first, and probes candidate US exchanges if needed.
 */
async function resolveGoogleTicker(ticker, customGoogleTicker = null, knownExchange = null) {
    if (customGoogleTicker && typeof customGoogleTicker === 'string' && customGoogleTicker.trim().length > 0) {
        return customGoogleTicker.trim();
    }
    if (!ticker || typeof ticker !== 'string') return null;

    const clean = ticker.trim().toUpperCase();
    if (clean.includes(':')) return clean;

    const cacheKey = `${clean}@${knownExchange || ''}`;
    if (_resolvedTickerCache.has(cacheKey)) {
        return _resolvedTickerCache.get(cacheKey);
    }

    // Direct mapping for European tickers (.MI, .DE, .PA, etc.) or indices
    const directCandidate = mapYahooToGoogleTicker(clean, null, knownExchange);
    if (directCandidate && (directCandidate.endsWith(':BIT') || directCandidate.endsWith(':ETR') || 
        directCandidate.endsWith(':EPA') || directCandidate.endsWith(':AMS') || directCandidate.endsWith(':BME') || 
        directCandidate.endsWith(':LON') || directCandidate.endsWith(':EBR') || directCandidate.endsWith(':ELI') || 
        directCandidate.endsWith(':VIE') || directCandidate.endsWith(':SWX') || directCandidate.endsWith(':FRA') ||
        directCandidate.includes('INDEX'))) {
        _resolvedTickerCache.set(cacheKey, directCandidate);
        return directCandidate;
    }

    // For US tickers without guaranteed exchange, build candidate list
    const sym = clean.replace('-', '.');
    let candidates = [];
    if (knownExchange) {
        const ex = String(knownExchange).toUpperCase();
        if (ex.includes('NASDAQ') || ex.includes('NMS') || ex.includes('NGS')) candidates.push(`${sym}:NASDAQ`);
        else if (ex.includes('ARCA') || ex.includes('PCX') || ex.includes('BATS') || ex.includes('ETF')) candidates.push(`${sym}:NYSEARCA`);
        else if (ex.includes('NYSE') || ex.includes('NYQ')) candidates.push(`${sym}:NYSE`);
        else if (ex.includes('AMEX')) candidates.push(`${sym}:AMEX`);
    }

    const arcaEtfs = new Set(['VOO', 'SPY', 'IVV', 'VTI', 'IWM', 'EEM', 'GLD', 'SLV', 'VEA', 'VWO', 'BND', 'AGG', 'SCHD', 'XLK', 'XLF', 'VUG']);
    if (arcaEtfs.has(sym)) {
        candidates.push(`${sym}:NYSEARCA`, `${sym}:NASDAQ`, `${sym}:NYSE`);
    } else {
        candidates.push(`${sym}:NASDAQ`, `${sym}:NYSE`, `${sym}:NYSEARCA`, `${sym}:AMEX`);
    }
    candidates = [...new Set(candidates)];

    for (const cand of candidates) {
        const q = await fetchGoogleFinanceQuote(cand);
        if (q && q.success && q.price > 0) {
            _resolvedTickerCache.set(cacheKey, cand);
            return cand;
        }
    }

    // Fallback to direct candidate if probes failed
    if (directCandidate) {
        _resolvedTickerCache.set(cacheKey, directCandidate);
        return directCandidate;
    }

    return null;
}

/**
 * Primary Google Finance Quote Fetcher for Stocks & ETFs (EUR & USD).
 * Checks Google Finance first. Returns null / skip if asset is a bond.
 *
 * @param {string} ticker
 * @param {string|null} customGoogleTicker
 * @param {object} [assetMeta={}]
 * @returns {Promise<{
 *   success: boolean,
 *   price?: number,
 *   changePercent?: number,
 *   changeValue?: number,
 *   currency?: string,
 *   name?: string,
 *   googleTicker?: string,
 *   realtimeSource?: string,
 *   isRealtime?: number,
 *   delay?: number,
 *   reason?: string
 * }>}
 */
async function fetchQuotePrimaryGF(ticker, customGoogleTicker = null, assetMeta = {}) {
    if (!ticker) return { success: false, reason: 'Missing ticker' };

    // Skip bonds and manual assets - bonds remain completely untouched
    const type = (assetMeta.type || assetMeta.quoteType || '').toLowerCase();
    const cleanTicker = ticker.trim().toUpperCase();
    if (type.includes('bond') || type.includes('obblig') || type === 'btp' || 
        cleanTicker.startsWith('BTP') || cleanTicker.startsWith('BOT') || cleanTicker.startsWith('CCT') ||
        cleanTicker.startsWith('CD_') || cleanTicker.startsWith('BP_') || cleanTicker === 'CASH' ||
        assetMeta.dataSource === 'B_ITA' || assetMeta.dataSource === 'MANUAL') {
        return { success: false, isBondOrManual: true, reason: 'Bonds and manual assets are handled by their dedicated sources' };
    }

    try {
        const gTicker = await resolveGoogleTicker(cleanTicker, customGoogleTicker, assetMeta.exchange);
        if (!gTicker) {
            return { success: false, reason: `Could not resolve Google Finance ticker for ${ticker}` };
        }

        const gf = await fetchGoogleFinanceQuote(gTicker);
        if (gf && gf.success && gf.price > 0) {
            return {
                success: true,
                price: gf.price,
                changePercent: gf.changePercent,
                changeValue: gf.changeValue,
                currency: gf.currency || 'USD',
                name: gf.name,
                googleTicker: gTicker,
                realtimeSource: gf.isRealtime ? 'GF' : 'GF_DELAYED',
                isRealtime: gf.isRealtime ? 1 : 0,
                delay: gf.delay
            };
        }
        return { success: false, reason: gf ? gf.reason : 'Empty GF response' };
    } catch (err) {
        return { success: false, reason: err.message };
    }
}

/**
 * Fetches real-time quote information from Google Finance.
 *
 * @param {string} googleTicker - The ticker in {TICKER}:{EXCHANGE} format (e.g. "ENI:BIT")
 * @returns {Promise<{
 *   success: boolean,
 *   googleTicker?: string,
 *   price?: number,
 *   changeValue?: number,
 *   changePercent?: number,
 *   currency?: string,
 *   delay?: number,
 *   isRealtime?: boolean,
 *   name?: string,
 *   quoteTime?: number,
 *   cached?: boolean,
 *   reason?: string
 * }>}
 */
async function fetchGoogleFinanceQuote(googleTicker) {
    if (!googleTicker || typeof googleTicker !== 'string') {
        return { success: false, reason: 'Invalid or missing Google Finance ticker' };
    }

    const cleanTicker = googleTicker.trim();

    // Check memory cache
    const cached = _gfCache.get(cleanTicker);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
        return { ...cached.data, cached: true };
    }

    const url = `https://www.google.com/finance/quote/${encodeURIComponent(cleanTicker)}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                // Cookies to bypass EU Google Consent redirect walls
                'Cookie': 'CONSENT=PENDING+999; SOCS=CAESHAgBEhJnd3NfMjAyNDA0MTUtMF9SQzIaAmVuIAEaBgiA_L-wBg;'
            },
            timeout: 5000,
            maxRedirects: 3
        });

        if (!response.data) {
            return { success: false, reason: 'Empty response from Google Finance' };
        }

        // Google Finance embeds serialized UI data in AF_initDataCallback with key 'ds:2'
        const match = response.data.match(/AF_initDataCallback\s*\(\s*\{key:\s*'ds:2'[\s\S]*?data:\s*([\s\S]*?)\}\s*\)\s*;/);
        if (!match) {
            return { success: false, reason: 'ds:2 callback not found in Google Finance HTML' };
        }

        const jsonStr = match[1].replace(/,\s*sideChannel:[\s\S]*$/, '');
        const parsed = JSON.parse(jsonStr);
        const item = parsed?.[0]?.[0]?.[0];

        if (!item) {
            return { success: false, reason: 'Unexpected data structure in Google Finance ds:2' };
        }

        const price = item[5]?.[0];
        if (price === undefined || price === null || isNaN(price)) {
            return { success: false, reason: 'No numeric price found in Google Finance item' };
        }

        // item[3]: 0 = Real-Time; > 0 = Delayed (e.g. 5, 15 minutes)
        const delayMinutes = typeof item[3] === 'number' ? item[3] : 0;
        const isRealtime = delayMinutes === 0;
        const changeValue = item[5]?.[1] ?? 0;
        const changePercent = item[5]?.[2] ?? 0;
        const currency = item[4] || 'EUR';
        const name = item[2] || '';

        const result = {
            success: true,
            googleTicker: cleanTicker,
            price: Number(price),
            changeValue: Number(changeValue),
            changePercent: Number(changePercent),
            currency,
            delay: delayMinutes,
            isRealtime,
            name,
            quoteTime: Date.now()
        };

        _gfCache.set(cleanTicker, { ts: Date.now(), data: result });
        return result;
    } catch (err) {
        return { success: false, reason: err.message };
    }
}

/**
 * Checks if a Yahoo Finance quote is delayed or missing, and attempts to enrich/replace with data from Google Finance.
 *
 * @param {string} yahooTicker
 * @param {object} yfQuote - Raw quote or metadata from Yahoo Finance
 * @param {string} [customGoogleTicker] - Optional explicit Google ticker override
 * @returns {Promise<{
 *   usedGoogleFinance: boolean,
 *   isRealtime: boolean,
 *   price: number,
 *   changeValue: number,
 *   changePercent: number,
 *   realtimeSource: 'GF' | 'GF_DELAYED' | 'YF' | 'YF_DELAYED'
 * }>}
 */
async function enrichWithGoogleFinanceIfDelayed(yahooTicker, yfQuote, customGoogleTicker = null) {
    const isYfDelayed = typeof yfQuote?.exchangeDataDelayedBy === 'number' && yfQuote.exchangeDataDelayedBy > 0;
    const basePrice = yfQuote?.currentPrice ?? yfQuote?.regularMarketPrice ?? 0;
    const baseChange = yfQuote?.changePercent ?? yfQuote?.regularMarketChangePercent ?? 0;
    const baseChangeVal = yfQuote?.changeValue ?? yfQuote?.regularMarketChange ?? 0;

    // Try Google Finance if YF is delayed OR if YF price is 0/missing/unrealistic
    const needsGF = isYfDelayed || basePrice <= 0.0001;

    const gTicker = mapYahooToGoogleTicker(yahooTicker, customGoogleTicker);
    if (gTicker && needsGF) {
        try {
            const gf = await fetchGoogleFinanceQuote(gTicker);
            if (gf && gf.success && gf.price > 0) {
                if (yfQuote && typeof yfQuote === 'object') {
                    yfQuote.regularMarketPrice = gf.price;
                    yfQuote.regularMarketChange = gf.changeValue;
                    yfQuote.regularMarketChangePercent = gf.changePercent;
                }
                return {
                    usedGoogleFinance: true,
                    enriched: true,
                    isRealtime: gf.isRealtime ? 1 : 0,
                    price: gf.price,
                    changeValue: gf.changeValue,
                    changePercent: gf.changePercent,
                    realtimeSource: gf.isRealtime ? 'GF' : 'GF_DELAYED',
                    googleTicker: gTicker
                };
            }
        } catch (e) {
            // fallback gracefully
        }
    }

    return {
        usedGoogleFinance: false,
        enriched: false,
        isRealtime: isYfDelayed ? 0 : 1,
        price: basePrice,
        changeValue: baseChangeVal,
        changePercent: baseChange,
        realtimeSource: isYfDelayed ? 'YF_DELAYED' : 'YF'
    };
}

/**
 * Fetches standalone asset metadata directly from Google Finance.
 * Used when dataSource is 'GF' or when Yahoo Finance fails completely.
 *
 * @param {string} ticker - Yahoo ticker or Google ticker
 * @param {string} [customGoogleTicker] - Optional explicit Google ticker override
 * @returns {Promise<object|null>}
 */
async function fetchGoogleFinanceAsset(ticker, customGoogleTicker = null) {
    const gTicker = mapYahooToGoogleTicker(ticker, customGoogleTicker);
    if (!gTicker) return null;

    const gf = await fetchGoogleFinanceQuote(gTicker);
    if (!gf || !gf.success || gf.price <= 0) return null;

    const nameLower = (gf.name || '').toLowerCase();
    let detailedType = 'Stock';
    if (nameLower.includes('etf') || nameLower.includes('ucits')) {
        if (nameLower.includes('bond') || nameLower.includes('obblig') || nameLower.includes('treasury')) {
            detailedType = 'ETF Obblig';
        } else if (nameLower.includes('money') || nameLower.includes('monetario') || nameLower.includes('cash')) {
            detailedType = 'ETF Monetario';
        } else {
            detailedType = 'ETF Azionario';
        }
    }

    const exchangePart = gTicker.includes(':') ? gTicker.split(':')[1] : 'GF';

    return {
        ticker: ticker,
        name: gf.name || ticker,
        currency: gf.currency || 'EUR',
        exchange: exchangePart,
        type: detailedType,
        country: 'Global',
        currentPrice: gf.price,
        changePercent: gf.changePercent || 0,
        changeValue: gf.changeValue || 0,
        preMarketChangePercent: 0,
        postMarketChangePercent: 0,
        pe: null,
        forwardPE: null,
        realtimeSource: gf.isRealtime ? 'GF' : 'GF_DELAYED',
        isRealtime: gf.isRealtime ? 1 : 0,
        googleTicker: gTicker,
        dataSource: 'GF',
        quoteDate: new Date().toISOString().split('T')[0]
    };
}

module.exports = {
    mapYahooToGoogleTicker,
    mapGoogleToYahooTicker,
    resolveGoogleTicker,
    fetchGoogleFinanceQuote,
    fetchQuotePrimaryGF,
    enrichWithGoogleFinanceIfDelayed,
    fetchGoogleFinanceAsset
};

