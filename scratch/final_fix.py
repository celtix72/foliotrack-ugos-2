import os

file_path = 'src/server.js'
with open(file_path, 'r') as f:
    lines = f.readlines()

# Search for the start of the broken block
start_pattern = "            const placeholders = pIdsToUse.map(() => '?').join(',');"
header = """app.get('/api/analytics/global-allocation', requireAuth, async (req, res) => {
    try {
        const { portfolioIds } = req.query;
        let pIdsToUse = (portfolioIds && portfolioIds.trim() !== '') ? portfolioIds.split(',').map(Number) : null;

        let portfolios;
        if (pIdsToUse && pIdsToUse.length > 0) {
"""

for i, line in enumerate(lines):
    if start_pattern in line:
        # Check if the header is already there. If not, insert it.
        if "global-allocation" not in "".join(lines[max(0, i-5):i]):
            lines.insert(i, header)
            break

with open(file_path, 'w') as f:
    f.writelines(lines)
