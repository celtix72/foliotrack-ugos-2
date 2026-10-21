const axios = require('axios');

async function fetchBorsaItalianaHistory(ticker, isin) {
    try {
        const cleanIsin = isin.trim().toUpperCase();
        const suffixes = ['-MOTX', '-XMOT', '-ETFX', '-MTAA'];
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
        };

        let token = null;
        let summaryUrl = null;
        let exchcode = 'XMIL';

        for (const sfx of suffixes) {
            const u = `https://grafici.borsaitaliana.it/summary-chart/${cleanIsin}${sfx}?lang=it`;
            try {
                const resp = await axios.get(u, { headers, timeout: 5000 });
                if (resp.data) {
                    const tokenMatch = resp.data.match(/token="([^"]+)"/);
                    const exchMatch = resp.data.match(/exchcode="([^"]+)"/);
                    if (tokenMatch) {
                        token = tokenMatch[1];
                        summaryUrl = u;
                        if (exchMatch && exchMatch[1]) exchcode = exchMatch[1];
                        break;
                    }
                }
            } catch (e) {}
        }

        if (!token) {
            console.error(`Token not found for ${cleanIsin}`);
            return null;
        }

        const url = `https://grafici.borsaitaliana.it/api/instruments/${cleanIsin},${exchcode},ISIN/history/period?period=5Y&adjustment=true&add-last-price=true`;
        console.log(`Fetching: ${url}`);
        const resp = await axios.get(url, {
            headers: {
                ...headers,
                'Authorization': `Bearer ${token}`,
                'Referer': summaryUrl,
                'Accept': 'application/json, text/plain, */*'
            },
            timeout: 10000
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
            return map;
        }
    } catch (err) {
        console.error(`B_ITA history failed for ${ticker} (${isin}):`, err.message);
    }
    return null;
}

async function test() {
    const isin = 'IT0005583486';
    const ticker = 'BTPMz30';
    console.log(`Testing history fetch for ${ticker} (${isin})...`);
    const prices = await fetchBorsaItalianaHistory(ticker, isin);
    if (prices && Object.keys(prices).length > 0) {
        const dates = Object.keys(prices).sort();
        console.log(`✅ Success! Found ${dates.length} historical points.`);
        console.log(`First date: ${dates[0]} => ${prices[dates[0]]}`);
        console.log(`Latest date: ${dates[dates.length - 1]} => ${prices[dates[dates.length - 1]]}`);
    } else {
        console.log('❌ Failed to fetch historical prices.');
    }
}

test();
