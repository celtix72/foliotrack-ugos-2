/**
 * Shared Mobile Transaction Logic & UI Injection
 * This script handles the global "+" FAB and the Transaction Modal on mobile pages.
 */

(function() {
    let modalInjected = false;

    window.injectMobileModal = function() {
        if (!document.body) return;
        if (document.getElementById('transaction-modal')) {
            modalInjected = true;
            return;
        }

        const modalHtml = `
        <div id="transaction-modal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[20000] flex items-center justify-center p-3" style="display:none; color: var(--mob-text);">
            <div class="bg-white dark:bg-[#111722] border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col overflow-hidden">
                <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <h3 id="t-modal-title" class="font-bold text-base">Operazione</h3>
                    <button type="button" onclick="closeTransactionModal()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <form id="transaction-form" class="p-4 space-y-3 overflow-y-auto custom-scrollbar" onsubmit="handleMobileTransactionSubmit(event)">
                    <input type="hidden" id="t-id"/>
                    <div class="grid grid-cols-1 gap-4">
                        <div class="grid grid-cols-2 gap-3">
                            <div class="space-y-1">
                                <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Tipo</label>
                                <select id="t-type" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold" onchange="toggleTransactionFields()">
                                    <option value="BUY">ACQUISTO</option>
                                    <option value="SELL">VENDITA</option>
                                    <option value="DIVIDEND">DIVIDENDO</option>
                                    <option value="DEPOSIT">DEPOSITO</option>
                                    <option value="WITHDRAWAL">PRELIEVO</option>
                                    <option value="TAX">TASSE</option>
                                    <option value="TRANSFER">TRASFERIMENTO</option>
                                </select>
                            </div>
                            <div class="space-y-1">
                                <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Data</label>
                                <input id="t-date" type="date" required class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold"/>
                            </div>
                        </div>

                        <div id="t-dest-portfolio-field" class="space-y-1 hidden">
                            <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Destinazione</label>
                            <select id="t-dest-portfolio" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold">
                                <option value="">— Seleziona —</option>
                            </select>
                        </div>

                        <div id="t-asset-field" class="space-y-1 relative">
                            <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Asset (Cerca Ticker)</label>
                            <input id="t-asset-search" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold" placeholder="Es. AAPL, ISP.MI..." autocomplete="off" onkeyup="handleMobileAssetSearch(this.value)"/>
                            <div id="t-search-results" class="absolute left-0 right-0 mt-1 bg-white dark:bg-[#1a2332] border rounded-xl shadow-2xl z-[20001] hidden max-h-48 overflow-y-auto"></div>
                            <input type="hidden" id="t-asset-ticker"/>
                            <input type="hidden" id="t-asset-currency"/>
                        </div>

                        <div class="grid grid-cols-2 gap-3" id="t-stock-fields">
                            <div class="space-y-1">
                                <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Quantità</label>
                                <input id="t-qty" type="number" step="any" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold" placeholder="0.00" oninput="calculateNetDividend()"/>
                            </div>
                            <div class="space-y-1">
                                <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Prezzo</label>
                                <input id="t-price" type="number" step="any" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold" placeholder="0.00" oninput="calculateNetDividend()"/>
                            </div>
                        </div>

                        <div id="t-amount-field" class="space-y-1 hidden">
                            <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Importo Totale</label>
                            <input id="t-amount" type="number" step="any" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold" placeholder="0.00"/>
                        </div>

                        <div class="grid grid-cols-2 gap-3">
                            <div class="space-y-1">
                                <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Comm.</label>
                                <input id="t-comm" type="number" step="any" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold" value="0"/>
                            </div>
                            <div class="space-y-1">
                                <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Tasse</label>
                                <input id="t-tax" type="number" step="any" class="w-full bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-xl py-2 px-3 text-sm font-bold" value="0" oninput="calculateNetDividend()"/>
                            </div>
                        </div>

                        <div id="t-fx-field" class="hidden">
                            <div class="p-3 bg-primary/5 border border-primary/20 rounded-xl flex items-center justify-between">
                                <span class="text-[10px] font-bold text-slate-500 uppercase">Cambio FX (<span id="asset-curr-label">?</span>/<span id="p-curr-label">?</span>)</span>
                                <input id="t-fx" type="number" step="any" class="w-24 text-right bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 rounded-lg py-1 px-2 font-black text-sm" value="1" oninput="calculateNetDividend()"/>
                            </div>
                        </div>
                    </div>
                    <div class="pt-4 flex gap-3">
                        <button type="button" onclick="closeTransactionModal()" class="flex-1 py-3 rounded-xl font-bold text-slate-500 bg-slate-100 dark:bg-slate-800">Annulla</button>
                        <button type="submit" class="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold shadow-lg shadow-emerald-600/20">Conferma</button>
                    </div>
                </form>
            </div>
        </div>
        
        <div id="global-mob-fab" class="mob-fab" onclick="openTransactionModal()" style="display: flex;">
            <span class="material-symbols-outlined">add</span>
        </div>
        `;

        const wrapper = document.createElement('div');
        wrapper.id = 'mobile-modal-wrapper';
        wrapper.innerHTML = modalHtml;
        document.body.appendChild(wrapper);
        modalInjected = true;
        
        loadPortfoliosForTransfer();
    };

    async function loadPortfoliosForTransfer() {
        try {
            const res = await fetch('/api/portfolios');
            const data = await res.json();
            const select = document.getElementById('t-dest-portfolio');
            if (select) {
                const currentP = window.mobCurrentPortfolioId || window.currentPortfolioId;
                select.innerHTML = '<option value="">— Seleziona Target —</option>' + 
                    data.portfolios.filter(p => p.id != currentP).map(p => `<option value="${p.id}">${p.name} (${p.currency})</option>`).join('');
            }
        } catch(e) {}
    }

    window.openTransactionModal = function(ticker = '') {
        injectMobileModal();
        
        // Wait a small bit if it was JUST injected, though appendChild is sync
        const modal = document.getElementById('transaction-modal');
        if (modal) {
            modal.style.display = 'flex';
            // Ensure FAB is visible too if needed
            const fab = document.getElementById('global-mob-fab');
            if (fab) fab.style.display = 'flex';
        }
        
        const form = document.getElementById('transaction-form');
        if (form) form.reset();
        
        document.getElementById('t-id').value = '';
        document.getElementById('t-modal-title').innerText = "Nuova Transazione";
        document.getElementById('t-date').value = new Date().toISOString().split('T')[0];
        
        if (ticker) {
            document.getElementById('t-asset-search').value = ticker;
            document.getElementById('t-asset-ticker').value = ticker;
            handleMobileAssetSearch(ticker, true); 
        }
        
        toggleTransactionFields();
    };

    window.closeTransactionModal = function() {
        const modal = document.getElementById('transaction-modal');
        if (modal) modal.style.display = 'none';
        // Clear search results
        const results = document.getElementById('t-search-results');
        if (results) results.classList.add('hidden');
    };

    window.toggleTransactionFields = function() {
        const type = document.getElementById('t-type').value;
        const isTrade = ['BUY', 'SELL'].includes(type);
        const isDividend = type === 'DIVIDEND';
        const isCash = ['DEPOSIT', 'WITHDRAWAL', 'TAX', 'DIVIDEND', 'TRANSFER'].includes(type);
        
        const assetField = document.getElementById('t-asset-field');
        const stockFields = document.getElementById('t-stock-fields');
        const amountField = document.getElementById('t-amount-field');
        const destField = document.getElementById('t-dest-portfolio-field');

        if (assetField) assetField.style.display = (isTrade || isDividend) ? 'block' : 'none';
        if (stockFields) stockFields.style.display = (isTrade || isDividend) ? 'grid' : 'none';
        if (amountField) amountField.style.display = isCash ? 'block' : 'none';
        if (destField) destField.style.display = (type === 'TRANSFER') ? 'block' : 'none';
        
        checkFX();
        calculateNetDividend();
    };

    function checkFX() {
        const assetCurr = document.getElementById('t-asset-currency')?.value || 'EUR';
        const pCurr = window.portfolioCurrency || 'EUR';
        const fxField = document.getElementById('t-fx-field');
        if (fxField) {
            if (assetCurr !== pCurr) {
                fxField.style.display = 'block';
                document.getElementById('asset-curr-label').innerText = assetCurr;
                document.getElementById('p-curr-label').innerText = pCurr;
            } else {
                fxField.style.display = 'none';
                document.getElementById('t-fx').value = 1;
            }
        }
    }

    window.calculateNetDividend = function() {
        const type = document.getElementById('t-type').value;
        if (type !== 'DIVIDEND') return;

        const qty = parseFloat(document.getElementById('t-qty').value) || 0;
        const price = parseFloat(document.getElementById('t-price').value) || 0;
        const tax = parseFloat(document.getElementById('t-tax').value) || 0;
        const fx = parseFloat(document.getElementById('t-fx').value) || 1;

        const gross = (qty * price) / fx;
        const net = gross - (tax / fx);
        document.getElementById('t-amount').value = net.toFixed(2);
    };

    window.handleMobileAssetSearch = async function(query, silent = false) {
        if (!query || query.length < 2) {
            if (!silent) document.getElementById('t-search-results').classList.add('hidden');
            return;
        }
        try {
            const res = await fetch(`/api/market/search?query=${query}`);
            const data = await res.json();
            if (silent) {
                if (data.length > 0) {
                    document.getElementById('t-asset-currency').value = data[0].currency;
                    checkFX();
                }
                return;
            }
            const results = document.getElementById('t-search-results');
            results.innerHTML = data.map(a => `
                <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800 active:bg-slate-50 cursor-pointer" onclick="selectMobileAsset('${a.ticker}', '${a.currency}', '${a.name}')">
                    <div class="font-bold text-sm">${a.ticker}</div>
                    <div class="text-[10px] text-slate-500">${a.name} • ${a.exchange}</div>
                </div>
            `).join('');
            results.classList.remove('hidden');
        } catch(e) {}
    };

    window.selectMobileAsset = function(ticker, currency, name) {
        document.getElementById('t-asset-search').value = ticker;
        document.getElementById('t-asset-ticker').value = ticker;
        document.getElementById('t-asset-currency').value = currency;
        document.getElementById('t-search-results').classList.add('hidden');
        checkFX();
        calculateNetDividend();
    };

    window.handleMobileTransactionSubmit = async function(e) {
        e.preventDefault();
        const pId = window.mobCurrentPortfolioId || window.currentPortfolioId;
        if (!pId) {
            alert("Seleziona un portafoglio prima di operare.");
            return;
        }

        const id = document.getElementById('t-id').value;
        const formData = {
            portfolioId: pId,
            type: document.getElementById('t-type').value,
            date: document.getElementById('t-date').value,
            ticker: document.getElementById('t-asset-ticker').value,
            quantity: parseFloat(document.getElementById('t-qty').value) || 0,
            price: parseFloat(document.getElementById('t-price').value) || 0,
            amount: parseFloat(document.getElementById('t-amount').value) || 0,
            commission: parseFloat(document.getElementById('t-comm').value) || 0,
            tax: parseFloat(document.getElementById('t-tax').value) || 0,
            fxRate: parseFloat(document.getElementById('t-fx').value) || 1,
            destPortfolioId: document.getElementById('t-dest-portfolio')?.value || null
        };

        const method = id ? 'PUT' : 'POST';
        const url = id ? `/api/transactions/${id}` : '/api/transactions';

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            if (res.ok) {
                if (window.showNotification) showNotification(id ? "Modificata!" : "Inserita!", "success");
                else alert(id ? "Modificata!" : "Inserita!");
                closeTransactionModal();
                refreshAllMobileData(pId);
            } else {
                const err = await res.json();
                alert("Errore: " + (err.error || "Salvataggio fallito"));
            }
        } catch(e) { alert("Errore di rete"); }
    };

    function refreshAllMobileData(pId) {
        if (typeof mobUpdateDashboard === 'function') mobUpdateDashboard();
        if (typeof mobLoadPortfolioDetail === 'function') mobLoadPortfolioDetail(pId);
        if (typeof loadHistory === 'function') loadHistory();
        window.dispatchEvent(new CustomEvent('market-data-updated'));
        window.dispatchEvent(new CustomEvent('portfolios-updated'));
    }

    // Shared Edit/Duplicate/Delete helpers
    window.mobileEditTransaction = function(t) {
        injectMobileModal();
        openTransactionModal();
        document.getElementById('t-modal-title').innerText = "Modifica Transazione";
        document.getElementById('t-id').value = t.id;
        document.getElementById('t-type').value = t.type;
        document.getElementById('t-date').value = t.date;
        document.getElementById('t-qty').value = t.quantity || 0;
        document.getElementById('t-price').value = t.price || 0;
        document.getElementById('t-amount').value = t.amount || 0;
        document.getElementById('t-comm').value = t.commission || 0;
        document.getElementById('t-tax').value = t.tax || 0;
        document.getElementById('t-fx').value = t.exchangeRate || t.fxRate || 1;
        document.getElementById('t-asset-ticker').value = t.assetTicker || t.ticker || '';
        document.getElementById('t-asset-search').value = t.assetTicker || t.ticker || '';
        
        // Find asset currency from current holdings if possible
        if (window.currentHoldings) {
            const h = window.currentHoldings.find(hold => hold.ticker === (t.assetTicker || t.ticker));
            if (h) document.getElementById('t-asset-currency').value = h.currency;
        }
        
        toggleTransactionFields();
    };

    window.mobileDuplicateTransaction = function(t) {
        mobileEditTransaction(t);
        document.getElementById('t-id').value = '';
        document.getElementById('t-modal-title').innerText = "Duplica Transazione";
        document.getElementById('t-date').value = new Date().toISOString().split('T')[0];
    };

    window.mobileDeleteTransaction = async function(id) {
        if (!confirm("Eliminare questa transazione?")) return;
        try {
            const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
            if (res.ok) {
                const pId = window.mobCurrentPortfolioId || window.currentPortfolioId;
                refreshAllMobileData(pId);
            }
        } catch(e) {}
    };

    // Auto-inject on mobile view
    function autoInit() {
        if (window._mobileViewActive || document.body.classList.contains('mobile-view-active') || window.innerWidth < 1024) {
            injectMobileModal();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }
    
    // Also try again after a delay to catch late-setting _mobileViewActive
    setTimeout(autoInit, 500);
})();
