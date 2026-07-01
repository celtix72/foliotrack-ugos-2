let importRows = [];

window.openImportModal = function() {
    document.getElementById('import-modal').classList.remove('hidden');
    document.getElementById('import-step-1').classList.remove('hidden');
    document.getElementById('import-step-2').classList.add('hidden');
    document.getElementById('import-step-3').classList.add('hidden');
    document.getElementById('import-paste-area').value = '';
    importRows = [];
};

window.closeImportModal = function() {
    document.getElementById('import-modal').classList.add('hidden');
};

window.goBackToStep1 = function() {
    document.getElementById('import-step-1').classList.remove('hidden');
    document.getElementById('import-step-2').classList.add('hidden');
};

function parseNum(str) {
    if (!str) return 0;
    const cleaned = str.replace(/[€$£\s]/g,'').replace(/\./g,'').replace(',','.');
    return parseFloat(cleaned) || 0;
}

function parseDate_IT(str) {
    const parts = str.trim().split('/');
    if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    return str.trim();
}

// ─── BROKER-SPECIFIC PARSE (via backend) ──────────────────────────────────────

async function parseBrokerSpecific(broker) {
    const raw = document.getElementById('import-paste-area').value.trim();
    if (!raw) { alert('Incolla prima il contenuto del file CSV.'); return; }

    const portfolioName = document.getElementById('import-portfolio-name-hint')?.value?.trim() || '';

    document.getElementById('import-step-1').classList.add('hidden');
    document.getElementById('import-step-3').classList.remove('hidden');
    document.getElementById('import-progress-label').textContent = `Parsing formato ${broker}...`;

    try {
        const resp = await fetch('/api/transactions/parse-broker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ broker, csv: raw, portfolioName })
        });

        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || 'Errore parsing');

        const detected = result.broker || broker;
        const txs      = result.transactions || [];
        const warns    = result.warnings || [];

        if (txs.length === 0) {
            document.getElementById('import-step-3').classList.add('hidden');
            document.getElementById('import-step-1').classList.remove('hidden');
            alert(`Nessuna transazione trovata (broker: ${detected}).\n${warns.join('\n')}`);
            return;
        }

        document.getElementById('import-progress-label').textContent = `Trovate ${txs.length} transazioni. Validazione ticker...`;

        // Convert to importRows format
        const parsed = txs.map(t => ({
            dateRaw:       t.date,
            date:          t.date,
            type:          t.type,
            portfolio:     t.portfolioName || '',
            tickerRaw:     t.assetTicker || '',
            ticker:        t.assetTicker || '',
            isin:          t.isin || '',
            dataSource:    t.dataSource || 'YF',
            currency:      t.assetCurrency || 'EUR',
            exchangeRate:  t.exchangeRate || 1,
            price:         t.price || 0,
            quantity:      t.quantity || 0,
            commission:    t.commission || 0,
            tax:           t.tax || 0,
            valEur:        t.amount || 0,
            yfName:        t.assetName || '',
            yfCurrency:    t.assetCurrency || 'EUR',
            yfExchange:    t.assetExchange || '',
            yfType:        t.assetType || 'Stock',
            yfPrice:       0,
            yfPe:          null,
            suggestions:   [],
            status:        (['CASH', ''].includes(t.assetTicker) || (t.assetType === 'Deposito Vincolato') || (t.dataSource === 'MANUAL')) ? 'ok' : 'pending',
            _brokerParsed: true,
        }));

        // Validate tickers for non-manual assets
        const uniqueKeys = [...new Set(parsed.filter(r => r.status === 'pending').map(r => JSON.stringify({ t: r.tickerRaw, i: r.isin })))];
        const tickerCache = {};

        for (let i = 0; i < uniqueKeys.length; i++) {
            const info = JSON.parse(uniqueKeys[i]);
            const tk   = info.t;
            const isin = info.i;
            const key  = tk + (isin ? '|' + isin : '');

            if (!tk || tk === 'CASH') { tickerCache[key] = { valid: true, ticker: 'CASH' }; continue; }
            if (tk.startsWith('BTP')) { tickerCache[key] = { valid: true, isBTP: true }; continue; }
            if (tk.startsWith('CD_')) { tickerCache[key] = { valid: true, ticker: tk, name: tk, type: 'Deposito Vincolato', currency: 'EUR', exchange: 'MANUAL', country: 'Italy' }; continue; }

            document.getElementById('import-progress-label').textContent = `Validazione ${tk} (${i+1}/${uniqueKeys.length})...`;
            try {
                const r = await fetch(`/api/validate-ticker?ticker=${encodeURIComponent(tk)}&isin=${encodeURIComponent(isin || '')}`);
                tickerCache[key] = await r.json();
            } catch { tickerCache[key] = { valid: false, suggestions: [] }; }
        }

        for (const row of parsed) {
            if (row.status === 'ok') continue;
            const key = row.tickerRaw + (row.isin ? '|' + row.isin : '');
            const result = tickerCache[key];
            if (!result) { row.status = 'manual'; continue; }
            if (result.isBTP) {
                row.status = 'ok'; row.yfName = row.ticker; row.yfType = 'Bond'; row.yfCurrency = 'EUR'; row.yfExchange = 'XMIL'; row.dataSource = 'B_ITA';
            } else if (result.valid) {
                row.status     = 'ok';
                row.ticker     = result.ticker || row.ticker;
                row.yfName     = result.name || row.yfName;
                row.yfCurrency = result.currency || row.yfCurrency;
                row.yfExchange = result.exchange || row.yfExchange;
                row.yfType     = result.type || row.yfType;
                row.yfPrice    = result.currentPrice || 0;
                row.yfPe       = result.pe || null;
                row.yfCountry  = result.country || '';
                row.isin       = result.isin || row.isin;
                row.dataSource = result.dataSource || 'YF';
            } else if (result.suggestions && result.suggestions.length) {
                row.status     = 'suggestions';
                row.suggestions = result.suggestions;
            } else {
                row.status = 'manual';
            }
        }

        if (warns.length > 0) {
            console.warn(`[${detected}] Import warnings:\n` + warns.join('\n'));
        }

        importRows = parsed;
        document.getElementById('import-step-3').classList.add('hidden');
        document.getElementById('import-step-2').classList.remove('hidden');
        renderImportPreview();

        // Show warnings as a non-blocking banner
        const warnBanner = document.getElementById('import-warn-banner');
        if (warnBanner) {
            if (warns.length > 0) {
                warnBanner.textContent = `⚠️ ${warns.length} avviso/i: ` + warns.slice(0,3).join(' | ') + (warns.length > 3 ? ` ...+${warns.length-3} altri` : '');
                warnBanner.classList.remove('hidden');
            } else {
                warnBanner.classList.add('hidden');
            }
        }

    } catch (err) {
        document.getElementById('import-step-3').classList.add('hidden');
        document.getElementById('import-step-1').classList.remove('hidden');
        alert('Errore parsing: ' + err.message);
    }
}

