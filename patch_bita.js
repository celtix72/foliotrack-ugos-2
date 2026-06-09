const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const oldBitaAPI = `                if (price !== undefined && price !== null) {
                    return {
                        success: true,
                        price: parseFloat(price),
                        variation: variation !== null ? parseFloat(variation) : null,
                        url: finalUrl,
                        isin
                    };
                }`;

const newBitaAPI = `                if (price !== undefined && price !== null) {
                    const rawDt = dtArr[dtArr.length - 1].dt; // e.g. "20260608"
                    const parsedDate = rawDt ? \`\${rawDt.substring(0,4)}-\${rawDt.substring(4,6)}-\${rawDt.substring(6,8)}\` : null;
                    return {
                        success: true,
                        price: parseFloat(price),
                        variation: variation !== null ? parseFloat(variation) : null,
                        url: finalUrl,
                        quoteDate: parsedDate,
                        isin
                    };
                }`;

code = code.replace(oldBitaAPI, newBitaAPI);

const oldUpdateData = `                    updateData = {
                        price: result.price,
                        change: result.variation,
                        changeValue: changeVal,
                        pe: asset.pe,
                        name: asset.name,
                        currency: asset.currency || 'EUR',
                        exchange: asset.exchange,
                        country: asset.country,
                        quoteDate: new Date().toISOString().split('T')[0]
                    };`;

const newUpdateData = `                    updateData = {
                        price: result.price,
                        change: result.variation,
                        changeValue: changeVal,
                        pe: asset.pe,
                        name: asset.name,
                        currency: asset.currency || 'EUR',
                        exchange: asset.exchange,
                        country: asset.country,
                        quoteDate: result.quoteDate || new Date().toISOString().split('T')[0]
                    };`;

code = code.replace(oldUpdateData, newUpdateData);

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched B_ITA quoteDate');
