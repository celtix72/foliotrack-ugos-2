const { syncNews } = require('../src/server');
const database = require('../src/db');
const { logger } = require('../src/utils/logger');

async function run() {
    console.log("Running manual news sync...");
    try {
        await syncNews();
        console.log("Sync complete. Checking news_articles count...");
        const count = database.db.prepare('SELECT count(*) as c FROM news_articles').get().c;
        console.log(`Total articles in DB: ${count}`);
        const latest = database.db.prepare('SELECT title, pubDate FROM news_articles ORDER BY pubDate DESC LIMIT 5').all();
        console.log("Latest articles:", latest);
    } catch (e) {
        console.error("Error running syncNews:", e);
    }
}

run().then(() => process.exit(0));
