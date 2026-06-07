const fs = require('fs');
let code = fs.readFileSync('public/asset_chart_component.js', 'utf8');

const oldHeader = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                            <h4 class="text-slate-900 dark:text-white" style="font-size: 13px; font-weight: 900; display: flex; align-items: center; gap: 4px; margin: 0;">
                                Storico Analisi
                            </h4>
                            <button id="ai-modal-run-btn" onclick="window.runAssetAi()" style="background: var(--mob-primary); color: white; padding: 8px 16px; border-radius: 10px; border: none; font-weight: bold; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(19,91,236,0.2);">
                                <span class="material-symbols-outlined" style="font-size: 16px;">add</span> Nuova Analisi
                            </button>
                        </div>`;

const newHeader = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                            <h4 class="text-slate-900 dark:text-white" style="font-size: 13px; font-weight: 900; display: flex; align-items: center; gap: 4px; margin: 0;">
                                Storico Analisi
                            </h4>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <select id="ai-modal-engine-select" style="font-size: 11px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.3); background: transparent; cursor: pointer; outline: none; font-weight: 600;" class="text-slate-700 dark:text-slate-300">
                                    <option value="">Default (Caricamento...)</option>
                                </select>
                                <button id="ai-modal-run-btn" onclick="window.runAssetAi()" style="background: var(--mob-primary); color: white; padding: 8px 16px; border-radius: 10px; border: none; font-weight: bold; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(19,91,236,0.2);">
                                    <span class="material-symbols-outlined" style="font-size: 16px;">add</span> Nuova Analisi
                                </button>
                            </div>
                        </div>`;

code = code.replace(oldHeader, newHeader);

// Add the fetch logic for available engines right before loadAssetAiHistory
const loadEnginesLogic = `        window.loadAssetAiHistory(ticker);
        
        // Fetch available engines
        fetch('/api/ai/available-engines').then(r => r.json()).then(data => {
            const select = document.getElementById('ai-modal-engine-select');
            if (select && data.engines) {
                select.innerHTML = data.engines.map(e => \`<option value="\${e}" \${e === data.default ? 'selected' : ''}>\${e === 'Both' ? 'Gemini + Qwen' : e}</option>\`).join('');
            }
        }).catch(e => console.error("Error loading engines", e));`;

code = code.replace("        window.loadAssetAiHistory(ticker);", loadEnginesLogic);

// Update runAssetAi to pass the selected engine
const oldRunAiEventSource = `const source = new EventSource('/api/assets/' + encodeURIComponent(_aiModalTicker) + '/ai-analysis');`;
const newRunAiEventSource = `const engineSelect = document.getElementById('ai-modal-engine-select');
        const engine = engineSelect && engineSelect.value ? '?engine=' + encodeURIComponent(engineSelect.value) : '';
        const source = new EventSource('/api/assets/' + encodeURIComponent(_aiModalTicker) + '/ai-analysis' + engine);`;

code = code.replace(oldRunAiEventSource, newRunAiEventSource);

fs.writeFileSync('public/asset_chart_component.js', code, 'utf8');
