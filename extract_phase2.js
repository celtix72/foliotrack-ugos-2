const fs = require('fs');
const path = require('path');

const SERVER = '/Users/mauro/Documents/FolioTrack3/src/server.js';

let lines = fs.readFileSync(SERVER, 'utf8').split('\n');

// Blocks to remove from server.js, specified as [startLine, endLine] (1-indexed, inclusive)
// Identified by manually verifying line content above.
// Each block maps to a route file.
const assetsBlocks = [
    [919, 1683],    // FUNDAMENTALS + ASSETS API (up to, but not including MARKET SEARCH)
    [1934, 2865],   // assets/:ticker/history, portfolios, details, ai-analysis, ai-history, ai-history DELETE
];

const marketBlocks = [
    [1684, 1735],   // MARKET SEARCH API + MARKET INDICES
    [3334, 3383],   // market/movers + validate-ticker (ends before ANALYTICS section)
    [3670, 3684],   // fx-rate
    [3737, 3762],   // asset-search + market/exchange-rate
    [4766, 4800],   // indicesCache + /api/indices
    [6204, 6258],   // market-status + market-sync + purge-performance
    [6440, 6537],   // news + news/sources + settings/news-sources
];

// Extract code for a set of blocks
function extractBlocks(blocks) {
    let extracted = '';
    for (const [start, end] of blocks) {
        // Convert to 0-indexed
        const chunk = lines.slice(start - 1, end).join('\n');
        extracted += chunk + '\n\n';
    }
    return extracted;
}

const assetsCode = extractBlocks(assetsBlocks);
const marketCode = extractBlocks(marketBlocks);

// Write extracted code to temp files for inspection
fs.writeFileSync('/tmp/assets_extracted.js', assetsCode);
fs.writeFileSync('/tmp/market_extracted.js', marketCode);

console.log('Assets code lines:', assetsCode.split('\n').length);
console.log('Market code lines:', marketCode.split('\n').length);

// Verify first/last lines look correct
const aLines = assetsCode.split('\n');
const mLines = marketCode.split('\n');
console.log('\nASSETS first line:', aLines[0]);
console.log('ASSETS last non-empty line:', aLines.filter(l => l.trim()).slice(-1)[0]);
console.log('\nMARKET first line:', mLines[0]);
console.log('MARKET last non-empty line:', mLines.filter(l => l.trim()).slice(-1)[0]);

// Verify server.js last line is sensible
const allBlocks = [...assetsBlocks, ...marketBlocks].sort((a, b) => a[0] - b[0]);
const totalLinesToRemove = allBlocks.reduce((sum, [s, e]) => sum + (e - s + 1), 0);
console.log('\nTotal lines to remove from server.js:', totalLinesToRemove);
console.log('Current server.js lines:', lines.length);
console.log('Expected after removal:', lines.length - totalLinesToRemove);
