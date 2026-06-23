const fs = require('fs');
const path = require('path');

const SERVER = '/Users/mauro/Documents/FolioTrack3/src/server.js';
const ROUTES_DIR = '/Users/mauro/Documents/FolioTrack3/src/routes';

let content = fs.readFileSync(SERVER, 'utf8');
let lines = content.split('\n');

// ─── Helper: build router file ─────────────────────────────────────────────
function buildRouterFile(header, bodyCode, footer) {
    return header + bodyCode + footer;
}

// ─── Helper: extract lines from server.js ─────────────────────────────────
function extractLines(blocks) {
    let parts = [];
    for (const [start, end] of blocks) {
        parts.push(lines.slice(start - 1, end).join('\n'));
    }
    return parts.join('\n\n');
}

// ─── ASSETS ROUTER ─────────────────────────────────────────────────────────
const assetsBlocks = [
    [919, 1683],    // fundamentals + assets main API
    [1934, 2051],   // assets/:ticker routes (history, portfolios, details, delete)
    [2617, 2865],   // assets AI analysis + ai-history
];

const assetsBody = extractLines(assetsBlocks)
    .replace(/^app\.(get|post|put|patch|delete)\(/gm, 'router.$1(');

const assetsHeader = `const express = require('express');

/**
 * Assets & Fundamentals Router
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        requirePortfolioAccess,
        database,
        logger,
        yahooFinance,
        getEurUsdRate,
        getMarketStatus,
        isUSMarket,
        fetchAssetMetadata,
        clearPerformanceCache,
        callAIModel,
        parseAIResponse,
        notifyUser,
        APP_VERSION,
    } = dependencies;

    const fundamentalsCache = new Map();
    const FUNDAMENTALS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

`;
const assetsFooter = `
    return router;
};
`;

const assetsCode = buildRouterFile(assetsHeader, assetsBody, assetsFooter);
fs.writeFileSync(path.join(ROUTES_DIR, 'assets.js'), assetsCode);
console.log('✅ assets.js created');

// ─── MARKET ROUTER ─────────────────────────────────────────────────────────
const marketBlocks = [
    [1684, 1735],   // market/search + market/indices
    [3334, 3465],   // market/movers + validate-ticker (full closure)
    [3670, 3684],   // fx-rate
    [3737, 3760],   // asset-search + market/exchange-rate
    [4765, 4803],   // indicesCache + /api/indices
    [6204, 6257],   // market-status + market-sync + purge-performance
    [6440, 6534],   // news + news/sources + settings/news-sources
];

// Separate indicesCache declaration from the route handler
let marketBody = extractLines(marketBlocks)
    .replace(/^app\.(get|post|put|patch|delete)\(/gm, 'router.$1(');

const marketHeader = `const express = require('express');

/**
 * Market Router (search, indices, news, market status/sync)
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        requireAdmin,
        database,
        logger,
        yahooFinance,
        getEurUsdRate,
        getMarketStatus,
        isUSMarket,
        fetchAssetMetadata,
        clearPerformanceCache,
        updateMarketData,
        syncNews,
        eurUsdCache,
        APP_VERSION,
        globalLastMarketUpdate,
    } = dependencies;

    const indicesCache = {};
    const INDICES_CACHE_TTL = 60 * 1000;

`;
const marketFooter = `
    return router;
};
`;

// Remove the indicesCache/INDICES_CACHE_TTL lines from body (they're in header now)
marketBody = marketBody
    .replace(/^\s*const indicesCache = \{\}.*\n/m, '')
    .replace(/^\s*const INDICES_CACHE_TTL = .*\n/m, '');

const marketCode = buildRouterFile(marketHeader, marketBody, marketFooter);
fs.writeFileSync(path.join(ROUTES_DIR, 'market.js'), marketCode);
console.log('✅ market.js created');

// ─── REMOVE EXTRACTED BLOCKS FROM SERVER.JS ─────────────────────────────────
const allBlocks = [
    ...assetsBlocks,
    ...marketBlocks,
].sort((a, b) => a[0] - b[0]);

// Mark removed lines with a sentinel, then filter them out
const removedSet = new Set();
for (const [start, end] of allBlocks) {
    for (let i = start - 1; i < end; i++) {
        removedSet.add(i);
    }
}

const newLines = lines.filter((_, idx) => !removedSet.has(idx));
let newContent = newLines.join('\n');

// ─── INSERT router registrations at the right places ────────────────────────
// Insert AFTER: app.use('/api/portfolios', ...) block  (around line 2292 original, now earlier)
// Since we removed code, find it by text pattern
const portfoliosInsertMarker = "app.use('/api/portfolios', require('./routes/portfolios')";
const assetsInsert = `
// ─── Assets & Fundamentals Routes ────────────────────────────────────────────
app.use('/api', require('./routes/assets')({
    requireAuth, requirePortfolioAccess, database, logger, yahooFinance,
    getEurUsdRate, getMarketStatus, isUSMarket, fetchAssetMetadata,
    clearPerformanceCache, callAIModel, parseAIResponse, notifyUser, APP_VERSION
}));

// ─── Market Routes ────────────────────────────────────────────────────────────
app.use('/api', require('./routes/market')({
    requireAuth, requireAdmin, database, logger, yahooFinance,
    getEurUsdRate, getMarketStatus, isUSMarket, fetchAssetMetadata,
    clearPerformanceCache, updateMarketData, syncNews,
    get eurUsdCache() { return eurUsdCache; },
    get globalLastMarketUpdate() { return globalLastMarketUpdate; },
    APP_VERSION
}));

`;

// Find insert point: after the portfolios app.use block
const insertIdx = newContent.indexOf(portfoliosInsertMarker);
if (insertIdx === -1) {
    console.error('❌ Could not find portfolios insert marker!');
    process.exit(1);
}
// Find end of that block (closing })); )
const blockEnd = newContent.indexOf('}));', insertIdx) + 4;
newContent = newContent.slice(0, blockEnd) + '\n' + assetsInsert + newContent.slice(blockEnd);

fs.writeFileSync(SERVER, newContent);
console.log('✅ server.js updated');
console.log('   Removed lines:', removedSet.size);
console.log('   New line count:', newContent.split('\n').length);