// ─── GENERIC PARSE (client-side, existing logic) ──────────────────────────────

window.parseImportData = async function() {
    const raw = document.getElementById('import-paste-area').value.trim();
    if (!raw) { alert('Please paste some data first.'); return; }

    // Check if broker-specific mode is selected
    const brokerSel = document.getElementById('import-broker-select');
    const broker    = brokerSel ? brokerSel.value : 'GENERIC';
    if (broker !== 'GENERIC') {
        return parseBrokerSpecific(broker);
    }

    const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
    const headerKeywords = ['data','operazione','portfolio','ticker','val','price','qta'];
    const parsed = [];
    for (const line of lines) {
        const cols = line.split(/\t/).map(c => c.trim());
        if (cols.length < 7) continue; 
        if (headerKeywords.some(k => cols[0].toLowerCase().includes(k))) continue;

        let type = (cols[1] || 'BUY').toUpperCase();
        const rawTicker = (cols[3] || '').toUpperCase();

        if (['DIV', 'DIVIDENDO', 'CEDOLA', 'DIV'].includes(type)) type = 'DIVIDEND';
        if (['ACQUISTO', 'COMPRA'].includes(type)) type = 'BUY';
        if (['VENDITA'].includes(type)) type = 'SELL';
        if (['TRASFERIMENTO'].includes(type)) type = 'TRANSFER';
        
        const isDepositLike = ['CASH', 'DEPOSITO', 'VERSAMENTO', 'ACCREDITO', 'DEPOSIT'].includes(type);
        const isWithdrawLike = ['PRELIEVO', 'MINUS', 'ADDEBITO', 'WITHDRAWAL', 'PRELIMINARE'].includes(type);

        if (isDepositLike) {
            type = rawTicker.startsWith('CD_') ? 'BUY' : 'DEPOSIT';
        } else if (isWithdrawLike) {
            type = rawTicker.startsWith('CD_') ? 'SELL' : 'WITHDRAWAL';
        }

        if (rawTicker === 'CASH' || !rawTicker) {
            if (type === 'BUY') type = 'DEPOSIT';
            if (type === 'SELL') type = 'WITHDRAWAL';
        }

        const validTypes = ['BUY','SELL','DIVIDEND','DEPOSIT','WITHDRAWAL','TAX', 'TRANSFER'];
        if (!validTypes.includes(type)) continue;

        const isinValue = cols[4] ? cols[4].trim() : '';
        const currencyVal = cols.length > 5 ? cols[5] : 'USD';
        
        const qty   = parseNum(cols[8]);
        const price = parseNum(cols[7]);
        const comm  = parseNum(cols[9]);
        const tax   = parseNum(cols[11]);
        
        let amount = 0;
        if (['DEPOSIT', 'WITHDRAWAL', 'TAX', 'TRANSFER'].includes(type)) {
            amount = cols.length <= 8 ? price : (cols[10] ? parseNum(cols[10]) : price);
        }

        parsed.push({
            dateRaw:      cols[0],
            date:         parseDate_IT(cols[0]),
            type,
            portfolio:    cols[2] || '',
            tickerRaw:    cols[3] || '',
            ticker:       cols[3] || '',
            isin:         isinValue,
            dataSource:   (isinValue || (cols[3] || '').toUpperCase().startsWith('BTP')) ? 'B_ITA' : 'YF',
            currency:     currencyVal || 'USD',
            exchangeRate: parseNum(cols[6]) || 1,
            price:        price,
            quantity:     qty,
            commission:   comm,
            valEur:       (type === 'DIVIDEND') 
                            ? (parseNum(cols[13]) || parseNum(cols[10]) || (parseNum(cols[8]) * parseNum(cols[7]) - parseNum(cols[11]))) 
                            : (amount || parseNum(cols[10])),
            tax:          tax,
            status:       'pending',
            yfName:       '',
            yfCurrency:   '',
            yfExchange:   '',
            yfType:       '',
            yfPrice:      0,
            yfPe:         null,
            suggestions:  []
        });
    }

    if (!parsed.length) {
        alert('No valid rows found.');
        return;
    }

    document.getElementById('import-step-1').classList.add('hidden');
    document.getElementById('import-step-3').classList.remove('hidden');
    const progressLabel = document.getElementById('import-progress-label');

    const uniqueAssetKeys = [...new Set(parsed.map(r => JSON.stringify({t: r.tickerRaw, i: r.isin})))];
    const tickerCache = {};

    for (let i = 0; i < uniqueAssetKeys.length; i++) {
        const assetInfo = JSON.parse(uniqueAssetKeys[i]);
        const tk = assetInfo.t;
        const isin = assetInfo.i;
        const cacheKey = tk + (isin ? '|'+isin : '');

        if (tk.toUpperCase().startsWith('BTP')) {
            tickerCache[cacheKey] = { valid: true, isBTP: true };
            progressLabel.textContent = `BTP virtual asset: ${tk} → B_ITA (${i+1}/${uniqueAssetKeys.length})`;
            continue;
        }

        if (tk.toUpperCase().startsWith('CD_')) {
            tickerCache[cacheKey] = { 
                valid: true, 
                ticker: tk, 
                name: tk, 
                type: 'Deposito Vincolato', 
                currency: 'EUR', 
                exchange: 'N/A', 
                country: 'Italy' 
            };
            continue;
        }
        progressLabel.textContent = `Validating ${tk || isin} (${i+1}/${uniqueAssetKeys.length})...`;
        try {
            const url = `/api/validate-ticker?ticker=${encodeURIComponent(tk)}&isin=${encodeURIComponent(isin || '')}`;
            const res = await fetch(url);
            tickerCache[cacheKey] = await res.json();
        } catch {
            tickerCache[cacheKey] = { valid: false, suggestions: [] };
        }
    }

    for (const row of parsed) {
        const cacheKey = row.tickerRaw + (row.isin ? '|'+row.isin : '');
        const result = tickerCache[cacheKey];
        if (!result) { row.status = 'manual'; continue; }
        if (result.isBTP) {
            row.status     = 'ok';
            row.yfName     = row.ticker + (row.isin ? ` (${row.isin})` : '');
            row.yfCurrency = row.currency || 'EUR';
            row.yfExchange = 'XMIL';
            row.yfType     = 'Bond';
            row.dataSource = 'B_ITA';
        } else if (result.valid) {
            row.status     = 'ok';
            row.ticker     = result.ticker;
            row.yfName     = result.name;
            row.yfCurrency = result.currency;
            row.yfExchange = result.exchange;
            row.yfType     = result.type;
            row.yfPrice    = result.currentPrice;
            row.yfPe       = result.pe;
            row.yfCountry  = result.country;
            row.isin       = result.isin || row.isin;
            row.dataSource = result.dataSource || 'YF';
        } else if (result.suggestions && result.suggestions.length) {
            row.status      = 'suggestions';
            row.suggestions = result.suggestions;
        } else {
            row.status = 'manual';
        }
    }

    importRows = parsed;
    document.getElementById('import-step-3').classList.add('hidden');
    document.getElementById('import-step-2').classList.remove('hidden');
    renderImportPreview();
};

