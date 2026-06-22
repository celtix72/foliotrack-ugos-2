const fs = require('fs');

const file = '/Users/mauro/Documents/FolioTrack3/src/server.js';
let content = fs.readFileSync(file, 'utf8');

const routesToRemove = [
    "app.get('/api/portfolios/:id', requireAuth, requirePortfolioAccess",
    "app.get('/api/portfolios/:id/ai-analysis', requireAuth, requirePortfolioAccess",
    "app.get('/api/portfolios/:id/ai-history', requireAuth, requirePortfolioAccess",
    "app.delete('/api/portfolios/:id/ai-history/:analysisId', requireAuth, requirePortfolioAccess",
    "app.get('/api/portfolios/:id/export', requireAuth, requirePortfolioAccess",
    "app.post('/api/portfolios', requireAuth,",
    "app.put('/api/portfolios/:id', requireAuth, requirePortfolioAccess",
    "app.delete('/api/portfolios/:id', requireAuth, requirePortfolioAccess",
    "app.post('/api/portfolios/:id/reconcile', requireAuth, requirePortfolioAccess"
];

let lines = content.split('\n');
let newLines = [];
let i = 0;

while (i < lines.length) {
    let match = routesToRemove.find(r => lines[i].includes(r));
    if (match) {
        // we found the start of a route. Let's count braces to find the end.
        let braceCount = 0;
        let started = false;
        while (i < lines.length) {
            let line = lines[i];
            braceCount += (line.match(/\{/g) || []).length;
            braceCount -= (line.match(/\}/g) || []).length;
            if (braceCount > 0) started = true;
            i++;
            if (started && braceCount === 0) {
                // Check if the route definition closes with `});` which might be on the next lines or same line
                if (lines[i-1].includes('});') || lines[i-1].trim() === '});') {
                    break;
                } else if (i < lines.length && (lines[i].includes('});') || lines[i].trim() === '});')) {
                    i++;
                    break;
                }
                break;
            }
        }
    } else {
        newLines.push(lines[i]);
        i++;
    }
}

fs.writeFileSync(file, newLines.join('\n'));
console.log('Removed successfully!');
