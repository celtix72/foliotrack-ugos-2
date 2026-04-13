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
        return `
<div id="transaction-modal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm hidden items-center justify-center p-3 md:p-4 overflow-y-auto" style="z-index: 10000">
    <div class="bg-white dark:bg-[#111722] border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl max-h-[95vh] flex flex-col my-auto">

        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                    <span class="material-symbols-outlined text-primary text-lg" id="tm-header-icon">swap_horiz</span>
                </div>
                <h3 id="tm-title" class="font-black text-base text-slate-900 dark:text-white">Nuova Transazione</h3>
            </div>
            <button type="button" onclick="closeTransactionModal()" class="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-all">
                <span class="material-symbols-outlined text-lg">close</span>
            </button>
        </div>

        <!-- Body -->
        <form id="tm-form" class="block overflow-hidden" onsubmit="handleTransactionSubmit(event)">
            <input type="hidden" id="tm-id" />
            <div class="p-5 space-y-4 overflow-y-auto custom-scrollbar" style="max-height: calc(95vh - 140px);">

                <!-- Row 1: Portafoglio + Tipo -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div id="tm-portfolio-wrap" class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Portafoglio</label>
                        <select id="tm-portfolio" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all">
                            <option value="">— Caricamento... —</option>
                        </select>
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Tipo Transazione</label>
                        <select id="tm-type" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" onchange="toggleTransactionFields()">
                            <option value="BUY">🟢 ACQUISTO</option>
                            <option value="SELL">🔴 VENDITA</option>
                            <option value="DIVIDEND">💵 DIVIDENDO</option>
                            <option value="DEPOSIT">📥 DEPOSITO</option>
                            <option value="WITHDRAWAL">📤 PRELIEVO</option>
                            <option value="TAX">🏛 TAX</option>
                            <option value="TRANSFER">↔️ TRASFERIMENTO</option>
                        </select>
                    </div>
                </div>

                <!-- Row 2: Data + Sorgente Dati (solo BUY) -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Data</label>
                        <input id="tm-date" type="date" required class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                    </div>
                    <div id="tm-source-wrap" class="space-y-1.5 hidden">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Sorgente Dati</label>
                        <select id="tm-source" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" onchange="toggleTransactionFields()">
                            <option value="YF">📈 Yahoo Finance</option>
                            <option value="B_ITA">🇮🇹 Borsa Italiana</option>
                            <option value="MANUAL">✏️ Manuale</option>
                        </select>
                    </div>
                </div>

                <!-- Asset Search (BUY / SELL / DIVIDEND) -->
                <div id="tm-asset-wrap" class="hidden space-y-3">
                    <div class="space-y-1.5 relative">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Asset (Ticker)</label>
                        <input id="tm-asset-search" type="text" autocomplete="off"
                            placeholder="Es. AAPL, ISP.MI..."
                            class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                            oninput="handleTMAssetInput(this.value)"
                            onfocus="handleTMAssetFocus()"
                            onclick="handleTMAssetFocus()" />
                        <div id="tm-search-results" class="hidden absolute left-0 right-0 top-full mt-1 z-50 bg-white dark:bg-[#1a2332] border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-48 overflow-y-auto"></div>
                        <input type="hidden" id="tm-asset-ticker" />
                        <input type="hidden" id="tm-asset-currency" value="EUR" />
                    </div>

                    <!-- ISIN (solo B_ITA) -->
                    <div id="tm-isin-wrap" class="hidden space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">ISIN (Borsa Italiana)</label>
                        <input id="tm-isin" type="text" placeholder="Es. IT0000072618"
                            class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-mono font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                    </div>

                    <!-- Manual Asset Fields -->
                    <div id="tm-manual-wrap" class="hidden grid grid-cols-2 gap-4">
                        <div class="space-y-1.5">
                            <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Nome Asset</label>
                            <input id="tm-asset-name" type="text" placeholder="Es. Conto Deposito Fineco"
                                class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                        </div>
                        <div class="space-y-1.5">
                            <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Valuta</label>
                            <select id="tm-asset-currency-manual" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" onchange="tmCheckFX()">
                                <option value="EUR">EUR</option>
                                <option value="USD">USD</option>
                                <option value="GBP">GBP</option>
                                <option value="CHF">CHF</option>
                            </select>
                        </div>
                    </div>

                    <!-- Asset Metadata -->
                    <div id="tm-asset-meta" class="hidden p-3 bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 rounded-xl grid grid-cols-3 gap-3">
                        <div>
                            <p class="text-[9px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">Mercato</p>
                            <p id="tm-meta-exchange" class="text-[11px] font-black text-slate-700 dark:text-slate-200 truncate">—</p>
                        </div>
                        <div>
                            <p class="text-[9px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">Tipologia</p>
                            <p id="tm-meta-type" class="text-[11px] font-black text-slate-700 dark:text-slate-200 truncate">—</p>
                        </div>
                        <div>
                            <p class="text-[9px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">Prezzo Att.</p>
                            <p id="tm-meta-price" class="text-[11px] font-black text-primary truncate">—</p>
                        </div>
                    </div>
                </div>

                <!-- Quantità + Prezzo (BUY / SELL / DIVIDEND) -->
                <div id="tm-qty-price-wrap" class="hidden grid grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500" id="tm-qty-label">Quantità</label>
                        <input id="tm-qty" type="number" step="any" placeholder="0"
                            class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                            oninput="tmCalcNet()" />
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500" id="tm-price-label">Prezzo</label>
                        <input id="tm-price" type="number" step="any" placeholder="0.00"
                            class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                            oninput="tmCalcNet()" />
                    </div>
                </div>

                <!-- FX Rate (solo se asset in valuta diversa dal portafoglio) -->
                <div id="tm-fx-wrap" class="hidden">
                    <div class="p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl flex items-center justify-between gap-4">
                        <div>
                            <p class="text-[10px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">Cambio FX</p>
                            <p class="text-[11px] text-slate-500 mt-0.5"><span id="tm-fx-from">USD</span> / <span id="tm-fx-to">EUR</span></p>
                        </div>
                        <input id="tm-fx" type="number" step="any" value="1"
                            class="w-28 text-right bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 px-2 font-bold font-mono text-sm focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none"
                            oninput="tmCalcNet()" />
                    </div>
                </div>

                <!-- Commissioni + Tax (solo BUY / SELL) -->
                <div id="tm-comm-tax-wrap" class="hidden grid grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Commissioni</label>
                        <input id="tm-comm" type="number" step="any" value="0"
                            class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" />
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Tax / Ritenuta</label>
                        <input id="tm-tax" type="number" step="any" value="0"
                            class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                            oninput="tmCalcNet()" />
                    </div>
                </div>

                <!-- Importo Totale (DEPOSIT / WITHDRAWAL / TAX / TRANSFER / DIVIDEND auto-calc) -->
                <div id="tm-amount-wrap" class="hidden space-y-1.5">
                    <label class="text-[10px] font-black uppercase tracking-widest text-slate-500" id="tm-amount-label">Importo Totale</label>
                    <input id="tm-amount" type="number" step="any" placeholder="0.00"
                        class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                        oninput="if(typeof tmCalcFromAmount === 'function') tmCalcFromAmount()" />
                    <p class="text-[10px] text-slate-400 italic mt-1" id="tm-amount-hint"></p>
                </div>

                <!-- Portafoglio Destinazione (solo TRANSFER) -->
                <div id="tm-dest-wrap" class="hidden space-y-1.5">
                    <label class="text-[10px] font-black uppercase tracking-widest text-slate-500">Portafoglio Destinazione</label>
                    <select id="tm-dest-portfolio" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl py-2.5 px-3 text-sm font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all">
                        <option value="">— Seleziona Target —</option>
                    </select>
                </div>

            </div>

            <!-- Footer -->
            <div class="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center gap-3 shrink-0 bg-slate-50/50 dark:bg-slate-900/30">
                <button type="button" onclick="closeTransactionModal()" class="flex-1 py-2.5 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all text-sm">
                    Annulla
                </button>
                <button type="submit" id="tm-submit-btn"
                    class="flex-1 py-2.5 rounded-xl font-black text-white bg-emerald-500 hover:bg-emerald-600 shadow-lg shadow-emerald-500/20 transition-all text-sm flex items-center justify-center gap-2">
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
        if (_injected || document.getElementById('transaction-modal')) {
            _injected = true;
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
        injectTransactionModal();
        const modal = document.getElementById('transaction-modal');
        if (!modal) return;

        // Reset form
        const form = document.getElementById('tm-form');
        if (form) form.reset();
        document.getElementById('tm-id').value = '';
        document.getElementById('tm-asset-ticker').value = '';
        document.getElementById('tm-asset-currency').value = 'EUR';
        document.getElementById('tm-fx').value = '1';
        document.getElementById('tm-comm').value = '0';
        document.getElementById('tm-tax').value = '0';
        document.getElementById('tm-amount').value = '';
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

        // Show
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
        document.body.classList.add('modal-open');
    };

    // ─── Close Modal ─────────────────────────────────────────────────────────────
    window.closeTransactionModal = function () {
        const modal = document.getElementById('transaction-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
        }
        document.body.classList.remove('modal-open');
        _hideSearchResults();
    };

    // ─── Toggle Field Visibility ─────────────────────────────────────────────────
    window.toggleTransactionFields = function () {
        const type = (document.getElementById('tm-type')?.value || 'BUY').toUpperCase();
        const source = (document.getElementById('tm-source')?.value || 'YF');

        const isTrade = ['BUY', 'SELL'].includes(type);
        const isDividend = type === 'DIVIDEND';
        const isCashOnly = ['DEPOSIT', 'WITHDRAWAL', 'TAX', 'TRANSFER'].includes(type);
        const isTransfer = type === 'TRANSFER';
        const needsAsset = isTrade || isDividend;

        // Sorgente dati: solo BUY
        _toggleField('tm-source-wrap', type === 'BUY');

        // Asset search block
        _toggleField('tm-asset-wrap', needsAsset);

        // ISIN: solo BUY + B_ITA
        _toggleField('tm-isin-wrap', type === 'BUY' && source === 'B_ITA');

        // Campi manuali: solo BUY + MANUAL
        _toggleField('tm-manual-wrap', type === 'BUY' && source === 'MANUAL');

        // Quantità + Prezzo: BUY, SELL, DIVIDEND
        _toggleField('tm-qty-price-wrap', needsAsset);

        // Labels dinamiche
        if (isDividend) {
            document.getElementById('tm-qty-label').innerText = 'Quantità Posseduta';
            document.getElementById('tm-price-label').innerText = 'Dividendo Unitario (€)';
        } else {
            document.getElementById('tm-qty-label').innerText = 'Quantità';
            document.getElementById('tm-price-label').innerText = 'Prezzo';
        }

        // Commissioni + Tax: solo BUY, SELL
        _toggleField('tm-comm-tax-wrap', isTrade);

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

        tmCheckFX();
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
            document.getElementById('tm-fx-from').innerText = assetCurr;
            document.getElementById('tm-fx-to').innerText = portfolioCurr;
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
                    return `<div class="px-4 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-sm transition-colors border-b border-slate-100 dark:border-slate-800/50 last:border-0"
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
                if (data.currency) document.getElementById('tm-asset-currency').value = data.currency;
                if (data.isin) document.getElementById('tm-isin').value = data.isin;
                if (data.dataSource && document.getElementById('tm-source')) {
                    document.getElementById('tm-source').value = data.dataSource;
                    toggleTransactionFields();
                }

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
        await openTransactionModal({ portfolioId: t.portfolioId });

        document.getElementById('tm-id').value = isDuplicate ? '' : (t.id || '');
        document.getElementById('tm-title').innerText = isDuplicate ? 'Duplica Transazione' : 'Modifica Transazione';
        document.getElementById('tm-submit-label').innerText = isDuplicate ? 'Inserisci Copia' : 'Salva Modifiche';

        document.getElementById('tm-type').value = t.type || 'BUY';
        document.getElementById('tm-date').value = isDuplicate ? new Date().toISOString().split('T')[0] : (t.date || '');
        document.getElementById('tm-qty').value = t.quantity || 0;
        document.getElementById('tm-price').value = t.price || 0;
        document.getElementById('tm-comm').value = t.commission || 0;
        document.getElementById('tm-tax').value = t.tax || 0;
        document.getElementById('tm-fx').value = t.exchangeRate || t.fxRate || 1;
        document.getElementById('tm-amount').value = t.amount || 0;
        document.getElementById('tm-asset-ticker').value = t.assetTicker || t.ticker || '';
        document.getElementById('tm-asset-search').value = t.assetTicker || t.ticker || '';
        document.getElementById('tm-isin').value = t.isin || '';

        const source = t.dataSource || 'YF';
        document.getElementById('tm-source').value = source;
        if (t.assetName) document.getElementById('tm-asset-name').value = t.assetName;
        if (t.assetCurrency) {
            document.getElementById('tm-asset-currency').value = t.assetCurrency;
            document.getElementById('tm-asset-currency-manual').value = t.assetCurrency;
        }

        if (t.type === 'TRANSFER' && t.destinationPortfolioId) {
            await _loadDestPortfolios();
            const destEl = document.getElementById('tm-dest-portfolio');
            if (destEl) destEl.value = t.destinationPortfolioId;
        }

        toggleTransactionFields();
        await tmCheckFX(true); // skip auto-fetch to preserve existing rate
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
