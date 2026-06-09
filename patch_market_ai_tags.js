const fs = require('fs');
let code = fs.readFileSync('private_views/market_overview.html', 'utf8');

const oldAiBadges = `                                        return a.aiBadges.map(badge => {
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
                                            
                                            const fvStr = badge.aiTargetPrice ? formatAiFv(badge.aiTargetPrice, a.currency) : badge.aiAction;
                                            return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-6 px-1.5 rounded \${bgClass} transition-all flex items-center justify-center font-black text-[9px] whitespace-nowrap" title="\${engine}: \${fvStr}">
                                                <span class="material-symbols-outlined text-[12px] mr-1">\${icon}</span>\${fvStr}
                                            </button>\`;
                                        }).join('');
                                    } else if (a.aiHistoryCount > 0) {
                                        return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-6 px-1.5 rounded bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center font-black text-[9px] whitespace-nowrap" title="Storico IA (\${a.aiHistoryCount})">
                                            <span class="material-symbols-outlined text-[12px] mr-1">smart_toy</span>\${a.aiHistoryCount}
                                        </button>\`;
                                    } else {
                                        return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-6 w-6 rounded bg-slate-500/10 text-slate-500 hover:bg-slate-500 hover:text-white transition-all flex items-center justify-center" title="Genera Analisi IA">
                                            <span class="material-symbols-outlined text-[12px]">smart_toy</span>
                                        </button>\`;
                                    }`;

const newAiBadges = `                                        return a.aiBadges.map(badge => {
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
                                            
                                            const fvStr = badge.aiTargetPrice ? formatAiFv(badge.aiTargetPrice, a.currency) : badge.aiAction;
                                            
                                            return \`
                                            <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border \${colorClass} cursor-pointer transition-colors whitespace-nowrap" title="\${engine}: \${badge.aiAction} ">
                                                <span class="material-symbols-outlined" style="font-size: 12px;">\${icon}</span> \${fvStr}
                                            </span>\`;
                                        }).join('');
                                    } else if (a.aiHistoryCount > 0) {
                                        return \`
                                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-500/30 text-slate-500 bg-slate-500/10 cursor-pointer hover:bg-slate-500/20 transition-colors" title="Storico Analisi IA">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${a.aiHistoryCount}
                                        </span>\`;
                                    } else {
                                        return \`
                                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${a.ticker}', '\${(a.name || '').replace(/'/g, "\\\\'")}', '\${a.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer hover:bg-slate-400/20 transition-colors" title="Genera Analisi IA">
                                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                                        </span>\`;
                                    }`;

code = code.replace(oldAiBadges, newAiBadges);
fs.writeFileSync('private_views/market_overview.html', code, 'utf8');
console.log('Patched AI badges');
