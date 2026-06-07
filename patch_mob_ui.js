const fs = require('fs');
let content = fs.readFileSync('private_views/watchlist_mobile.html', 'utf8');

const oldBlock = `                                \${ (a.aiHistoryCount || 0) > 0 ? \`
                                    <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-emerald-500/30 text-emerald-500 bg-emerald-500/10 cursor-pointer">
                                        <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${a.aiHistoryCount}
                                    </span>
                                \` : \`
                                    <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker.replace(/'/g, "\\\\'")}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer">
                                        <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                                    </span>
                                \`}`;

const newBlock = `\${(function() {
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

content = content.replace(oldBlock, newBlock);
fs.writeFileSync('private_views/watchlist_mobile.html', content, 'utf8');
