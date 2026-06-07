const fs = require('fs');

function processWatchlist() {
    let content = fs.readFileSync('private_views/watchlist.html', 'utf8');
    const oldAiBadge = `const count = item.aiHistoryCount || 0;
                    let aiBadge = '';
                    if (count > 0 && item.aiAction) {
                        const engine = item.aiEngine || 'X';
                        let icon = 'smart_toy';
                        if (engine === 'Gemini') icon = 'auto_awesome';
                        else if (engine === 'Qwen') icon = 'chat_spark';
                        else if (engine === 'Agnes') icon = 'psychiatry';
                        else if (engine === 'OpenAI') icon = 'data_exploration';
                        else if (engine === 'X') icon = 'close';
                        
                        let colorClass = 'border-slate-500/30 text-slate-500 bg-slate-500/10 hover:bg-slate-500/20';
                        if (item.aiAction === 'BUY' || item.aiAction === 'INCREASE') colorClass = 'border-emerald-500/30 text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20';
                        else if (item.aiAction === 'SELL' || item.aiAction === 'DECREASE') colorClass = 'border-rose-500/30 text-rose-500 bg-rose-500/10 hover:bg-rose-500/20';
                        
                        const fv = item.aiTargetPrice ? \` • \${formatCurrency(item.aiTargetPrice, item.currency)}\` : '';
                        
                        aiBadge = \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border \${colorClass} cursor-pointer transition-colors ml-2 whitespace-nowrap" title="\${engine}: \${item.aiAction} \${fv}">
                            <span class="material-symbols-outlined" style="font-size: 12px;">\${icon}</span> \${item.aiAction}\${fv}
                        </span>\`;
                    } else if (count > 0) {
                         aiBadge = \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-500/30 text-slate-500 bg-slate-500/10 cursor-pointer hover:bg-slate-500/20 transition-colors ml-2" title="Storico Analisi IA">
                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${count}
                        </span>\`;
                    } else {
                        aiBadge = \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer hover:bg-slate-400/20 transition-colors ml-2" title="Genera Analisi IA">
                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                        </span>
                        \`;
                    }`;

    const newAiBadge = `const count = item.aiHistoryCount || 0;
                    let aiBadge = '';
                    if (item.aiBadges && item.aiBadges.length > 0) {
                        aiBadge = item.aiBadges.map(badge => {
                            const engine = badge.engine || 'X';
                            let icon = 'smart_toy';
                            if (engine === 'Gemini') icon = 'auto_awesome';
                            else if (engine === 'Qwen') icon = 'chat_spark';
                            else if (engine === 'Agnes') icon = 'psychiatry';
                            else if (engine === 'OpenAI') icon = 'data_exploration';
                            else if (engine === 'X') icon = 'close';
                            
                            let colorClass = 'border-slate-500/30 text-slate-500 bg-slate-500/10 hover:bg-slate-500/20';
                            if (badge.aiAction === 'BUY' || badge.aiAction === 'INCREASE') colorClass = 'border-emerald-500/30 text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20';
                            else if (badge.aiAction === 'SELL' || badge.aiAction === 'DECREASE') colorClass = 'border-rose-500/30 text-rose-500 bg-rose-500/10 hover:bg-rose-500/20';
                            
                            const fv = badge.aiTargetPrice ? \` • \${formatCurrency(badge.aiTargetPrice, item.currency)}\` : '';
                            
                            return \`
                            <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border \${colorClass} cursor-pointer transition-colors ml-2 whitespace-nowrap" title="\${engine}: \${badge.aiAction} \${fv}">
                                <span class="material-symbols-outlined" style="font-size: 12px;">\${icon}</span> \${badge.aiAction}\${fv}
                            </span>\`;
                        }).join('');
                    } else if (count > 0) {
                         aiBadge = \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-500/30 text-slate-500 bg-slate-500/10 cursor-pointer hover:bg-slate-500/20 transition-colors ml-2" title="Storico Analisi IA">
                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${count}
                        </span>\`;
                    } else {
                        aiBadge = \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer hover:bg-slate-400/20 transition-colors ml-2" title="Genera Analisi IA">
                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                        </span>
                        \`;
                    }`;
    if(content.includes(oldAiBadge)) {
        content = content.replace(oldAiBadge, newAiBadge);
        fs.writeFileSync('private_views/watchlist.html', content, 'utf8');
        console.log('patched watchlist.html');
    }
}

