const axios = require('axios');

// In-memory cache for Google Finance quotes (TTL: 45 seconds)
const _gfCache = new Map();
const CACHE_TTL_MS = 45000;

/**
 * Maps a Yahoo Finance ticker to the equivalent Google Finance format: {TICKER}:{EXCHANGE}
 *
 * Examples:
 * - ENI.MI -> ENI:BIT
 * - ISP.MI -> ISP:BIT
 * - SAP.DE -> SAP:ETR
 * - AIR.PA -> AIR:EPA
 * - ASML.AS -> ASML:AMS
 * - IBE.MC -> IBE:BME
 * - SHEL.L -> SHEL:LON
 * - FTSEMIB.MI / ^FTSEMIB -> FTSEMIB:INDEXBIT
 * - ^GSPC -> .INX:INDEXSP
 * - ^IXIC -> .IXIC:INDEXNASDAQ
 */
function mapYahooToGoogleTicker(ticker, customGoogleTicker = null) {
    if (customGoogleTicker && typeof customGoogleTicker === 'string' && customGoogleTicker.trim().length > 0) {
        return customGoogleTicker.trim();
    }
    if (!ticker || typeof ticker !== 'string') return null;

    const t = ticker.trim().toUpperCase();

    // Specific Index mappings
    if (t === 'FTSEMIB.MI' || t === '^FTSEMIB') return 'FTSEMIB:INDEXBIT';
    if (t === '^GSPC') return '.INX:INDEXSP';
    if (t === '^IXIC') return '.IXIC:INDEXNASDAQ';
    if (t === '^STOXX50E') return 'INDEXSTOXX:SX5E';

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

    // US Equities without suffix (if needed)
    // Note: US stocks are typically already real-time on Yahoo Finance
    return null;
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
            timeout: 4500,
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

        // item[3]: 0 = Real-Time; > 0 = Delayed (e.g. 15 minutes)
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
 * Checks if a Yahoo Finance quote is delayed and, if so, attempts to enrich it with real-time data from Google Finance.
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
 *   realtimeSource: 'GF' | 'YF' | 'YF_DELAYED'
 * }>}
 */
async function enrichWithGoogleFinanceIfDelayed(yahooTicker, yfQuote, customGoogleTicker = null) {
    const isYfDelayed = typeof yfQuote?.exchangeDataDelayedBy === 'number' && yfQuote.exchangeDataDelayedBy > 0;
    const basePrice = yfQuote?.currentPrice ?? yfQuote?.regularMarketPrice ?? 0;
    const baseChange = yfQuote?.changePercent ?? yfQuote?.regularMarketChangePercent ?? 0;
    const baseChangeVal = yfQuote?.changeValue ?? yfQuote?.regularMarketChange ?? 0;

    // If Yahoo Finance is already real-time (e.g. US market), use it directly
    if (!isYfDelayed) {
        return {
            usedGoogleFinance: false,
            enriched: false,
            isRealtime: 1,
            price: basePrice,
            changeValue: baseChangeVal,
            changePercent: baseChange,
            realtimeSource: 'YF'
        };
    }

    // Yahoo is delayed, try Google Finance
    const gTicker = mapYahooToGoogleTicker(yahooTicker, customGoogleTicker);
    if (gTicker) {
        try {
            const gf = await fetchGoogleFinanceQuote(gTicker);
            if (gf && gf.success && gf.isRealtime && gf.price > 0) {
                if (yfQuote && typeof yfQuote === 'object') {
                    yfQuote.regularMarketPrice = gf.price;
                    yfQuote.regularMarketChange = gf.changeValue;
                    yfQuote.regularMarketChangePercent = gf.changePercent;
                }
                return {
                    usedGoogleFinance: true,
                    enriched: true,
                    isRealtime: 1,
                    price: gf.price,
                    changeValue: gf.changeValue,
                    changePercent: gf.changePercent,
                    realtimeSource: 'GF',
                    googleTicker: gTicker
                };
            }
        } catch (e) {
            // fallback gracefully
        }
    }

    // Fallback: keep Yahoo Finance delayed data
    return {
        usedGoogleFinance: false,
        enriched: false,
        isRealtime: 0,
        price: basePrice,
        changeValue: baseChangeVal,
        changePercent: baseChange,
        realtimeSource: 'YF_DELAYED'
    };
}

module.exports = {
    mapYahooToGoogleTicker,
    fetchGoogleFinanceQuote,
    enrichWithGoogleFinanceIfDelayed
};
