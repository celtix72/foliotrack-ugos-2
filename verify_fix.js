const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data/foliotrack.db');

async function verify() {
    console.log('--- Verifying Watchlist History Fix ---');
    
    try {
        // 1. Add MSFT to watchlist
        console.log('Adding MSFT to watchlist...');
        const res = await axios.post(`http://localhost:${PORT}/api/watchlist`, {
            ticker: 'MSFT'
        });
        console.log('Response status:', res.status);

        // 2. Wait for background sync (triggerHistoryRebuild is async)
        console.log('Waiting 15 seconds for background sync (fetching history takes time)...');
        await new Promise(resolve => setTimeout(resolve, 15000));

        // 3. Check database for quotes
        const db = new Database(DB_PATH);
        const row = db.prepare("SELECT COUNT(*) as count FROM asset_quotes WHERE ticker = 'MSFT'").get();
        console.log(`Found ${row.count} quotes for MSFT in asset_quotes table.`);
        
        if (row.count > 0) {
            console.log('SUCCESS: Historical data was successfully saved.');
        } else {
            console.log('FAILURE: No historical data found.');
        }
        db.close();

    } catch (e) {
        console.error('Verification failed:', e.message);
        if (e.response) console.error('Response data:', e.response.data);
    }
}

verify();
