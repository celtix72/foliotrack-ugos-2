const fs = require('fs');
let code = fs.readFileSync('private_views/watchlist.html', 'utf8');

const oldTrendLogic = `                    let shortTrend = trendClean;
                    const trendMatch = trendClean.match(/^(Rialzista|Ribassista|Laterale|Buy|Sell|Hold)/i);
                    if (trendMatch) {
                        shortTrend = trendMatch[1];
                    } else if (shortTrend.length > 12) {
                        shortTrend = shortTrend.substring(0, 10) + '...';
                    }`;

const newTrendLogic = `                    let shortTrend = trendClean;
                    const trendMatch = trendClean.match(/^(Rialzista|Ribassista|Laterale|Buy|Sell|Hold|Positivo|Negativo)/i);
                    if (trendMatch) {
                        const t = trendMatch[1].toLowerCase();
                        if (t === 'rialzista' || t === 'buy' || t === 'positivo') {
                            shortTrend = '<span class="material-symbols-outlined text-emerald-500" style="font-size: 20px;">trending_up</span>';
                        } else if (t === 'ribassista' || t === 'sell' || t === 'negativo') {
                            shortTrend = '<span class="material-symbols-outlined text-rose-500" style="font-size: 20px;">trending_down</span>';
                        } else {
                            shortTrend = '<span class="material-symbols-outlined text-amber-500" style="font-size: 20px;">trending_flat</span>';
                        }
                    } else if (trendClean !== '—') {
                        shortTrend = '<span class="material-symbols-outlined text-slate-400" style="font-size: 18px;">info</span>';
                    } else {
                        shortTrend = '<span class="text-slate-400">—</span>';
                    }`;

code = code.replace(oldTrendLogic, newTrendLogic);
fs.writeFileSync('private_views/watchlist.html', code, 'utf8');
console.log('Patched trend logic');