function processMarketOverview() {
    let content = fs.readFileSync('private_views/market_overview.html', 'utf8');
    const oldBtn = `\${(function() {
                        if (a.aiHistoryCount > 0 && a.aiAction) {
                            const engine = a.aiEngine || 'X';
                            let icon = 'smart_toy';
                            if (engine === 'Gemini') icon = 'auto_awesome';
                            else if (engine === 'Qwen') icon = 'chat_spark';
                            else if (engine === 'Agnes') icon = 'psychiatry';
                            else if (engine === 'OpenAI') icon = 'data_exploration';
                            else if (engine === 'X') icon = 'close';
                            
                            let bgClass = 'bg-slate-500/10 text-slate-500 hover:bg-slate-500 hover:text-white';
                            if (a.aiAction === 'BUY' || a.aiAction === 'INCREASE') bgClass = 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-white';
                            else if (a.aiAction === 'SELL' || a.aiAction === 'DECREASE') bgClass = 'bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white';
                            
                            const fv = a.aiTargetPrice ? \` • \${formatCurrency(a.aiTargetPrice, a.currency)}\` : '';
                            return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 px-2 rounded-lg \${bgClass} transition-all flex items-center justify-center mr-1 font-black text-[10px] whitespace-nowrap" title="\${engine}: \${a.aiAction}\${fv}">
                                <span class="material-symbols-outlined text-base mr-1">\${icon}</span>\${a.aiAction}\${fv}
                            </button>\`;
                        } else {
                            return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 w-8 rounded-lg bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1" title="Storico IA">
                                <span class="material-symbols-outlined text-base">smart_toy</span>
                            </button>\`;
                        }
                    })()}`;

    const newBtn = `\${(function() {
                        if (a.aiBadges && a.aiBadges.length > 0) {
                            return a.aiBadges.map(badge => {
                                const engine = badge.engine || 'X';
                                let icon = 'smart_toy';
                                if (engine === 'Gemini') icon = 'auto_awesome';
                                else if (engine === 'Qwen') icon = 'chat_spark';
                                else if (engine === 'Agnes') icon = 'psychiatry';
                                else if (engine === 'OpenAI') icon = 'data_exploration';
                                else if (engine === 'X') icon = 'close';
                                
                                let bgClass = 'bg-slate-500/10 text-slate-500 hover:bg-slate-500 hover:text-white';
                                if (badge.aiAction === 'BUY' || badge.aiAction === 'INCREASE') bgClass = 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-white';
                                else if (badge.aiAction === 'SELL' || badge.aiAction === 'DECREASE') bgClass = 'bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white';
                                
                                const fv = badge.aiTargetPrice ? \` • \${formatCurrency(badge.aiTargetPrice, a.currency)}\` : '';
                                return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 px-2 rounded-lg \${bgClass} transition-all flex items-center justify-center mr-1 font-black text-[10px] whitespace-nowrap" title="\${engine}: \${badge.aiAction}\${fv}">
                                    <span class="material-symbols-outlined text-base mr-1">\${icon}</span>\${badge.aiAction}\${fv}
                                </button>\`;
                            }).join('');
                        } else if (a.aiHistoryCount > 0) {
                            return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 w-8 rounded-lg bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1" title="Storico IA (\${a.aiHistoryCount})">
                                <span class="material-symbols-outlined text-base">smart_toy</span>
                            </button>\`;
                        } else {
                            return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 w-8 rounded-lg bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1" title="Storico IA">
                                <span class="material-symbols-outlined text-base">smart_toy</span>
                            </button>\`;
                        }
                    })()}`;
    if (content.includes(oldBtn)) {
        content = content.replace(oldBtn, newBtn);
        fs.writeFileSync('private_views/market_overview.html', content, 'utf8');
        console.log('patched market_overview.html');
    }
}

