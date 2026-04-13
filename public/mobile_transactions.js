/**
 * Shared Mobile Transaction Logic & UI Injection
 * This script handles the global "+" FAB on mobile pages.
 * All transaction modal logic is now in /transaction_modal.js (shared with desktop).
 */

(function() {
    // ─── FAB Injection ───────────────────────────────────────────────────────────
    let fabInjected = false;

    function injectFAB() {
        if (fabInjected || document.getElementById('global-mob-fab')) {
            fabInjected = true;
            return;
        }
        const fab = document.createElement('div');
        fab.id = 'global-mob-fab';
        fab.className = 'mob-fab';
        fab.style.display = 'flex';
        fab.innerHTML = '<span class="material-symbols-outlined">add</span>';
        fab.onclick = () => {
            const pId = window.mobCurrentPortfolioId || window.currentPortfolioId;
            openTransactionModal({ portfolioId: pId });
        };
        document.body.appendChild(fab);
        fabInjected = true;
    }

    // injectMobileModal now delegates to the unified transaction_modal.js
    window.injectMobileModal = function() {
        if (typeof window.injectTransactionModal === 'function') {
            window.injectTransactionModal();
        }
        injectFAB();
    };

    // Auto-inject on mobile view
    function autoInit() {
        if (window._mobileViewActive || document.body.classList.contains('mobile-view-active') || window.innerWidth < 1024) {
            if (typeof window.injectTransactionModal === 'function') {
                window.injectTransactionModal();
            }
            injectFAB();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }
    setTimeout(autoInit, 500);


    // ── Manual Asset Update Modal ─────────────────────────
    window.injectManualUpdateModal = function() {
        if (!document.body || document.getElementById('manual-update-modal')) return;

        const html = `
        <div id="manual-update-modal" class="mob-modal-overlay">
            <div class="mob-modal-content">
                <div class="mob-modal-header">
                    <h3 class="mob-modal-title">Modifica Asset</h3>
                    <button onclick="closeManualModal()" class="mob-modal-close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="mob-modal-body">
                    <input type="hidden" id="manual-ticker"/>
                    <div class="mob-input-group">
                        <label class="mob-input-label">Prezzo (<span id="manual-currency-label">EUR</span>)</label>
                        <input id="manual-price" type="number" step="any" placeholder="0.00" class="mob-input-field" style="font-size: 18px;"/>
                    </div>
                    <div class="mob-input-group">
                        <label class="mob-input-label">Data Effettiva</label>
                        <input id="manual-date" type="date" class="mob-input-field"/>
                    </div>
                    <div class="mob-grid-2">
                        <div class="mob-input-group">
                            <label class="mob-input-label">Sorgente</label>
                            <select id="manual-source" class="mob-input-field" onchange="toggleManualISIN()">
                                <option value="YF">Yahoo Finance</option>
                                <option value="B_ITA">Borsa Italiana</option>
                                <option value="MANUAL">Manuale</option>
                            </select>
                        </div>
                        <div id="manual-isin-field" class="mob-input-group hidden">
                            <label class="mob-input-label">ISIN</label>
                            <input id="manual-isin" type="text" placeholder="e.g. IT000..." class="mob-input-field"/>
                        </div>
                    </div>
                    <div class="mob-grid-2">
                        <div class="mob-input-group">
                            <label class="mob-input-label">Tipo Asset</label>
                            <select id="manual-type" class="mob-input-field">
                                <option value="">Invariato</option>
                                <option value="Azioni">Azioni</option>
                                <option value="Bond">Bond</option>
                                <option value="ETF Azionario">ETF Azionario</option>
                                <option value="ETF Monetario">ETF Monetario</option>
                                <option value="ETF Obblig">ETF Obblig</option>
                                <option value="Deposito Vincolato">Deposito Vincolato</option>
                                <option value="Cash">Cash</option>
                            </select>
                        </div>
                        <div class="mob-input-group">
                            <label class="mob-input-label">Area/Paese</label>
                            <input id="manual-country" type="text" placeholder="e.g. US, Europe" class="mob-input-field"/>
                        </div>
                    </div>
                </div>
                <div class="mob-modal-footer">
                    <button onclick="closeManualModal()" class="mob-btn mob-btn-secondary">Annulla</button>
                    <button onclick="saveManualUpdate()" class="mob-btn mob-btn-success">Salva Modifiche</button>
                </div>
            </div>
        </div>`;
        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div.firstElementChild);
    };

    window.openManualModal = function(ticker, currency, currentPrice, type, country, dataSource, isin) {
        injectManualUpdateModal();
        const modal = document.getElementById('manual-update-modal');
        if (!modal) return;
        document.getElementById('manual-ticker').value = ticker || '';
        document.getElementById('manual-currency-label').innerText = currency || 'EUR';
        document.getElementById('manual-price').value = currentPrice || 0;
        document.getElementById('manual-date').value = new Date().toISOString().split('T')[0];
        document.getElementById('manual-type').value = type || '';
        document.getElementById('manual-country').value = country || '';
        const sourceEl = document.getElementById('manual-source');
        if (sourceEl) sourceEl.value = dataSource || 'YF';
        document.getElementById('manual-isin').value = isin || '';
        
        toggleManualISIN();
        modal.classList.add('active');
        document.body.classList.add('modal-open');
    };

    window.toggleManualISIN = function() {
        const source = document.getElementById('manual-source')?.value;
        const field = document.getElementById('manual-isin-field');
        if (field) {
            if (source === 'B_ITA') field.classList.remove('hidden');
            else field.classList.add('hidden');
        }
    };

    window.closeManualModal = function() {
        const modal = document.getElementById('manual-update-modal');
        if (modal) modal.classList.remove('active');
        document.body.classList.remove('modal-open');
    };

    window.saveManualUpdate = async function() {
        const ticker = document.getElementById('manual-ticker').value;
        const price = document.getElementById('manual-price').value;
        const date = document.getElementById('manual-date').value;
        const type = document.getElementById('manual-type').value;
        const country = document.getElementById('manual-country').value;
        const dataSource = document.getElementById('manual-source').value;
        const isin = document.getElementById('manual-isin').value;

        try {
            const res = await fetch('/api/assets/manual-update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker, price, date, type, country, dataSource, isin })
            });
            if (res.ok) {
                closeManualModal();
                const currentP = window.mobCurrentPortfolioId || window.currentPortfolioId;
                refreshAllMobileData(currentP);
            } else {
                const errData = await res.json();
                alert('Aggiornamento fallito: ' + (errData.error || errData.message || 'Errore sconosciuto'));
            }
        } catch (err) { console.error('Manual update error:', err); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
    } else {
        autoInit();
    }
    
    // Also try again after a delay to catch late-setting _mobileViewActive
    setTimeout(autoInit, 500);
})();
