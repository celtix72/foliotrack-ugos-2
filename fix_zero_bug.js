const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const fetchYF = `            changePercent: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChangePercent || (summary.price ? summary.price.regularMarketChangePercent : null)),
            changeValue: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChange || (summary.price ? summary.price.regularMarketChange : null)),`;

const newFetchYF = `            changePercent: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChangePercent !== undefined && quote.regularMarketChangePercent !== null ? quote.regularMarketChangePercent : (summary.price ? summary.price.regularMarketChangePercent : null)),
            changeValue: quote.regularMarketVolume === 0 ? 0 : (quote.regularMarketChange !== undefined && quote.regularMarketChange !== null ? quote.regularMarketChange : (summary.price ? summary.price.regularMarketChange : null)),`;

code = code.replace(fetchYF, newFetchYF);

const updateYF = `                updateData = {
                    price: metadata.currentPrice || asset.currentPrice,
                    change: metadata.changePercent || asset.changePercent,
                    changeValue: metadata.changeValue || 0,`;

const newUpdateYF = `                updateData = {
                    price: metadata.currentPrice || asset.currentPrice,
                    change: metadata.changePercent !== undefined && metadata.changePercent !== null ? metadata.changePercent : asset.changePercent,
                    changeValue: metadata.changeValue !== undefined && metadata.changeValue !== null ? metadata.changeValue : 0,`;

code = code.replace(updateYF, newUpdateYF);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Fixed zero bug');
