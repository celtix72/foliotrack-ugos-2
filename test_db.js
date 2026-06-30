const Database = require('better-sqlite3');
const db = new Database('foliotrack.db');

try {
        const user_id = 1;
        const portfolioTickers = db.prepare(`
            SELECT DISTINCT t.assetTicker AS ticker
            FROM transactions t
            JOIN portfolios p ON t.portfolioId = p.id
            WHERE p.user_id = ? AND t.assetTicker IS NOT NULL AND t.assetTicker != 'CASH'
        `).all(user_id).map(r => r.ticker);

        const watchlistTickers = db.prepare(`
            SELECT DISTINCT ticker FROM user_watchlist WHERE user_id = ?
        `).all(user_id).map(r => r.ticker);

        const allTickers = [...new Set([...portfolioTickers, ...watchlistTickers])];

        let assetNames = [];
        if (allTickers.length > 0) {
            const placeholders = allTickers.map(() => '?').join(',');
            assetNames = db.prepare(
                `SELECT ticker, name FROM assets WHERE ticker IN (${placeholders})`
            ).all(...allTickers);
        }

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
        console.log("Success! MatchTerms:", matchTerms.length);
} catch (e) {
    console.error("ERROR:", e);
}