window.renderImportPreview = function() {
    const tbody = document.getElementById('import-preview-body');
    let okCount   = 0;
    let warnCount = 0;

    tbody.innerHTML = importRows.map((r, idx) => {
        let statusHtml;
        let tickerCell;

        if (r.status === 'ok') {
            okCount++;
            statusHtml = `<span title="Valid" class="text-emerald-500 text-base">🟢</span>`;
            const isBond = (r.ticker && typeof r.ticker === 'string' && r.ticker.toUpperCase().startsWith('BTP')) || r.dataSource === 'B_ITA';
            tickerCell = `<div class="font-bold text-primary">${r.ticker || r.tickerRaw} ${isBond ? ' <span class="inline-block px-1 py-0.5 rounded text-[8px] font-black bg-orange-100 text-orange-600">BI</span>' : ''}</div><div class="text-[10px] text-slate-400">${(isBond && r.isin) ? r.isin : (r.yfName || '')}</div>`;
        } else if (r.status === 'suggestions') {
            warnCount++;
            statusHtml = `<span title="Suggestions" class="text-base">🟡</span>`;
            const opts = r.suggestions.map(s => `<option value="${s.symbol}" data-name="${s.name}" data-exch="${s.exchange}">${s.symbol} — ${s.name}</option>`).join('');
            tickerCell = `<div>
                <input id="ticker-edit-${idx}" value="${r.ticker}" class="w-28 bg-amber-50 rounded px-2 py-1 font-bold text-xs" />
                <select onchange="applySuggestion(${idx}, this)" class="block w-full text-[10px] mt-1">
                    <option value="">— Pick suggestion —</option>${opts}
                </select>
            </div>`;
        } else {
            warnCount++;
            statusHtml = `<span title="Not found" class="text-base">🔴</span>`;
            tickerCell = `<input id="ticker-edit-${idx}" value="${r.ticker}" class="w-28 bg-red-50 rounded px-2 py-1 font-bold text-xs" oninput="importRows[${idx}].ticker=this.value" />`;
        }

        return `<tr class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
            <td class="px-3 py-2.5 text-center">${statusHtml}</td>
            <td class="px-3 py-2.5 font-mono">${r.dateRaw}</td>
            <td class="px-3 py-2.5">
                <span class="px-2 py-0.5 rounded text-[10px] font-bold ${ r.type==='BUY'?'bg-emerald-100 text-emerald-600':(r.type==='SELL'?'bg-red-100 text-red-500':(r.type==='DIVIDEND'?'bg-blue-100 text-blue-500':'bg-slate-100 text-slate-500')) }">${r.type}</span>
            </td>
            <td class="px-3 py-2.5">${tickerCell}</td>
            <td class="px-3 py-2.5 truncate max-w-[120px]">${r.yfName || r.tickerRaw}</td>
            <td class="px-3 py-2.5 font-bold">${r.yfCurrency || r.currency}</td>
            <td class="px-3 py-2.5 text-right font-mono">${(r.exchangeRate || 0).toFixed(4)}</td>
            <td class="px-3 py-2.5 text-right font-mono">${(r.price || 0).toFixed(2)}</td>
            <td class="px-3 py-2.5 text-right font-mono">${(r.quantity || 0).toFixed(0)}</td>
            <td class="px-3 py-2.5 text-right text-slate-500">${r.commission || 0}</td>
            <td class="px-3 py-2.5 text-right text-slate-500">${r.tax || 0}</td>
            <td class="px-3 py-2.5 text-right font-bold text-emerald-600">${(r.valEur || 0).toFixed(2)}</td>
        </tr>`;
    }).join('');

    document.getElementById('import-ok-count').textContent   = `${okCount} OK`;
    document.getElementById('import-warn-count').textContent = `${warnCount} Need Review`;
};

