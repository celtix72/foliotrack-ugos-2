const fs = require('fs');

let content = fs.readFileSync('private_views/market_mobile.html', 'utf8');

const oldBlock = `\${(function() {
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
                            return \`<button onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="h-6 px-1.5 rounded \${bgClass} transition-all flex items-center justify-center mr-1 font-black text-[9px] whitespace-nowrap" title="\${engine}: \${a.aiAction}\${fv}">
                                <span class="material-symbols-outlined text-[10px] mr-0.5">\${icon}</span>\${a.aiAction}\${fv}
                            </button>\`;
                        } else if (a.aiHistoryCount > 0) {
                            return \`<button onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="h-6 px-1.5 rounded bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1 font-black text-[9px]" title="Storico IA (\${a.aiHistoryCount})">
                                <span class="material-symbols-outlined text-[10px] mr-0.5">smart_toy</span>\${a.aiHistoryCount}
                            </button>\`;
                        } else {
                            return \`<button onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="h-6 w-6 rounded bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1" title="Storico IA">
                                <span class="material-symbols-outlined text-[12px]">smart_toy</span>
                            </button>\`;
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
                                
                                let bgClass = 'bg-slate-500/10 text-slate-500 hover:bg-slate-500 hover:text-white';
                                if (badge.aiAction === 'BUY' || badge.aiAction === 'INCREASE') bgClass = 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500 hover:text-white';
                                else if (badge.aiAction === 'SELL' || badge.aiAction === 'DECREASE') bgClass = 'bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white';
                                
                                const fv = badge.aiTargetPrice ? \` • \${formatCurrency(badge.aiTargetPrice, a.currency)}\` : '';
                                return \`<button onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="h-6 px-1.5 rounded \${bgClass} transition-all flex items-center justify-center mr-1 font-black text-[9px] whitespace-nowrap" title="\${engine}: \${badge.aiAction}\${fv}">
                                    <span class="material-symbols-outlined text-[10px] mr-0.5">\${icon}</span>\${badge.aiAction}\${fv}
                                </button>\`;
                            }).join('');
                        } else if (a.aiHistoryCount > 0) {
                            return \`<button onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="h-6 px-1.5 rounded bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1 font-black text-[9px]" title="Storico IA (\${a.aiHistoryCount})">
                                <span class="material-symbols-outlined text-[10px] mr-0.5">smart_toy</span>\${a.aiHistoryCount}
                            </button>\`;
                        } else {
                            return \`<button onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="h-6 w-6 rounded bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1" title="Storico IA">
                                <span class="material-symbols-outlined text-[12px]">smart_toy</span>
                            </button>\`;
                        }
                    })()}`;

if (content.includes(oldBlock)) {
    content = content.replace(oldBlock, newBlock);
    fs.writeFileSync('private_views/market_mobile.html', content, 'utf8');
    console.log('patched market_mobile.html');
} else {
    // maybe it has the <span> instead of <button> format?
    const oldBlock2 = `\${ (a.aiHistoryCount || 0) > 0 ? \`
                      <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-emerald-500/30 text-emerald-500 bg-emerald-500/10 cursor-pointer">
                          <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${a.aiHistoryCount}
                      </span>
                  \` : \`
                      <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer">
                          <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                      </span>
                  \`}`;
    
    const newBlock2 = `\${(function() {
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

    if (content.includes(oldBlock2)) {
        content = content.replace(oldBlock2, newBlock2);
        fs.writeFileSync('private_views/market_mobile.html', content, 'utf8');
        console.log('patched market_mobile.html span');
    }
}
