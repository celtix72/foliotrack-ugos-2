import os

file_path = 'src/server.js'
with open(file_path, 'r') as f:
    lines = f.readlines()

new_code = """
app.get('/api/analytics/global-allocation', requireAuth, async (req, res) => {
    try {
        const { portfolioIds } = req.query;
        let pIdsToUse = portfolioIds ? portfolioIds.split(',').map(Number) : null;

        let portfolios;
        if (pIdsToUse) {
            const placeholders = pIdsToUse.map(() => '?').join(',');
            portfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ? AND p.id IN (${placeholders})
            `).all(req.user.id, ...pIdsToUse);
        } else {
            portfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ? AND p.include_in_totals != 0
            `).all(req.user.id);
        }

        const liveRate = await getEurUsdRate();
        const typeMap = {};
        let totalGrossValue = 0;

        for (const { id } of portfolios) {
            const details = await getPortfolioDetails(id, liveRate);
            const holdings = details.holdings;
            for (const h of holdings) {
                const tp = h.type || 'Other';
                typeMap[tp] = (typeMap[tp] || 0) + h.currentValue;
                totalGrossValue += h.currentValue;
            }
            // Inclusion of Cash (only if positive)
            if (details.currentCash > 0) {
                typeMap['Liquidity'] = (typeMap['Liquidity'] || 0) + details.currentCash;
                totalGrossValue += details.currentCash;
            }
        }

        const allocation = Object.entries(typeMap)
            .map(([type, value]) => ({
                type,
                value: Math.round(value * 100) / 100,
                percent: totalGrossValue > 0 ? Math.round((value / totalGrossValue) * 1000) / 10 : 0
            })).sort((a, b) => b.value - a.value);

        res.json(allocation);
    } catch (err) {
        console.error('Global allocation error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portfolios/:id/export', (req, res) => {
"""

# Find where to insert. We look for the gap I created.
target_line = "    const portfolioId = req.params.id;"
for i, line in enumerate(lines):
    if target_line in line:
        # Insert before this line
        lines.insert(i, new_code)
        break

with open(file_path, 'w') as f:
    f.writelines(lines)
