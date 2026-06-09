const fs = require('fs');
let code = fs.readFileSync('private_views/market_overview.html', 'utf8');

// 1. Put back the <th>Actions</th>
const targetStopTh = '<th class="px-5 py-3 hidden sm:table-cell">Target/Stop</th>';
code = code.replace(targetStopTh, targetStopTh + '\n                        <th class="px-5 py-3 text-right">Actions</th>');

// 2. Remove the AI badges block from the Actions <td>
const aiBadgesBlock = `                    \${(function() {
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
                                
                                const fvStr = badge.aiTargetPrice ? formatAiFv(badge.aiTargetPrice, a.currency) : badge.aiAction;
                                return \`<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 px-2 rounded-lg \${bgClass} transition-all flex items-center justify-center mr-1 font-black text-[10px] whitespace-nowrap" title="\${engine}: \${fvStr}">
                                    <span class="material-symbols-outlined text-base mr-1">\${icon}</span>\${fvStr}
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

code = code.replace(aiBadgesBlock, '');

fs.writeFileSync('private_views/market_overview.html', code, 'utf8');
console.log('Patched Actions column');
