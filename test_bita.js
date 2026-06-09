const axios = require('axios');
async function test() {
    try {
        const isin = 'IT0005383309'; // BTP
        let summaryResp = await axios.get(`https://grafici.borsaitaliana.it/summary-chart/${isin}-MOTX?lang=it`);
        let token = summaryResp.data.match(/token="([^"]+)"/)[1];
        const apiUrl = `https://grafici.borsaitaliana.it/api/instruments/${isin},XMIL,ISIN/history/period?period=1M&adjustment=true&add-last-price=true`;
        const resp = await axios.get(apiUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        const history = resp.data.history.historyDt.slice(-2);
        console.log(JSON.stringify(history, null, 2));
    } catch (e) {
        console.error(e.message);
    }
}
test();
