const fs = require('fs');
let code = fs.readFileSync('private_views/market_overview.html', 'utf8');

// 1. Remove 'Actions' column header
code = code.replace('<th class="px-5 py-3 text-right">Actions</th>', '');

// 2. Reduce font size of asset name and insert the AI badges right after it
// Old name rendering:
const oldName = '<p class="font-black text-lg text-slate-900 dark:text-white leading-none flex items-center">${a.name} ${aiBadge}</p>';

// New name rendering with badges:
const newName = `<div class="flex items-center gap-2">
                                <p class="font-black text-sm text-slate-900 dark:text-white leading-none">\${a.name}</p>
                                \${(function() {
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
                                    }
                                })()}
                            </div>`;

code = code.replace(oldName, newName);

// 3. Remove the old right-aligned actions column completely
// The td structure is:
/*
            <td class="px-5 py-1.5 text-right">
                <div class="flex items-center justify-end gap-1">
                    ${(function() {
...
                    })()}
                </div>
            </td>
*/
const actionsTdRegex = /<td class="px-5 py-1\.5 text-right">\s*<div class="flex items-center justify-end gap-1">\s*\$\{\(function\(\) \{[\s\S]*?\}\)\(\)\}\s*<\/div>\s*<\/td>/;
code = code.replace(actionsTdRegex, '');

// 4. Remove sparkline from Performance column
const sparklineRegex = /<!-- Sparkline -->\s*<div class="hidden md:block">\s*<canvas id="sparkline-\$\{a\.ticker\}" width="60" height="24" class="opacity-80"><\/canvas>\s*<\/div>/;
code = code.replace(sparklineRegex, '');

fs.writeFileSync('private_views/market_overview.html', code, 'utf8');
console.log('Patched market_overview.html');