function processWatchlistMobile() {
    let content = fs.readFileSync('private_views/watchlist_mobile.html', 'utf8');
    const oldBlock = `\${(function() {
                                    if ((a.aiHistoryCount || 0) > 0 && a.aiAction) {
                                        const engine = a.aiEngine || 'X';
                                        let icon = 'smart_toy';
                                        if (engine === 'Gemini') icon = 'auto_awesome';
                                        else if (engine === 'Qwen') icon = 'chat_spark';
                                        else if (engine === 'Agnes') icon = 'psychiatry';
                                        else if (engine === 'OpenAI') icon = 'data_exploration';
                                        else if (engine === 'X') icon = 'close';
                                        
                                        let colorClass = 'border-slate-500/30 text-slate-500 bg-slate-500/10';
                                        if (a.aiAction === 'BUY' || a.aiAction === 'INCREASE') colorClass = 'border-emerald-500/30 text-emerald-500 bg-emerald-500/10';
                                        else if (a.aiAction === 'SELL' || a.aiAction === 'DECREASE') colorClass = 'border-rose-500/30 text-rose-500 bg-rose-500/10';
                                        
                                        const fv = a.aiTargetPrice ? \` • \${formatCurrency(a.aiTargetPrice, a.currency)}\` : '';
                                        return \`<span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border \${colorClass} cursor-pointer whitespace-nowrap">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">\${icon}</span> \${a.aiAction}\${fv}
                                        </span>\`;
                                    } else if ((a.aiHistoryCount || 0) > 0) {
                                        return \`<span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-500/30 text-slate-500 bg-slate-500/10 cursor-pointer">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${a.aiHistoryCount}
                                        </span>\`;
                                    } else {
                                        return \`<span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                                        </span>\`;
                                    }
                                })()}`;

    const newBlock = `\${(function() {
                                    if (a.aiBadges && a.aiBadges.length > 0) {
                                        return a.aiBadges.map(badge => {
                                            const engine = badge.engine || 'X';
                                            let icon = 'smart_toy';
                                            if (engine === 'Gemini') icon = 'auto_awesome';
                                            else if (engine === 'Qwen') icon = 'chat_spark';
                                            else if (engine === 'Agnes') icon = 'psychiatry';
                                            else if (engine === 'OpenAI') icon = 'data_exploration';
                                            else if (engine === 'X') icon = 'close';
                                            
                                            let colorClass = 'border-slate-500/30 text-slate-500 bg-slate-500/10';
                                            if (badge.aiAction === 'BUY' || badge.aiAction === 'INCREASE') colorClass = 'border-emerald-500/30 text-emerald-500 bg-emerald-500/10';
                                            else if (badge.aiAction === 'SELL' || badge.aiAction === 'DECREASE') colorClass = 'border-rose-500/30 text-rose-500 bg-rose-500/10';
                                            
                                            const fv = badge.aiTargetPrice ? \` • \${formatCurrency(badge.aiTargetPrice, a.currency)}\` : '';
                                            return \`<span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border \${colorClass} cursor-pointer whitespace-nowrap ml-1">
                                                <span class="material-symbols-outlined" style="font-size: 12px;">\${icon}</span> \${badge.aiAction}\${fv}
                                            </span>\`;
                                        }).join('');
                                    } else if ((a.aiHistoryCount || 0) > 0) {
                                        return \`<span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-500/30 text-slate-500 bg-slate-500/10 cursor-pointer">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${a.aiHistoryCount}
                                        </span>\`;
                                    } else {
                                        return \`<span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                                        </span>\`;
                                    }
                                })()}`;
    if (content.includes(oldBlock)) {
        content = content.replace(oldBlock, newBlock);
        fs.writeFileSync('private_views/watchlist_mobile.html', content, 'utf8');
        console.log('patched watchlist_mobile.html');
    }
}

processWatchlist();
processMarketOverview();
processWatchlistMobile();
