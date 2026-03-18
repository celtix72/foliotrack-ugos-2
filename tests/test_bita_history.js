const axios = require('axios');

async function fetchBorsaItalianaHistory(ticker, isin) {
    try {
        const url = `https://grafici.borsaitaliana.it/api/instruments/${isin},XMIL,ISIN/history/period?period=1Y&adjustment=true&add-last-price=true`;
        console.log(`Fetching: ${url}`);
        const resp = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.borsaitaliana.it/',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 5000
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
    const prices = await fetchBorsaItalianaHistory('BTPMz30', 'IT0005594483');
    if (prices && Object.keys(prices).length > 0) {
        console.log(`✅ Success! Found ${Object.keys(prices).length} historical points.`);
        const sampleDate = Object.keys(prices).sort()[0];
        console.log(`Sample: ${sampleDate} => ${prices[sampleDate]}`);
        
        // Check for March 2024 specifically if available in 1Y (Wait, 1Y is too short for March 2024 now)
        // Let's try 5Y
    } else {
        console.log('❌ Failed to fetch historical prices.');
    }
}

test();