window.applySuggestion = function(idx, selectEl) {
    const symbol = selectEl.value;
    if (!symbol) return;
    importRows[idx].ticker = symbol;
    importRows[idx].status = 'ok';
    const opt = selectEl.options[selectEl.selectedIndex];
    importRows[idx].yfName     = opt.dataset.name || symbol;
    importRows[idx].yfExchange = opt.dataset.exch || '';
    const input = document.getElementById(`ticker-edit-${idx}`);
    if (input) input.value = symbol;
    window.renderImportPreview();
};

window.confirmImport = async function() {
    importRows.forEach((r, idx) => {
        const el = document.getElementById(`ticker-edit-${idx}`);
        if (el) r.ticker = el.value.trim() || r.tickerRaw;
    });

    const toImport = importRows.map(r => ({
        type:         r.type,
        assetTicker:  r.ticker || r.tickerRaw,
        assetName:    r.yfName || r.ticker || r.tickerRaw,
        assetCurrency:r.yfCurrency || r.currency,
        assetExchange:r.yfExchange || '',
        assetType:    r.yfType || 'Stock',
        assetPrice:   r.yfPrice || 0,
        assetPe:      r.yfPe || null,
        assetCountry: r.yfCountry || 'Global',
        date:         r.date,
        quantity:     r.quantity,
        price:        r.price,
        commission:   r.commission,
        tax:          r.tax,
        exchangeRate: r.exchangeRate,
        amount:       r.valEur,
        portfolioName:r.portfolio,
        isin:         r.isin,
        dataSource:   r.dataSource
    }));

    document.getElementById('import-step-2').classList.add('hidden');
    document.getElementById('import-step-3').classList.remove('hidden');
    document.getElementById('import-progress-label').textContent = `Importing ${toImport.length} transactions...`;

    try {
        const pId = window.currentPortfolioId || 'all';
        const res = await fetch('/api/transactions/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ portfolioId: pId, transactions: toImport })
        });
        
        if (!res.ok) {
            const text = await res.text();
            let errMsg = text;
            try {
                const errJson = JSON.parse(text);
                errMsg = errJson.error || errJson.message || text;
            } catch(e) {}
            throw new Error(errMsg);
        }

        const result = await res.json();
        closeImportModal();
        alert(`✅ Imported ${result.imported} transactions.`);
        
        if (window.currentPortfolioId && typeof loadPortfolioDetails === 'function') {
            loadPortfolioDetails();
        } else if (typeof loadPortfolios === 'function' || typeof loadDashboard === 'function') {
            window.dispatchEvent(new CustomEvent('portfolios-updated'));
            if (typeof loadDashboard === 'function') loadDashboard();
            else if (typeof loadPortfolios === 'function') loadPortfolios();
        } else {
            window.location.reload();
        }
    } catch (err) {
        alert('Import failed: ' + err.message);
        goBackToStep1();
    }
};
