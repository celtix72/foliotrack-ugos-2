const fs = require('fs');

let content = fs.readFileSync('private_views/market_overview.html', 'utf8');

const oldAiBtn = `<button onclick="event.stopPropagation(); openAssetAiHistoryModal('\${a.ticker}')" class="h-8 w-8 rounded-lg bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center mr-1" title="Storico IA">
                        <span class="material-symbols-outlined text-base">smart_toy</span>
                    </button>`;

const newAiBtn = `\${(function() {
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

content = content.replace(oldAiBtn, newAiBtn);

fs.writeFileSync('private_views/market_overview.html', content, 'utf8');
