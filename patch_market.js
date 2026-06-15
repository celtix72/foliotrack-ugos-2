const fs = require('fs');
let html = fs.readFileSync('private_views/market_overview.html', 'utf8');

// 1. Insert button in edit modal
const editModalInsertTarget = `<p class="text-[10px] text-slate-500 italic">Leave at 0 to disable alerts. Choose B_ITA for Borsa Italiana data.</p>`;
const splitButtonHtml = `
                <div class="pt-4 border-t border-slate-100 dark:border-slate-800 mt-4">
                    <button onclick="openSplitModal()" class="w-full py-2 rounded-xl font-bold text-sm bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">call_split</span>
                        Frazionamento / Raggruppamento (Split)
                    </button>
                </div>`;
html = html.replace(editModalInsertTarget, editModalInsertTarget + splitButtonHtml);

// 2. Insert new Split modal
const splitModalHtml = `
    <!-- Split Asset Modal -->
    <div id="split-asset-modal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center hidden p-4">
        <div class="bg-white dark:bg-surface-dark w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden max-h-[90vh] flex flex-col">
            <div class="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <h3 class="font-black text-lg flex items-center gap-2">
                    <span class="material-symbols-outlined text-indigo-500">call_split</span>
                    Stock Split
                </h3>
                <button onclick="closeSplitModal()" class="text-slate-400 hover:text-rose-500 transition-colors">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="p-6 space-y-4">
                <input type="hidden" id="split-old-ticker"/>
                <div class="space-y-2">
                    <label class="text-sm font-bold text-slate-500 uppercase">Asset: <span id="split-asset-name" class="text-slate-900 dark:text-white">--</span></label>
                </div>
                
                <div class="bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 p-3 rounded-xl text-xs font-bold flex gap-2">
                    <span class="material-symbols-outlined text-base">warning</span>
                    <div>Attenzione: questa operazione modificherà lo storico (prezzi e quantità) di tutti i portafogli per mantenere i grafici coerenti.</div>
                </div>

                <div class="space-y-2">
                    <label class="text-xs font-bold text-slate-400 uppercase tracking-widest">Data Effettiva dello Split</label>
                    <input id="split-date" type="date" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold"/>
                </div>

                <div class="space-y-2">
                    <label class="text-xs font-bold text-slate-400 uppercase tracking-widest">Rapporto (Nuove Azioni : 1 Vecchia)</label>
                    <input id="split-ratio" type="number" step="any" placeholder="es. 10 (Split 1:10) o 0.1 (Raggruppamento 10:1)" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold"/>
                    <p class="text-[10px] text-slate-500 italic">Inserisci 10 se 1 vecchia azione diventa 10 nuove. Inserisci 0.1 se 10 vecchie azioni diventano 1 nuova.</p>
                </div>
                
                <div class="space-y-2">
                    <label class="text-xs font-bold text-slate-400 uppercase tracking-widest">Nuovo Ticker (Opzionale)</label>
                    <input id="split-new-ticker" type="text" placeholder="Lascia vuoto se il Ticker non cambia" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold uppercase"/>
                </div>

                <div class="pt-2 flex gap-3">
                    <button onclick="closeSplitModal()" class="flex-1 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all">Annulla</button>
                    <button onclick="executeSplit()" class="flex-1 py-3 rounded-xl font-bold text-white bg-indigo-500 hover:bg-indigo-600 shadow-lg shadow-indigo-500/30 transition-all">Esegui Split</button>
                </div>
            </div>
        </div>
    </div>
`;
html = html.replace('<!-- Alert Edit Modal -->', splitModalHtml + '\n    <!-- Alert Edit Modal -->');

// 3. Insert Javascript functions
const jsInsertTarget = `window.closeAlertModal = function() {`;
const splitJsHtml = `
window.openSplitModal = function() {
    closeAlertModal();
    const ticker = document.getElementById('edit-asset-id').value;
    const a = allAssets.find(x => x.ticker === ticker);
    if (!a) return;
    
    document.getElementById('split-old-ticker').value = a.ticker;
    document.getElementById('split-asset-name').innerText = a.ticker;
    document.getElementById('split-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('split-ratio').value = '';
    document.getElementById('split-new-ticker').value = '';
    
    document.getElementById('split-asset-modal').classList.remove('hidden');
}

window.closeSplitModal = function() {
    document.getElementById('split-asset-modal').classList.add('hidden');
}

window.executeSplit = async function() {
    const oldTicker = document.getElementById('split-old-ticker').value;
    const splitDate = document.getElementById('split-date').value;
    const ratio = parseFloat(document.getElementById('split-ratio').value);
    let newTicker = document.getElementById('split-new-ticker').value.trim().toUpperCase();
    
    if (!splitDate || isNaN(ratio) || ratio <= 0) {
        alert("Inserisci una data valida e un rapporto maggiore di 0");
        return;
    }
    
    if (!confirm("Sei sicuro di voler eseguire lo split? L'operazione modificherà lo storico di tutte le transazioni per l'asset.")) {
        return;
    }

    try {
        const res = await fetch('/api/assets/split', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldTicker, newTicker, ratio, splitDate })
        });
        
        if (res.ok) {
            closeSplitModal();
            loadAssets();
        } else {
            const data = await res.json();
            alert("Errore durante lo split: " + (data.error || 'Errore sconosciuto'));
        }
    } catch (e) {
        console.error(e);
        alert("Errore di rete durante lo split");
    }
}

`;
html = html.replace(jsInsertTarget, splitJsHtml + jsInsertTarget);

fs.writeFileSync('private_views/market_overview.html', html, 'utf8');
console.log('market_overview patched');
