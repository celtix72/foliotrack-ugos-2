module.exports = `
app.post('/api/assets/split', requireAuth, async (req, res) => {
    const { oldTicker, newTicker, ratio, splitDate } = req.body;
    
    if (!oldTicker || !ratio || !splitDate) {
        return res.status(400).json({ error: 'oldTicker, ratio and splitDate are required' });
    }

    const r = parseFloat(ratio);
    if (isNaN(r) || r <= 0) {
        return res.status(400).json({ error: 'Invalid ratio' });
    }

    const targetTicker = newTicker && newTicker.trim() !== '' ? newTicker.trim() : oldTicker;
    
    try {
        // Find existing asset
        const asset = database.db.prepare('SELECT * FROM assets WHERE ticker = ?').get(oldTicker);
        if (!asset) return res.status(404).json({ error: 'Asset not found' });

        database.db.transaction(() => {
            // 1. Rename Ticker if provided
            if (targetTicker !== oldTicker) {
                // Insert new asset if not exists
                database.db.prepare(\`
                    INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                \`).run(targetTicker, targetTicker, asset.name, asset.type, asset.exchange, asset.currency, asset.currentPrice, asset.changePercent, asset.pe, asset.country, asset.isManual, asset.dataSource, asset.isin);
                
                // Update all relations
                database.db.prepare('UPDATE transactions SET assetTicker = ? WHERE assetTicker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_quotes SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE user_watchlist SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE dividend_projections SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_ai_analyses SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_ai_history SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                
                // Try deleting old asset if it has no remaining relations
                try {
                    database.db.prepare('DELETE FROM assets WHERE ticker = ?').run(oldTicker);
                } catch (e) {
                    // Ignore foreign key constraints if it's still linked somewhere unexpected
                }
            }

            // 2. Adjust Transactions
            // Multiply quantity, divide price for dates <= splitDate
            // SPLIT ratio: if 1:10, ratio=10. old qty=1, new qty=10. 
            database.db.prepare(\`
                UPDATE transactions 
                SET quantity = quantity * ?, price = price / ?
                WHERE assetTicker = ? AND date <= ? AND type != 'SPLIT'
            \`).run(r, r, targetTicker, splitDate);

            // 3. Adjust Asset Quotes
            database.db.prepare(\`
                UPDATE asset_quotes
                SET price = price / ?
                WHERE ticker = ? AND date <= ?
            \`).run(r, targetTicker, splitDate);
            
            // 4. Insert Audit Split Transaction in all portfolios containing the asset
            const portfolios = database.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
            const insertTx = database.db.prepare(\`
                INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
                VALUES (?, 'SPLIT', ?, ?, ?, 0, 0)
            \`);
            for (const p of portfolios) {
                insertTx.run(p.portfolioId, targetTicker, splitDate, r);
            }
        })();

        // Re-fetch current price if possible (background)
        if (asset.dataSource !== 'MANUAL') {
            fetchAssetMetadata(targetTicker).then(m => {
                if (m && m.currentPrice) {
                    database.db.prepare('UPDATE assets SET currentPrice = ? WHERE ticker = ?').run(m.currentPrice, targetTicker);
                }
            }).catch(e => logger.error('Error refreshing split asset metadata:', e));
        }

        // Rebuild portfolios and clear cache
        const portfolios = database.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
        const liveRate = await getEurUsdRate();
        for (const p of portfolios) {
            database.recalculatePortfolio(p.portfolioId, liveRate);
            triggerHistoryRebuild(p.portfolioId);
        }
        clearPerformanceCache();

        res.json({ success: true, newTicker: targetTicker });
    } catch (err) {
        logger.error('Error during asset split:', err);
        res.status(500).json({ error: err.message });
    }
});
`;
