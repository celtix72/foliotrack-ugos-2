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
        <div id="transaction-modal" class="mob-modal-overlay">
            <div class="mob-modal-content">
                <div class="mob-modal-header">
                    <h3 id="t-modal-title" class="mob-modal-title">Nuova Transazione</h3>
                    <button type="button" onclick="closeTransactionModal()" class="mob-modal-close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <form id="transaction-form" class="mob-modal-body" onsubmit="handleMobileTransactionSubmit(event)">
                    <input type="hidden" id="t-id"/>

                    <div id="t-portfolio-field" class="mob-input-group">
                        <label class="mob-input-label">Portafoglio</label>
                        <select id="t-portfolio" class="mob-input-field">
                            <option value="">— Caricamento... —</option>
                        </select>
                    </div>
                    
                    <div class="mob-grid-2">
                        <div class="mob-input-group">
                            <label class="mob-input-label">Tipo</label>
                            <select id="t-type" class="mob-input-field" onchange="toggleTransactionFields()">
                                <option value="BUY">ACQUISTO</option>
                                <option value="SELL">VENDITA</option>
                                <option value="DIVIDEND">DIVIDENDO</option>
                                <option value="DEPOSIT">DEPOSITO</option>
                                <option value="WITHDRAWAL">PRELIEVO</option>
                                <option value="TAX">TASSE</option>
                                <option value="TRANSFER">TRASFERIMENTO</option>
                            </select>
                        </div>
                        <div class="mob-input-group">
                            <label class="mob-input-label">Data</label>
                            <input id="t-date" type="date" required class="mob-input-field"/>
                        </div>
                    </div>

                    <div id="t-dest-portfolio-field" class="mob-input-group" style="display:none">
                        <label class="mob-input-label">Destinazione</label>
                        <select id="t-dest-portfolio" class="mob-input-field">
                            <option value="">— Seleziona —</option>
                        </select>
                    </div>

                    <div class="mob-input-group">
                        <label class="mob-input-label">Sorgente Dati</label>
                        <select id="t-source" class="mob-input-field" onchange="toggleTransactionFields()">
                            <option value="YF">Yahoo Finance</option>
                            <option value="B_ITA">Borsa Italiana</option>
                            <option value="MANUAL">Manuale</option>
                        </select>
                    </div>

                    <div id="t-asset-field" class="mob-input-group" style="position:relative">
                        <label class="mob-input-label">Asset (Ticker)</label>
                        <input id="t-asset-search" class="mob-input-field" placeholder="Es. AAPL, ISP.MI, CD_IFIS..." autocomplete="off" onkeyup="handleMobileAssetSearch(this.value)"/>
                        <div id="t-search-results" class="mob-search-results" style="display:none"></div>
                        <input type="hidden" id="t-asset-ticker"/>
                        <input type="hidden" id="t-isin"/>
                    </div>

                    <div id="t-manual-asset-fields" style="display:none" class="mob-grid-2">
                        <div class="mob-input-group">
                            <label class="mob-input-label">Nome Asset</label>
                            <input id="t-asset-name" class="mob-input-field" placeholder="Es. Conto Ifis"/>
                        </div>
                        <div class="mob-input-group">
                            <label class="mob-input-label">Valuta</label>
                            <select id="t-asset-currency" class="mob-input-field">
                                <option value="EUR">EUR</option>
                                <option value="USD">USD</option>
                                <option value="GBP">GBP</option>
                                <option value="CHF">CHF</option>
                            </select>
                        </div>
                    </div>

                    <div class="mob-grid-2" id="t-stock-fields">
                        <div class="mob-input-group">
                            <label class="mob-input-label">Quantità</label>
                            <input id="t-qty" type="number" step="any" class="mob-input-field" placeholder="0.00" oninput="calculateNetDividend()"/>
                        </div>
                        <div class="mob-input-group">
                            <label class="mob-input-label">Prezzo</label>
                            <input id="t-price" type="number" step="any" class="mob-input-field" placeholder="0.00" oninput="calculateNetDividend()"/>
                        </div>
                    </div>

                    <div id="t-amount-field" class="mob-input-group" style="display:none">
                        <label class="mob-input-label">Importo Totale</label>
                        <input id="t-amount" type="number" step="any" class="mob-input-field" placeholder="0.00"/>
                    </div>

                    <div class="mob-grid-2">
                        <div class="mob-input-group">
                            <label class="mob-input-label">Comm.</label>
                            <input id="t-comm" type="number" step="any" class="mob-input-field" value="0"/>
                        </div>
                        <div class="mob-input-group">
                            <label class="mob-input-label">Tasse</label>
                            <input id="t-tax" type="number" step="any" class="mob-input-field" value="0" oninput="calculateNetDividend()"/>
                        </div>
                    </div>

                    <div id="t-fx-field" style="display:none">
                        <div class="mob-fx-pill">
                            <span class="mob-fx-label">Cambio FX (<span id="asset-curr-label">?</span>/<span id="p-curr-label">?</span>)</span>
                            <input id="t-fx" type="number" step="any" class="mob-fx-input" value="1" oninput="calculateNetDividend()"/>
                        </div>
                    </div>
                    
                    <div class="mob-modal-footer">
                        <button type="button" onclick="closeTransactionModal()" class="mob-btn mob-btn-secondary">Annulla</button>
                        <button type="submit" class="mob-btn mob-btn-success">Conferma</button>
                    </div>
                </form>
            </div>
        </div>
        
        <div id="global-mob-fab" class="mob-fab" onclick="openTransactionModal()" style="display: flex;">
            <span class="material-symbols-outlined">add</span>
        </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = modalHtml;
        
        // Append all children of tempDiv (modal and FAB) directly to body
        while (tempDiv.firstChild) {
            document.body.appendChild(tempDiv.firstChild);
        }
        
        modalInjected = true;
        loadPortfoliosForTransfer();
    };

    async function loadPortfoliosForTransfer(selectedId = null) {
        try {
            const res = await fetch('/api/portfolios');
            const data = await res.json();
            const select = document.getElementById('t-dest-portfolio');
            if (select) {
                const currentP = window.mobCurrentPortfolioId || window.currentPortfolioId;
                const portfolios = data.portfolios || data;
                select.innerHTML = '<option value="">— Seleziona Target —</option>' + 
                    portfolios.filter(p => p.id != currentP).map(p => `<option value="${p.id}">${p.name} (${p.currency})</option>`).join('');
                if (selectedId) select.value = selectedId;
            }
        } catch(e) {}
    }

    async function loadAllPortfolios(selectedId = null) {
        try {
            const res = await fetch('/api/portfolios');
            const data = await res.json();
            const select = document.getElementById('t-portfolio');
            if (select) {
                const portfolios = data.portfolios || data;
                select.innerHTML = portfolios.map(p => `<option value="${p.id}">${p.name} (${p.currency})</option>`).join('');
                
                // Set explicitly if provided, otherwise default logic
                if (selectedId) {
                    select.value = selectedId;
                } else {
                    const currentP = window.mobCurrentPortfolioId || window.currentPortfolioId;
                    if (currentP) {
                        select.value = currentP;
                    } else if (portfolios.length > 0) {
                        select.value = portfolios[0].id;
                    }
                }
            }
        } catch(e) {}
    }

    window.openTransactionModal = async function(ticker = '', portfolioId = null) {
        injectMobileModal();
        const modal = document.getElementById('transaction-modal');
        if (modal) {
            modal.classList.add('active');
            document.body.classList.add('modal-open'); // Lock scrolling
            // Ensure FAB is visible
            const fab = document.getElementById('global-mob-fab');
            if (fab) fab.style.display = 'flex';
            
            // Populate and set default portfolio
            await loadAllPortfolios(portfolioId);
            await loadPortfoliosForTransfer();
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
        if (modal) {
            modal.classList.remove('active');
            document.body.classList.remove('modal-open'); // Unlock scrolling
        }
        // Clear search results
        const results = document.getElementById('t-search-results');
        if (results) results.style.display = 'none';
    };

    window.toggleTransactionFields = function() {
        const type = document.getElementById('t-type').value;
        const source = document.getElementById('t-source').value;
        
        const isTrade = ['BUY', 'SELL'].includes(type);
        const isDividend = type === 'DIVIDEND';
        const isCash = ['DEPOSIT', 'WITHDRAWAL', 'TAX', 'DIVIDEND', 'TRANSFER'].includes(type);
        
        const assetField = document.getElementById('t-asset-field');
        const manualFields = document.getElementById('t-manual-asset-fields');
        const stockFields = document.getElementById('t-stock-fields');
        const amountField = document.getElementById('t-amount-field');
        const destField = document.getElementById('t-dest-portfolio-field');

        if (assetField) assetField.style.display = (isTrade || isDividend) ? 'block' : 'none';
        if (manualFields) manualFields.style.display = (source === 'MANUAL' && (isTrade || isDividend)) ? 'grid' : 'none';
        if (stockFields) stockFields.style.display = (isTrade || isDividend) ? 'grid' : 'none';
        if (amountField) amountField.style.display = isCash ? 'block' : 'none';
        if (destField) destField.style.display = (type === 'TRANSFER') ? 'block' : 'none';

        // Auto-select MANUAL if ticker starts with CD_
        const ticker = document.getElementById('t-asset-search').value;
        if (ticker.toUpperCase().startsWith('CD_') && source !== 'MANUAL') {
            document.getElementById('t-source').value = 'MANUAL';
            toggleTransactionFields();
            return;
        }
        
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
        const source = document.getElementById('t-source').value;
        if (source === 'MANUAL') {
            document.getElementById('t-asset-ticker').value = query.toUpperCase();
            if (!silent) {
                const results = document.getElementById('t-search-results');
                if (results) results.style.display = 'none';
            }
            return;
        }

        if (!query || query.length < 2) {
            if (!silent) {
                const results = document.getElementById('t-search-results');
                if (results) results.style.display = 'none';
            }
            return;
        }
        try {
            // Yahoo Finance search expects 'q' parameter
            const res = await fetch(`/api/market/search?q=${query}`);
            const data = await res.json();
            if (silent) {
                if (data.length > 0) {
                    document.getElementById('t-asset-currency').value = data[0].currency || 'USD';
                    checkFX();
                }
                return;
            }
            const results = document.getElementById('t-search-results');
            if (results) {
                results.innerHTML = data.map(a => `
                    <div class="mob-search-item" onclick="selectMobileAsset('${a.ticker}', '${a.currency || 'USD'}', '${a.name}')">
                        <div class="mob-search-item-ticker">${a.ticker} <span style="font-size: 10px; color: var(--mob-primary); margin-left: 4px;">${a.currency || ''}</span></div>
                        <div class="mob-search-item-name">${a.name} • ${a.exchange}</div>
                    </div>
                `).join('');
                results.style.display = 'block';
            }
        } catch(e) {}
    };

    window.selectMobileAsset = async function(ticker, currency, name) {
        document.getElementById('t-asset-search').value = ticker;
        document.getElementById('t-asset-ticker').value = ticker;
        document.getElementById('t-asset-currency').value = currency || 'USD';
        if (name) document.getElementById('t-asset-name').value = name;
        
        const results = document.getElementById('t-search-results');
        if (results) results.style.display = 'none';

        const source = document.getElementById('t-source').value;
        if (source === 'MANUAL') {
            checkFX();
            calculateNetDividend();
            return;
        }

        // Fetch detailed metadata/price like desktop
        try {
            const res = await fetch(`/api/validate-ticker?ticker=${ticker}`);
            const data = await res.json();
            if (data && data.valid) {
                if (data.currentPrice) {
                    document.getElementById('t-price').value = data.currentPrice;
                }
                if (data.currency) {
                    document.getElementById('t-asset-currency').value = data.currency;
                }
                if (data.isin) {
                    document.getElementById('t-isin').value = data.isin;
                }
                if (data.dataSource) {
                    document.getElementById('t-source').value = data.dataSource;
                }
            }
        } catch(e) {}

        checkFX();
        calculateNetDividend();
    };

    window.handleMobileTransactionSubmit = async function(e) {
        e.preventDefault();
        const pId = document.getElementById('t-portfolio').value;
        if (!pId) {
            alert("Seleziona un portafoglio prima di operare.");
            return;
        }

        const id = document.getElementById('t-id').value;
        const formData = {
            portfolioId: pId,
            type: document.getElementById('t-type').value,
            date: document.getElementById('t-date').value,
            assetTicker: document.getElementById('t-asset-ticker').value,
            quantity: parseFloat(document.getElementById('t-qty').value) || 0,
            price: parseFloat(document.getElementById('t-price').value) || 0,
            amount: parseFloat(document.getElementById('t-amount').value) || 0,
            commission: parseFloat(document.getElementById('t-comm').value) || 0,
            tax: parseFloat(document.getElementById('t-tax').value) || 0,
            exchangeRate: parseFloat(document.getElementById('t-fx').value) || 1,
            destinationPortfolioId: document.getElementById('t-dest-portfolio')?.value || null,
            isin: document.getElementById('t-isin')?.value || null,
            dataSource: document.getElementById('t-source')?.value || 'YF',
            assetName: document.getElementById('t-asset-name')?.value || null,
            assetCurrency: document.getElementById('t-asset-currency')?.value || null
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
    window.mobileEditTransaction = async function(t) {
        injectMobileModal();
        // Open modal without ticker to avoid triggering handleMobileAssetSearch with wrong source
        await openTransactionModal('', t.portfolioId);
        
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
        document.getElementById('t-isin').value = t.isin || '';
        document.getElementById('t-source').value = t.dataSource || 'YF';
        if (t.assetName) document.getElementById('t-asset-name').value = t.assetName;
        if (t.assetCurrency) document.getElementById('t-asset-currency').value = t.assetCurrency;
        
        if (t.type === 'TRANSFER' && t.destinationPortfolioId) {
            await loadPortfoliosForTransfer(t.destinationPortfolioId);
        }
        
        // Find asset currency from current holdings if possible
        if (window.currentHoldings) {
            const h = window.currentHoldings.find(hold => hold.ticker === (t.assetTicker || t.ticker));
            if (h) document.getElementById('t-asset-currency').value = h.currency;
        } else if (!t.assetCurrency && (t.assetTicker || t.ticker)) {
            // If no holdings available, trigger a silent search to get currency if it's NOT a manual asset
            if (t.dataSource !== 'MANUAL') {
                handleMobileAssetSearch(t.assetTicker || t.ticker, true);
            }
        }
        
        toggleTransactionFields();
    };

    window.mobileDuplicateTransaction = async function(t) {
        await mobileEditTransaction(t);
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
