const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const oldYF = `            dividendYield: (function() {`;

const newYF = `            changePercent: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChangePercent || (summary.price ? summary.price.regularMarketChangePercent : null)),
            changeValue: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChange || (summary.price ? summary.price.regularMarketChange : null)),
            dividendYield: (function() {`;

code = code.replace(oldYF, newYF);
fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched YF volume logic');
