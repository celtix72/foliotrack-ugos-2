/**
 * transaction_modal.js — Unified Transaction Modal
 * ─────────────────────────────────────────────────
 * Single source of truth for insert/edit transactions.
 * Works on both Desktop (portfolio_detail.html) and Mobile (via mobile_transactions.js).
 *
 * Public API:
 *   window.openTransactionModal(options?)
 *   window.closeTransactionModal()
 *   window.editTransaction(id)  — desktop or mobile (bridges to mobileEditTransaction)
 *   window.duplicateTransaction(id)
 *   window.confirmDeleteTransaction(id) / window.mobileDeleteTransaction(id)
 *   window.toggleTransactionFields()
 */

(function () {
    'use strict';

    // ─── State ──────────────────────────────────────────────────────────────────
    let _injected = false;
    let _searchTimeout = null;

    // ─── HTML Template ──────────────────────────────────────────────────────────
    function _getModalHtml() {
        const isDark = document.documentElement.classList.contains('dark');
        const backdropColor = isDark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.7)';

        return `
<style>
    /* Compact Desktop Styles */
    @media (min-width: 1024px) {
        #transaction-modal .tm-container {
            max-width: 420px !important;
            border-radius: 8px !important;
        }
        #transaction-modal .tm-header {
            padding: 6px 10px !important;
        }
        #transaction-modal .tm-header-icon-wrap {
            width: 22px !important;
            height: 22px !important;
        }
        #transaction-modal .tm-header-icon-wrap span {
            font-size: 14px !important;
        }
        #transaction-modal #tm-title {
            font-size: 12px !important;
        }
        #transaction-modal #tm-title + p {
            display: none !important; /* Hide subtitle to save space */
        }
        #transaction-modal .tm-body {
            padding: 8px 12px !important;
        }
        #transaction-modal .tm-row {
            gap: 6px !important;
            margin-bottom: 6px !important;
        }
        #transaction-modal .mob-input-label {
            font-size: 8px !important;
            margin-bottom: 1px !important;
            text-transform: uppercase !important;
            letter-spacing: 0.05em !important;
        }
        #transaction-modal .mob-input-field {
            padding: 4px 8px !important;
            font-size: 11px !important;
            border-radius: 6px !important;
            height: 28px !important;
        }
        #transaction-modal .tm-footer {
            padding: 6px 10px !important;
        }
        #transaction-modal .mob-btn {
            padding: 6px !important;
            font-size: 8px !important;
            border-radius: 6px !important;
            height: 28px !important;
        }
        #transaction-modal #tm-asset-meta {
            padding: 4px 8px !important;
            gap: 4px !important;
            margin-bottom: 6px !important;
        }
        #transaction-modal #tm-asset-meta p {
            font-size: 8px !important;
        }
        #transaction-modal #tm-alerts-wrap {
            margin-top: 8px !important;
            padding-top: 6px !important;
        }
        #transaction-modal #tm-alerts-wrap p {
            font-size: 8px !important;
            margin-bottom: 4px !important;
        }
        #transaction-modal #tm-search-results {
            max-height: 120px !important;
        }
    }
</style>
<div id="transaction-modal" 
     style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 20000; align-items: center; justify-content: center; background-color: ${backdropColor}; backdrop-filter: blur(12px); padding: 0.5rem; flex-direction: column;"
     class="flex">
    <div class="tm-container" 
         style="width: 100%; max-width: 800px; max-height: 94vh; position: relative; z-index: 20001; display: flex; flex-direction: column; border-radius: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden; background: var(--mob-surface); border: 1px solid var(--mob-border); color: var(--mob-text);">
        
        <!-- Header -->
        <div class="tm-header" style="padding: 16px 20px; border-bottom: 1px solid var(--mob-border); display: flex; justify-content: space-between; align-items: center; background: var(--mob-surface);">
            <div class="flex items-center gap-3">
                <div class="tm-header-icon-wrap w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                    <span class="material-symbols-outlined text-primary text-xl" id="tm-header-icon">swap_horiz</span>
                </div>
                <div>
                    <h3 id="tm-title" class="font-black text-sm md:text-lg" style="margin: 0; color: var(--mob-text);">Nuova Transazione</h3>
                    <p class="text-[9px] uppercase tracking-widest font-bold" style="margin: 2px 0 0 0; color: var(--mob-text-muted);">Dettagli Operazione</p>
                </div>
            </div>
            <button type="button" onclick="closeTransactionModal()" style="background: rgba(148,163,184,0.1); border: none; border-radius: 50%; cursor: pointer; color: #94a3b8; padding: 6px; display: flex;">
                <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
            </button>
        </div>

        <!-- Form Body -->
        <form id="tm-form" class="flex flex-col flex-1 min-h-0" onsubmit="handleTransactionSubmit(event)">
            <input type="hidden" id="tm-id" />
            <div class="tm-body mob-modal-body custom-scrollbar" style="padding: 20px; overflow-y: auto;">

                <!-- Row 1: Portafoglio + Tipo + Sorgente -->
                <div class="tm-row" style="display: grid; grid-template-columns: 1.8fr 1.2fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem;">
                    <div id="tm-portfolio-wrap">
                        <label class="mob-input-label">Portafoglio</label>
                        <select id="tm-portfolio" class="mob-input-field">
                            <option value="">— Caricamento... —</option>
                        </select>
                    </div>
                    <div>
                        <label class="mob-input-label">Tipo</label>
                        <select id="tm-type" class="mob-input-field" onchange="toggleTransactionFields()">
                            <option value="BUY">ACQUISTO</option>
                            <option value="SELL">VENDITA</option>
                            <option value="DIVIDEND">DIVIDENDO</option>
                            <option value="DEPOSIT">DEPOSITO</option>
                            <option value="WITHDRAWAL">PRELIEVO</option>
                            <option value="TAX">TAX</option>
                            <option value="TRANSFER">TRASFERIMENTO</option>
                        </select>
                    </div>
                    <div id="tm-source-wrap" class="hidden">
                        <label class="mob-input-label">Sorgente</label>
                        <select id="tm-source" class="mob-input-field" onchange="toggleTransactionFields()">
                            <option value="YF">Yahoo</option>
                            <option value="B_ITA">B_ITA</option>
                            <option value="MANUAL">Manual</option>
                        </select>
                    </div>
                </div>

                <!-- Row 2: Data + Asset Search -->
                <div class="tm-row" style="display: grid; grid-template-columns: 1fr 2fr; gap: 0.75rem; margin-bottom: 0.75rem;">
                    <div>
                        <label class="mob-input-label">Data</label>
                        <input id="tm-date" type="date" required class="mob-input-field" />
                    </div>
                    <div id="tm-asset-wrap" class="hidden relative">
                        <label class="mob-input-label">Asset (Ticker / Cerca)</label>
                        <input id="tm-asset-search" type="text" autocomplete="off" placeholder="AAPL, ISP.MI..." class="mob-input-field" oninput="handleTMAssetInput(this.value)" onfocus="handleTMAssetFocus()" onclick="handleTMAssetFocus()" />
                        <div id="tm-search-results" class="hidden absolute left-0 right-0 top-full mt-1 z-50 bg-white dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-48 overflow-y-auto"></div>
                        <input type="hidden" id="tm-asset-ticker" />
                        <input type="hidden" id="tm-asset-currency" value="EUR" />
                    </div>
                </div>

                <!-- Row 3: Meta (ISIN / Manual) + Asset Info -->
                <div id="tm-meta-row" class="tm-row hidden" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem;">
                    <div id="tm-isin-wrap" class="hidden">
                        <label class="mob-input-label">ISIN</label>
                        <input id="tm-isin" type="text" placeholder="ISIN" class="mob-input-field font-mono" />
                    </div>
                    <div id="tm-manual-name-wrap" class="hidden">
                        <label class="mob-input-label">Nome Asset</label>
                        <input id="tm-asset-name" type="text" placeholder="Nome" class="mob-input-field" />
                    </div>
                    <div id="tm-manual-curr-wrap" class="hidden">
                        <label class="mob-input-label">Valuta</label>
                        <select id="tm-asset-currency-manual" class="mob-input-field" onchange="tmCheckFX()">
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="GBP">GBP</option>
                        </select>
                    </div>
                </div>

                <!-- Row 4: Asset Meta Badges (Super Compact) -->
                <div id="tm-asset-meta" class="hidden tm-row p-2 rounded-lg flex justify-between gap-4 mb-2" style="background: var(--mob-surface-2); border: 1px solid var(--mob-border);">
                    <div class="flex gap-2 items-center"><span class="text-[7px] uppercase font-black" style="color: var(--mob-text-muted);">Mercato:</span><span id="tm-meta-exchange" class="text-[10px] font-black" style="color: var(--mob-text);">—</span></div>
                    <div class="flex gap-2 items-center"><span class="text-[7px] uppercase font-black" style="color: var(--mob-text-muted);">Tipo:</span><span id="tm-meta-type" class="text-[10px] font-black" style="color: var(--mob-text);">—</span></div>
                    <div class="flex gap-2 items-center"><span class="text-[7px] uppercase font-black" style="color: var(--mob-text-muted);">Prezzo:</span><span id="tm-meta-price" class="text-[10px] font-black text-primary">—</span></div>
                </div>

                <!-- Row 5: Qty + Price + FX + Tax (4 Columns) -->
                <div id="tm-qty-price-row" class="tm-row hidden" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.6rem; margin-bottom: 0.75rem;">
                    <div><label class="mob-input-label" id="tm-qty-label">Quantità</label><input id="tm-qty" type="number" step="any" placeholder="0" class="mob-input-field font-mono" oninput="tmCalcNet()" /></div>
                    <div><label class="mob-input-label" id="tm-price-label">Prezzo</label><input id="tm-price" type="number" step="any" placeholder="0.00" class="mob-input-field font-mono" oninput="tmCalcNet()" /></div>
                    <div id="tm-fx-inline-wrap"><label class="mob-input-label">FX (<span id="tm-fx-from">USD</span>)</label><input id="tm-fx" type="number" step="any" value="1" class="mob-input-field font-mono" oninput="tmCalcNet()" /></div>
                    <div><label class="mob-input-label">Tax</label><input id="tm-tax" type="number" step="any" value="0" class="mob-input-field font-mono" oninput="tmCalcNet()" /></div>
                </div>

                <!-- Row 6: Commissioni + Importo -->
                <div id="tm-comm-amount-row" class="tm-row hidden" style="display: grid; grid-template-columns: 1fr 2fr; gap: 0.75rem; margin-bottom: 0.75rem;">
                    <div id="tm-comm-wrap"><label class="mob-input-label">Commissioni</label><input id="tm-comm" type="number" step="any" value="0" class="mob-input-field font-mono" oninput="tmCalcNet()" /></div>
                    <div id="tm-amount-wrap"><label class="mob-input-label" id="tm-amount-label">Importo Totale</label>
                        <div class="relative"><input id="tm-amount" type="number" step="any" placeholder="0.00" class="mob-input-field font-mono" style="background: var(--mob-surface-2);" oninput="if(typeof tmCalcFromAmount === 'function') tmCalcFromAmount()" /><p class="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-bold italic" style="color: var(--mob-text-muted);" id="tm-amount-hint"></p></div>
                    </div>
                </div>

                <!-- Alert & Stop Loss (Super tight) -->
                <div id="tm-alerts-wrap" class="hidden mt-1 pt-1 border-t" style="border-color: var(--mob-border);">
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">
                        <div class="relative"><span class="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] tm-alerts-curr" style="color: var(--mob-text-muted);">€</span><input id="tm-tp" type="number" placeholder="TG1" class="mob-input-field font-mono" style="padding-left:14px;" /></div>
                        <div class="relative"><span class="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] tm-alerts-curr" style="color: var(--mob-text-muted);">€</span><input id="tm-tp2" type="number" placeholder="TG2" class="mob-input-field font-mono" style="padding-left:14px;" /></div>
                        <div class="relative"><span class="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] tm-alerts-curr" style="color: var(--mob-text-muted);">€</span><input id="tm-sl" type="number" placeholder="SL" class="mob-input-field font-mono" style="padding-left:14px;" /></div>
                        <input id="tm-vol" type="number" placeholder="VOL%" class="mob-input-field font-mono text-center" />
                    </div>
                </div>

                <!-- Target Transfer -->
                <div id="tm-dest-wrap" class="hidden" style="margin-top: 0.5rem;">
                    <label class="mob-input-label">Target Transfer</label>
                    <select id="tm-dest-portfolio" class="mob-input-field">
                        <option value="">— Seleziona Target —</option>
                    </select>
                </div>

            </div>

            <!-- Footer -->
            <div class="tm-footer" style="padding: 16px 20px; border-top: 1px solid var(--mob-border); background: var(--mob-surface); display: flex; gap: 10px;">
                <button type="button" onclick="closeTransactionModal()" class="mob-btn" style="flex: 1; background: rgba(148,163,184,0.1); color: var(--mob-text-muted); border: none; font-weight: 900; text-transform: uppercase; font-size: 11px;">
                    Annulla
                </button>
                <button type="submit" id="tm-submit-btn" class="mob-btn" style="flex: 2; background: var(--mob-primary); color: white; border: none; font-weight: 900; text-transform: uppercase; font-size: 11px; box-shadow: 0 4px 12px rgba(19,91,236,0.2); display: flex; items-center; justify-center; gap: 8px;">
                    <span class="material-symbols-outlined text-base" id="tm-submit-icon">check_circle</span>
                    <span id="tm-submit-label">Conferma</span>
                </button>
            </div>
        </form>
    </div>
</div>
        `;
    }

    // ─── Inject Modal DOM ────────────────────────────────────────────────────────
    window.injectTransactionModal = function () {
        if (document.getElementById('transaction-modal')) {
            return;
        }
        const div = document.createElement('div');
        div.innerHTML = _getModalHtml().trim();
        while (div.firstChild) document.body.appendChild(div.firstChild);
        _injected = true;
    };

    // ─── Open Modal ─────────────────────────────────────────────────────────────
    /**
     * @param {Object} options
     *   portfolioId  {number|string}
     *   ticker       {string}
     *   type         {string} BUY|SELL|DIVIDEND|DEPOSIT|WITHDRAWAL|TAX|TRANSFER
     *   editData     {Object} full transaction object for editing
     */
    window.openTransactionModal = async function (options = {}) {
        try {
            injectTransactionModal();
            const modal = document.getElementById('transaction-modal');
            if (!modal) {
                console.error('[TM] Modal element not found after injection');
                return;
            }

            // Show immediately to avoid lag feeling
            modal.style.setProperty('display', 'flex', 'important');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => modal.classList.add('active'), 10);
            document.body.classList.add('modal-open');

            // Reset form
            const form = document.getElementById('tm-form');
            if (form) form.reset();
            const tmId = document.getElementById('tm-id');
            if (tmId) tmId.value = '';
            
            // ... reset other fields safely ...
            ['tm-asset-ticker', 'tm-amount', 'tm-comm', 'tm-tax', 'tm-tp', 'tm-tp2', 'tm-sl'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = (id === 'tm-comm' || id === 'tm-tax') ? '0' : '';
            });
            const fx = document.getElementById('tm-fx');
            if (fx) fx.value = '1';
            
            _hideSearchResults();

        // Set default date = today
        document.getElementById('tm-date').value = new Date().toISOString().split('T')[0];

        // Load portfolios
        await _loadPortfoliosSelect(options.portfolioId);

        const type = options.type || 'BUY';
        document.getElementById('tm-type').value = type;
        document.getElementById('tm-source').value = 'YF';

        document.getElementById('tm-title').innerText = 'Nuova Transazione';
        document.getElementById('tm-submit-label').innerText = 'Conferma';
        document.getElementById('tm-submit-icon').innerText = 'check_circle';

        // Pre-fill ticker if provided
        if (options.ticker) {
            document.getElementById('tm-asset-search').value = options.ticker;
            document.getElementById('tm-asset-ticker').value = options.ticker;
        }

        toggleTransactionFields();
        } catch (err) {
            console.error('[TM] Error opening modal:', err);
        }
    };

    // ─── Close Modal ─────────────────────────────────────────────────────────────
    window.closeTransactionModal = function () {
        const modal = document.getElementById('transaction-modal');
        if (modal) {
            modal.classList.remove('active');
            // Give time for transition before hiding
            setTimeout(() => {
                modal.style.display = 'none';
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 250);
        }
        document.body.classList.remove('modal-open');
        _hideSearchResults();
    };

    // ─── Toggle Field Visibility ─────────────────────────────────────────────────
    window.toggleTransactionFields = function (skipFXFetch = false) {
        const type = (document.getElementById('tm-type')?.value || 'BUY').toUpperCase();
        const source = (document.getElementById('tm-source')?.value || 'YF');

        const isTrade = ['BUY', 'SELL'].includes(type);
        const isDividend = type === 'DIVIDEND';
        const isCashOnly = ['DEPOSIT', 'WITHDRAWAL', 'TAX', 'TRANSFER'].includes(type);
        const isTransfer = type === 'TRANSFER';
        const needsAsset = isTrade || isDividend;

        // Row-level visibility
        _toggleField('tm-source-wrap', type === 'BUY');
        _toggleField('tm-asset-wrap', needsAsset);
        _toggleField('tm-meta-row', (type === 'BUY' && source === 'B_ITA') || (type === 'BUY' && source === 'MANUAL'));
        _toggleField('tm-isin-wrap', type === 'BUY' && source === 'B_ITA');
        _toggleField('tm-manual-name-wrap', type === 'BUY' && source === 'MANUAL');
        _toggleField('tm-manual-curr-wrap', type === 'BUY' && source === 'MANUAL');
        _toggleField('tm-qty-price-row', needsAsset);
        _toggleField('tm-comm-amount-row', isTrade || isDividend || isCashOnly);
        _toggleField('tm-alerts-wrap', needsAsset);

        // Labels dinamiche
        if (isDividend) {
            document.getElementById('tm-qty-label').innerText = 'Quantità';
            document.getElementById('tm-price-label').innerText = 'Dividendo (€)';
        } else {
            document.getElementById('tm-qty-label').innerText = 'Quantità';
            document.getElementById('tm-price-label').innerText = 'Prezzo';
        }

        // Specific sub-field logic
        _toggleField('tm-comm-wrap', isTrade);
        _toggleField('tm-fx-inline-wrap', needsAsset); // Show FX input if asset is present

        // Importo totale: cash-only e DIVIDEND (modificabile)
        _toggleField('tm-amount-wrap', isCashOnly || isDividend);
        const amountLabel = document.getElementById('tm-amount-label');
        const amountHint = document.getElementById('tm-amount-hint');
        const amountInput = document.getElementById('tm-amount');
        if (amountLabel) amountLabel.innerText = isDividend ? 'Netto Dividendo (€)' : 'Importo';
        if (amountInput) amountInput.readOnly = false;
        if (amountHint) amountHint.innerText = isDividend ? 'Inserisci il Totale Netto o le Tasse per auto-calcolare il Dividendo Unitario.' : '';

        // Portafoglio destinazione: solo TRANSFER
        _toggleField('tm-dest-wrap', isTransfer);
        if (isTransfer) _loadDestPortfolios();

        // Auto-set CASH ticker for cash-only
        if (isCashOnly) {
            const ticker = document.getElementById('tm-asset-ticker');
            if (ticker && !ticker.value) ticker.value = 'CASH';
        }

        // Auto-select MANUAL for CD_ tickers
        const assetSearch = document.getElementById('tm-asset-search')?.value || '';
        if (assetSearch.toUpperCase().startsWith('CD_') && source !== 'MANUAL') {
            document.getElementById('tm-source').value = 'MANUAL';
            toggleTransactionFields();
            return;
        }

        // Header icon
        const icons = { BUY: 'add_shopping_cart', SELL: 'sell', DIVIDEND: 'payments', DEPOSIT: 'account_balance', WITHDRAWAL: 'money_off', TAX: 'receipt_long', TRANSFER: 'swap_horiz' };
        document.getElementById('tm-header-icon').innerText = icons[type] || 'swap_horiz';

        tmCheckFX(skipFXFetch);
        tmCalcNet();
    };

    // ─── FX Check ───────────────────────────────────────────────────────────────
    window.tmCheckFX = async function (skipFetch = false) {
        const source = document.getElementById('tm-source')?.value || 'YF';
        const assetCurr = source === 'MANUAL'
            ? (document.getElementById('tm-asset-currency-manual')?.value || 'EUR')
            : (document.getElementById('tm-asset-currency')?.value || 'EUR');

        const portfolioId = document.getElementById('tm-portfolio')?.value;
        const portfolioCurr = _getPortfolioCurrency(portfolioId) || window.portfolioCurrency || 'EUR';

        const needsFX = assetCurr && assetCurr !== portfolioCurr;
        _toggleField('tm-fx-wrap', needsFX);

        if (needsFX) {
            const fromEl = document.getElementById('tm-fx-from');
            if (fromEl) fromEl.innerText = assetCurr;
            if (!skipFetch) {
                try {
                    const res = await fetch(`/api/fx-rate?from=${portfolioCurr}&to=${assetCurr}`);
                    const data = await res.json();
                    if (data.rate) document.getElementById('tm-fx').value = parseFloat(data.rate).toFixed(6);
                } catch (e) { /* silent */ }
            }
        } else {
            document.getElementById('tm-fx').value = '1';
        }
        tmCalcNet();
    };

    // ─── Calc Net Dividend ───────────────────────────────────────────────────────
    window.tmCalcNet = function () {
        const type = document.getElementById('tm-type')?.value;
        if (type !== 'DIVIDEND') return;
        
        // Prevent looping when called from tmCalcFromAmount
        if (window._tmIsCalculating) return;

        const qty = parseFloat(document.getElementById('tm-qty')?.value) || 0;
        const price = parseFloat(document.getElementById('tm-price')?.value) || 0;
        const tax = parseFloat(document.getElementById('tm-tax')?.value) || 0;
        const fx = parseFloat(document.getElementById('tm-fx')?.value) || 1;
        const gross = (qty * price) / fx;
        const net = gross - (tax / fx);
        const amountEl = document.getElementById('tm-amount');
        if (amountEl) {
            window._tmIsCalculating = true;
            amountEl.value = net.toFixed(2);
            window._tmIsCalculating = false;
        }
    };

    // ─── Calc Unit Price From Amount ──────────────────────────────────────────────
    window.tmCalcFromAmount = function () {
        const type = document.getElementById('tm-type')?.value;
        if (type !== 'DIVIDEND') return;
        
        if (window._tmIsCalculating) return;

        const qty = parseFloat(document.getElementById('tm-qty')?.value) || 0;
        if (qty <= 0) return;
        
        const net = parseFloat(document.getElementById('tm-amount')?.value) || 0;
        const tax = parseFloat(document.getElementById('tm-tax')?.value) || 0;
        const fx = parseFloat(document.getElementById('tm-fx')?.value) || 1;
        
        // net = (qty * price) / fx - (tax / fx) => price = (net * fx + tax) / qty
        const price = (net * fx + tax) / qty;
        
        const priceEl = document.getElementById('tm-price');
        if (priceEl) {
            window._tmIsCalculating = true;
            priceEl.value = price.toFixed(6);
            window._tmIsCalculating = false;
        }
    };

    // ─── Asset Search ────────────────────────────────────────────────────────────
    window.handleTMAssetFocus = function() {
        const type = document.getElementById('tm-type')?.value;
        if (['SELL', 'DIVIDEND'].includes(type) && !document.getElementById('tm-asset-search').value) {
            handleTMAssetInput('');
        }
    };

    window.handleTMAssetInput = function (query) {
        const source = document.getElementById('tm-source')?.value || 'YF';
        const type = document.getElementById('tm-type')?.value;

        if (source === 'MANUAL' || source === 'B_ITA') {
            document.getElementById('tm-asset-ticker').value = query.trim().toUpperCase();
            _hideSearchResults();
            return;
        }

        clearTimeout(_searchTimeout);
        
        // Modalità posizioni aperte per SELL e DIVIDEND
        if (['SELL', 'DIVIDEND'].includes(type)) {
            const portfolioId = document.getElementById('tm-portfolio')?.value;
            if (!portfolioId) { _hideSearchResults(); return; }

            // Funzione helper locale per garantire di avere l'elenco posizioni
            const fetchHoldings = async () => {
                if (window.currentHoldings && (window.currentPortfolioId == portfolioId)) {
                    return window.currentHoldings;
                }
                if (window._tmHoldingsCache && window._tmHoldingsCache[portfolioId]) {
                    return window._tmHoldingsCache[portfolioId];
                }
                try {
                    const res = await fetch(`/api/portfolios/${portfolioId}`);
                    if (res.ok) {
                        const data = await res.json();
                        window._tmHoldingsCache = window._tmHoldingsCache || {};
                        window._tmHoldingsCache[portfolioId] = data.holdings || [];
                        return data.holdings || [];
                    }
                } catch (e) { console.error('Error fetching holdings', e); }
                return [];
            };

            fetchHoldings().then(holdings => {
                const filtered = holdings.filter(h => {
                    const availableQty = h.shares || h.totalQuantity || h.quantity || 0;
                    if (availableQty <= 0) return false;
                    if (!query) return true;
                    const sym = (h.ticker || '').toLowerCase();
                    const nm = (h.name || '').toLowerCase();
                    const q = query.toLowerCase();
                    return sym.includes(q) || nm.includes(q);
                });
                
                const container = document.getElementById('tm-search-results');
                if (!container) return;
                if (filtered.length === 0) { _hideSearchResults(); return; }
                
                container.innerHTML = filtered.map(h => {
                    const sym = h.ticker;
                    const name = h.name || sym;
                    const curr = h.currency || '';
                    const qty = h.shares || h.totalQuantity || h.quantity || 0;
                    return `<div class="px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-xs transition-colors border-b border-slate-100 dark:border-slate-800/50 last:border-0"
                        onclick="selectTMAsset('${sym.replace(/'/g, "\\'")}', '${curr.replace(/'/g, "\\'")}', '${name.replace(/'/g, "\\'")}')">
                        <div class="flex items-center justify-between">
                            <span class="font-black text-slate-900 dark:text-white">${sym} <span class="text-slate-400 text-xs ml-1 font-bold">(${qty} possedute)</span></span>
                            <span class="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">${curr}</span>
                        </div>
                        <div class="text-[11px] text-slate-400 mt-0.5 truncate">${name}</div>
                    </div>`;
                }).join('');
                container.classList.remove('hidden');
            });
            return;
        }
        if (!query || query.length < 2) { _hideSearchResults(); return; }

        _searchTimeout = setTimeout(async () => {
            try {
                // Try both endpoints for compatibility
                const res = await fetch(`/api/asset-search?query=${encodeURIComponent(query)}`);
                const data = await res.json();
                _renderSearchResults(data);
            } catch (e) {
                try {
                    const res2 = await fetch(`/api/market/search?q=${encodeURIComponent(query)}`);
                    const data2 = await res2.json();
                    _renderSearchResults(data2);
                } catch (e2) { /* silent */ }
            }
        }, 280);
    };

    function _renderSearchResults(data) {
        const container = document.getElementById('tm-search-results');
        if (!container) return;
        if (!data || data.length === 0) { _hideSearchResults(); return; }

        container.innerHTML = data.filter(i => i.symbol || i.ticker).map(i => {
            const sym = i.symbol || i.ticker;
            const name = i.shortname || i.longname || i.name || sym;
            const curr = i.currency || '';
            const exchange = i.exchange || '';
            return `<div class="px-4 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-sm transition-colors border-b border-slate-100 dark:border-slate-800/50 last:border-0"
                onclick="selectTMAsset('${sym}', '${curr}', '${name.replace(/'/g, "\\'")}')">
                <div class="flex items-center justify-between">
                    <span class="font-black text-slate-900 dark:text-white">${sym}</span>
                    <span class="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">${curr}</span>
                </div>
                <div class="text-[11px] text-slate-400 mt-0.5 truncate">${name}${exchange ? ' • ' + exchange : ''}</div>
            </div>`;
        }).join('');
        container.classList.remove('hidden');
    }

    window.selectTMAsset = async function (ticker, currency, name) {
        document.getElementById('tm-asset-search').value = ticker;
        document.getElementById('tm-asset-ticker').value = ticker;
        if (currency) document.getElementById('tm-asset-currency').value = currency;
        if (name) document.getElementById('tm-asset-name').value = name;
        _hideSearchResults();

        const meta = document.getElementById('tm-asset-meta');
        if (meta) {
            meta.classList.remove('hidden');
            document.getElementById('tm-meta-exchange').innerText = '...';
            document.getElementById('tm-meta-type').innerText = '...';
            document.getElementById('tm-meta-price').innerText = '...';
        }

        try {
            const res = await fetch(`/api/validate-ticker?ticker=${ticker}`);
            const data = await res.json();
            if (data && data.valid) {
                if (meta) {
                    document.getElementById('tm-meta-exchange').innerText = data.exchange || 'N/A';
                    document.getElementById('tm-meta-type').innerText = data.type || 'N/A';
                    document.getElementById('tm-meta-price').innerText = data.currentPrice ? `${data.currentPrice} ${data.currency || ''}` : '—';
                }
                if (data.currency) {
                    document.getElementById('tm-asset-currency').value = data.currency;
                    document.querySelectorAll('.tm-alerts-curr').forEach(el => el.innerText = data.currency === 'USD' ? '$' : (data.currency === 'EUR' ? '€' : data.currency));
                }
                if (data.isin) document.getElementById('tm-isin').value = data.isin;
                if (data.dataSource && document.getElementById('tm-source')) {
                    document.getElementById('tm-source').value = data.dataSource;
                    toggleTransactionFields();
                }

                // Load TP / SL
                try {
                    const aRes = await fetch(`/api/assets`);
                    const allAssets = await aRes.json();
                    const aInfo = allAssets.find(a => a.ticker === ticker);
                    if (aInfo) {
                        document.getElementById('tm-tp').value = aInfo.targetPrice || '';
                        document.getElementById('tm-tp2').value = aInfo.targetPrice2 || '';
                        document.getElementById('tm-sl').value = aInfo.stopLoss || '';
                        document.getElementById('tm-vol').value = aInfo.volatilityAlert || 0;
                    }
                } catch(e) {}

                const type = document.getElementById('tm-type')?.value;
                // Auto-populate price for BUY, SELL, DIVIDEND
                if (['BUY', 'SELL', 'DIVIDEND'].includes(type) && data.currentPrice) {
                    document.getElementById('tm-price').value = data.currentPrice;
                }

                // Auto-populate quantity for SELL/DIVIDEND (current holdings)
                if (['SELL', 'DIVIDEND'].includes(type)) {
                    const owned = _getOwnedQuantity(ticker);
                    if (owned > 0) document.getElementById('tm-qty').value = owned;
                }
            } else if (meta) {
                meta.classList.add('hidden');
            }
        } catch (e) { if (meta) meta.classList.add('hidden'); }

        await tmCheckFX();
        tmCalcNet();
    };

    // ─── Submit ──────────────────────────────────────────────────────────────────
    window.handleTransactionSubmit = async function (e) {
        e.preventDefault();
        const portfolioId = document.getElementById('tm-portfolio')?.value;
        if (!portfolioId) { alert('Seleziona un portafoglio.'); return; }

        const id = document.getElementById('tm-id')?.value;
        const source = document.getElementById('tm-source')?.value || 'YF';
        const type = document.getElementById('tm-type')?.value;

        const payload = {
            portfolioId: parseInt(portfolioId),
            type,
            date: document.getElementById('tm-date')?.value,
            assetTicker: document.getElementById('tm-asset-ticker')?.value || 'CASH',
            quantity: parseFloat(document.getElementById('tm-qty')?.value) || 0,
            price: parseFloat(document.getElementById('tm-price')?.value) || 0,
            commission: parseFloat(document.getElementById('tm-comm')?.value) || 0,
            tax: parseFloat(document.getElementById('tm-tax')?.value) || 0,
            exchangeRate: parseFloat(document.getElementById('tm-fx')?.value) || 1,
            amount: parseFloat(document.getElementById('tm-amount')?.value) || 0,
            isin: document.getElementById('tm-isin')?.value || null,
            dataSource: source,
            destinationPortfolioId: document.getElementById('tm-dest-portfolio')?.value || null,
            assetName: source === 'MANUAL' ? (document.getElementById('tm-asset-name')?.value || null) : null,
            assetCurrency: source === 'MANUAL'
                ? (document.getElementById('tm-asset-currency-manual')?.value || 'EUR')
                : (document.getElementById('tm-asset-currency')?.value || 'EUR')
        };

        const method = id ? 'PUT' : 'POST';
        const url = id ? `/api/transactions/${id}` : '/api/transactions';

        const btn = document.getElementById('tm-submit-btn');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                // Salva eventuali modifiche a Target Price e Stop Loss
                if (payload.assetTicker && payload.assetTicker !== 'CASH' && !document.getElementById('tm-alerts-wrap').classList.contains('hidden')) {
                    const tp = parseFloat(document.getElementById('tm-tp')?.value) || 0;
                    const tp2 = parseFloat(document.getElementById('tm-tp2')?.value) || 0;
                    const sl = parseFloat(document.getElementById('tm-sl')?.value) || 0;
                    const vol = parseInt(document.getElementById('tm-vol')?.value) || 0;
                    try {
                        await fetch(`/api/assets/${encodeURIComponent(payload.assetTicker)}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ targetPrice: tp, targetPrice2: tp2, stopLoss: sl, volatilityAlert: vol })
                        });
                    } catch(e) { console.error('Failed to save asset alerts', e); }
                }

                if (window.showNotification) window.showNotification(id ? 'Transazione modificata!' : 'Transazione inserita!', 'success');
                closeTransactionModal();
                _refreshAfterSave(portfolioId);
            } else {
                const err = await res.json().catch(() => ({ error: res.statusText }));
                alert('Errore: ' + (err.error || 'Salvataggio fallito'));
            }
        } catch (err) {
            alert('Errore di rete: ' + err.message);
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        }
    };

    // ─── Edit / Duplicate / Delete ───────────────────────────────────────────────
    window.editTransaction = async function (id) {
        // desktop context: currentTransactions is in scope of portfolio_detail.html
        const t = (window.currentTransactions || []).find(tx => tx.id === id || tx.id === parseInt(id));
        if (t) {
            await _openForEdit(t);
            return;
        }
        // fallback: fetch from API
        try {
            const res = await fetch(`/api/transactions?id=${id}`);
            const data = await res.json();
            if (data && data.length) await _openForEdit(data[0]);
        } catch (e) { console.error(e); }
    };

    window.mobileEditTransaction = async function (t) {
        await _openForEdit(t);
    };

    window.mobileDuplicateTransaction = async function (t) {
        await _openForEdit(t, true);
    };

    window.duplicateTransaction = async function (id) {
        const t = (window.currentTransactions || []).find(tx => tx.id === id || tx.id === parseInt(id));
        if (t) await _openForEdit(t, true);
    };

    window.mobileDeleteTransaction = async function (id) {
        if (!confirm('Eliminare questa transazione?')) return;
        try {
            const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
            if (res.ok) {
                const pId = document.getElementById('tm-portfolio')?.value
                    || window.mobCurrentPortfolioId || window.currentPortfolioId;
                _refreshAfterSave(pId);
            }
        } catch (e) { console.error(e); }
    };

    window.confirmDeleteTransaction = async function (id) {
        if (!confirm('Eliminare questa transazione?')) return;
        try {
            await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
            const pId = window.currentPortfolioId || window.mobCurrentPortfolioId;
            _refreshAfterSave(pId);
        } catch (e) { console.error(e); }
    };

    async function _openForEdit(t, isDuplicate = false) {
        await openTransactionModal({ portfolioId: t.portfolioId, type: t.type });

        document.getElementById('tm-id').value = isDuplicate ? '' : (t.id || '');
        document.getElementById('tm-title').innerText = isDuplicate ? 'Duplica Transazione' : 'Modifica Transazione';
        document.getElementById('tm-submit-label').innerText = isDuplicate ? 'Inserisci Copia' : 'Salva Modifiche';

        document.getElementById('tm-type').value = t.type || 'BUY';

        let formattedDate = '';
        if (isDuplicate) {
            formattedDate = new Date().toISOString().split('T')[0];
        } else if (t.date) {
            formattedDate = t.date.includes('T') ? t.date.split('T')[0] : t.date;
        }
        document.getElementById('tm-date').value = formattedDate;

        document.getElementById('tm-qty').value = t.quantity || 0;
        document.getElementById('tm-price').value = t.price || 0;
        document.getElementById('tm-comm').value = t.commission || 0;
        document.getElementById('tm-tax').value = t.tax || 0;
        document.getElementById('tm-fx').value = t.exchangeRate || t.fxRate || 1;
        document.getElementById('tm-amount').value = t.amount || 0;
        document.getElementById('tm-asset-ticker').value = t.assetTicker || t.ticker || '';
        document.getElementById('tm-asset-search').value = t.assetTicker || t.ticker || '';

        // Assicuriamoci di recuperare eventuali metadati mancanti dall'API per i campi manuali o B_ITA
        let metadata = {};
        if (t.assetTicker && t.assetTicker !== 'CASH') {
            try {
                const res = await fetch(`/api/validate-ticker?ticker=${encodeURIComponent(t.assetTicker)}`);
                const data = await res.json();
                if (data && data.valid) metadata = data;
            } catch (e) { console.error('Fallito recupero metadati asset', e); }
        }

        const source = t.dataSource || metadata.dataSource || 'YF';
        document.getElementById('tm-source').value = source;
        const aName = t.assetName || metadata.name || '';
        if (aName) document.getElementById('tm-asset-name').value = aName;
        
        const aCurr = t.assetCurrency || metadata.currency || '';
        if (aCurr) {
            document.getElementById('tm-asset-currency').value = aCurr;
            const manCurEl = document.getElementById('tm-asset-currency-manual');
            if (manCurEl) manCurEl.value = aCurr;
        }

        const aIsin = t.isin || metadata.isin || '';
        document.getElementById('tm-isin').value = aIsin;

        try {
            const aRes = await fetch(`/api/assets`);
            const allAssets = await aRes.json();
            const aInfo = allAssets.find(a => a.ticker === (t.assetTicker || t.ticker));
            if (aInfo) {
                document.getElementById('tm-tp').value = aInfo.targetPrice || '';
                document.getElementById('tm-tp2').value = aInfo.targetPrice2 || '';
                document.getElementById('tm-sl').value = aInfo.stopLoss || '';
                document.getElementById('tm-vol').value = aInfo.volatilityAlert || 0;
            }
        } catch(e) {}
        
        if (aCurr) {
            document.querySelectorAll('.tm-alerts-curr').forEach(el => el.innerText = aCurr === 'USD' ? '$' : (aCurr === 'EUR' ? '€' : aCurr));
        }

        if (t.type === 'TRANSFER' && t.destinationPortfolioId) {
            await _loadDestPortfolios();
            const destEl = document.getElementById('tm-dest-portfolio');
            if (destEl) destEl.value = t.destinationPortfolioId;
        }

        toggleTransactionFields(true); // skip auto-fetch to preserve existing rate
        
        // Restore manual amount if it was overridden by tmCalcNet
        const amountValue = t.amount || 0;
        if (amountValue && t.type === 'DIVIDEND') {
            document.getElementById('tm-amount').value = amountValue;
        }
    }

    // ─── Portfolio Selectors ─────────────────────────────────────────────────────
    let _portfolioCache = [];

    async function _loadPortfoliosSelect(selectedId = null) {
        try {
            const res = await fetch('/api/portfolios');
            const data = await res.json();
            _portfolioCache = data.portfolios || data || [];
            const select = document.getElementById('tm-portfolio');
            if (!select) return;
            select.innerHTML = _portfolioCache.map(p =>
                `<option value="${p.id}">${p.name} (${p.currency})</option>`
            ).join('');

            // Determine best default
            const desired = selectedId
                || window.mobCurrentPortfolioId
                || window.currentPortfolioId;
            if (desired) {
                select.value = String(desired);
            } else if (_portfolioCache.length > 0) {
                select.value = String(_portfolioCache[0].id);
            }
        } catch (e) { console.error('[TM] Failed to load portfolios', e); }
    }

    async function _loadDestPortfolios() {
        try {
            const res = await fetch('/api/portfolios');
            const data = await res.json();
            const all = data.portfolios || data || [];
            const currentId = document.getElementById('tm-portfolio')?.value;
            const select = document.getElementById('tm-dest-portfolio');
            if (!select) return;
            select.innerHTML = '<option value="">— Seleziona Target —</option>' +
                all.filter(p => String(p.id) !== String(currentId))
                    .map(p => `<option value="${p.id}">${p.name} (${p.currency})</option>`)
                    .join('');
        } catch (e) { /* silent */ }
    }

    function _getPortfolioCurrency(portfolioId) {
        const p = _portfolioCache.find(x => String(x.id) === String(portfolioId));
        return p ? p.currency : null;
    }

    // ─── Holdings Lookup ─────────────────────────────────────────────────────────
    function _getOwnedQuantity(ticker) {
        const pId = document.getElementById('tm-portfolio')?.value;
        const currentHoldings = window.currentHoldings || window.mobCurrentHoldings || window._portfolioData?.holdings || [];
        const cacheHoldings = pId && window._tmHoldingsCache ? window._tmHoldingsCache[pId] : [];
        const holdings = currentHoldings.length > 0 ? currentHoldings : cacheHoldings;
        const h = holdings.find(x => x.ticker === ticker);
        return h ? (h.shares || h.totalQuantity || h.quantity || 0) : 0;
    }

    // ─── Refresh helpers ─────────────────────────────────────────────────────────
    function _refreshAfterSave(portfolioId) {
        window.dispatchEvent(new CustomEvent('portfolios-updated'));
        window.dispatchEvent(new CustomEvent('market-data-updated'));
        if (typeof loadPortfolioDetails === 'function') loadPortfolioDetails();
        if (typeof mobLoadPortfolioDetail === 'function' && portfolioId) mobLoadPortfolioDetail(portfolioId);
        if (typeof mobUpdateDashboard === 'function') mobUpdateDashboard();
        if (typeof loadHistory === 'function') loadHistory();
    }

    // ─── Utilities ───────────────────────────────────────────────────────────────
    function _toggleField(id, show) {
        const el = document.getElementById(id);
        if (!el) return;
        if (show) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }

    function _hideSearchResults() {
        const r = document.getElementById('tm-search-results');
        if (r) r.classList.add('hidden');
    }

    // ─── Close on backdrop click ─────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
        const modal = document.getElementById('transaction-modal');
        if (modal && !modal.classList.contains('hidden') && e.target === modal) {
            closeTransactionModal();
        }
        // Close search results if clicking outside
        const results = document.getElementById('tm-search-results');
        const search = document.getElementById('tm-asset-search');
        if (results && search && !results.contains(e.target) && e.target !== search) {
            _hideSearchResults();
        }
    });

    // ─── Auto-inject when DOM ready ──────────────────────────────────────────────
    function _autoInit() {
        // Inject modal early so it's ready
        injectTransactionModal();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _autoInit);
    } else {
        _autoInit();
    }

})();
