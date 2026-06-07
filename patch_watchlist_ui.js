const fs = require('fs');

let content = fs.readFileSync('private_views/watchlist.html', 'utf8');

const oldAiBadge = `const count = item.aiHistoryCount || 0;
                    const aiBadge = count > 0 ? \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-emerald-500/30 text-emerald-500 bg-emerald-500/10 cursor-pointer hover:bg-emerald-500/20 transition-colors ml-2" title="Storico Analisi IA">
                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span> \${count}
                        </span>
                    \` : \`
                        <span onclick="event.stopPropagation(); window.openAssetAiHistoryModal('\${item.ticker}', '\${(item.name || '').replace(/'/g, "\\\\'")}', '\${item.currency || 'EUR'}')" class="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter flex items-center gap-1 border border-slate-400/30 text-slate-400 bg-slate-400/10 cursor-pointer hover:bg-slate-400/20 transition-colors ml-2" title="Genera Analisi IA">
                            <span class="material-symbols-outlined" style="font-size: 12px;">smart_toy</span>
                        </span>
                    \`;`;

const newAiBadge = `const count = item.aiHistoryCount || 0;
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

content = content.replace(oldAiBadge, newAiBadge);

fs.writeFileSync('private_views/watchlist.html', content, 'utf8');
