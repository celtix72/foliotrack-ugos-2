const fs = require('fs');

let content = fs.readFileSync('src/routes/assets.js', 'utf8');

// 1. Extract getAssetFundamentals
const routerGetRegex = /router\.get\('\/fundamentals\/:ticker',\s*requireAuth,\s*async\s*\(req,\s*res\)\s*=>\s*\{([\s\S]*?res\.json\(result\);\n\}\);)/;
const match = content.match(routerGetRegex);
if (match) {
    let body = match[1];
    
    // Convert to getAssetFundamentals
    let funcBody = body
        .replace(/const ticker = \(req\.params\.ticker \|\| ''\)\.toUpperCase\(\);\n\s*if \(\!ticker\) return res\.status\(400\)\.json\(\{ error: 'Ticker mancante' \}\);/, '')
        .replace(/res\.json\(result\);/, 'return result;');
        
    // Also inject calendarEvents and summaryDetail into the first quoteSummary
    funcBody = funcBody.replace(
        /modules:\s*\['defaultKeyStatistics'\]/,
        "modules: ['defaultKeyStatistics', 'summaryDetail', 'calendarEvents']"
    );
    funcBody = funcBody.replace(
        /result\.operatingCFTTM\s*=\s*s\.operatingCashflow\s*\?\?\s*null;/,
        "result.operatingCFTTM  = s.operatingCashflow ?? null;\n        const sd = ks.summaryDetail || {};\n        const ce = ks.calendarEvents || {};\n        result.summaryDetail = sd;\n        result.calendarEvents = ce;"
    );

    const newFunc = `async function getAssetFundamentals(ticker) {\n    if (!ticker) throw new Error('Ticker mancante');\n    ticker = ticker.toUpperCase();\n${funcBody}\n}\n\nrouter.get('/fundamentals/:ticker', requireAuth, async (req, res) => {\n    try {\n        const data = await getAssetFundamentals(req.params.ticker);\n        res.json(data);\n    } catch (e) {\n        res.status(500).json({ error: e.message });\n    }\n});`;

    content = content.replace(routerGetRegex, newFunc);
} else {
    console.log("Could not find router.get('/fundamentals/:ticker'");
    process.exit(1);
}

// 2. Refactor AI Analysis
const aiRouteRegex = /sendEvent\('progress',\s*\{ message: 'Recupero dati fondamentali\.\.\.' \}\);[\s\S]*?(const fundamentalsStr =[\s\S]*? Beta:.*?\$\{historicalStr\}`;)/;
const aiMatch = content.match(aiRouteRegex);
if (aiMatch) {
    const aiReplacement = `sendEvent('progress', { message: 'Recupero dati fondamentali (presenti e storici)...' });
        const fundamentalsData = await getAssetFundamentals(ticker).catch(() => ({}));
        
        let earningsDate = 'Sconosciuta';
        if (fundamentalsData.calendarEvents?.earnings?.earningsDate?.[0]) {
            earningsDate = new Date(fundamentalsData.calendarEvents.earnings.earningsDate[0]).toISOString().split('T')[0];
        }

        const ks = fundamentalsData.keyStats || {};
        const sd = fundamentalsData.summaryDetail || {};
        
        let historicalStr = '';
        if (fundamentalsData.historicalFinancials && fundamentalsData.historicalFinancials.length > 0) {
            const lines = fundamentalsData.historicalFinancials.map(item => {
                const year = item.date ? String(item.date).substring(0,4) : 'N/D';
                const rev = item.totalRevenue ?? null;
                const ni = item.netIncome ?? null;
                return \`    * \${year}: Revenue \${rev ? (rev/1e9).toFixed(2)+'B' : 'N/D'}, Net Income \${ni ? (ni/1e9).toFixed(2)+'B' : 'N/D'}\`;
            });
            historicalStr = '\\n  - Storico Dati Finanziari (Annuale):\\n' + lines.join('\\n');
        }
        
        const fundamentalsStr = \`
  - P/E (Trailing): \${sd.trailingPE ? sd.trailingPE.toFixed(2) : 'N/D'}
  - P/E (Forward): \${ks.forwardPE ? ks.forwardPE.toFixed(2) : 'N/D'}
  - PEG Ratio: \${fundamentalsData.pegRatio ? fundamentalsData.pegRatio.toFixed(2) : 'N/D'}
  - EPS (Trailing): \${ks.trailingEps ? ks.trailingEps.toFixed(2) : 'N/D'}
  - EPS (Forward): \${ks.forwardEps ? ks.forwardEps.toFixed(2) : 'N/D'}
  - Dividend Yield: \${sd.dividendYield ? (sd.dividendYield * 100).toFixed(2) + '%' : 'N/D'}
  - Beta: \${sd.beta ? sd.beta.toFixed(2) : 'N/D'}\${historicalStr}\`;`;

    content = content.replace(aiRouteRegex, aiReplacement);
} else {
    console.log("Could not find AI route chunk");
    process.exit(1);
}

fs.writeFileSync('src/routes/assets.js', content);
console.log("Refactoring complete");
