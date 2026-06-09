const fs = require('fs');
let code = fs.readFileSync('public/asset_chart_component.js', 'utf8');

const oldFetch = `        // Fetch available engines
        fetch('/api/ai/available-engines').then(r => r.json()).then(data => {
            const select = document.getElementById('ai-modal-engine-select');
            if (select && data.engines) {
                select.innerHTML = data.engines.map(e => \`<option value="\${e}" \${e === data.default ? 'selected' : ''}>\${e === 'Both' ? 'Gemini + Qwen' : e}</option>\`).join('');
            }
        }).catch(e => console.error("Error loading engines", e));`;

const newFetch = `        // Fetch available engines
        fetch('/api/ai/available-engines').then(r => r.json()).then(data => {
            const select = document.getElementById('ai-modal-engine-select');
            if (select && data.engines) {
                select.innerHTML = data.engines.map(e => {
                    let label = e;
                    if (e === 'Both') label = 'Gemini + Qwen';
                    else label = e.replace(/_(Free|Pay)/, ' ($1)');
                    return \`<option value="\${e}" \${e === data.default ? 'selected' : ''}>\${label}</option>\`;
                }).join('');
            }
        }).catch(e => console.error("Error loading engines", e));`;

code = code.replace(oldFetch, newFetch);

fs.writeFileSync('public/asset_chart_component.js', code, 'utf8');
console.log('Patched asset_chart_component.js');
