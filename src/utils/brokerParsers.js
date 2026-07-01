/**
 * brokerParsers.js
 * Pluggable CSV parser for broker-specific transaction formats.
 * Supported: DIRECTA, IFIS (Banca IFIS Time Deposit)
 */

'use strict';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parseItalianNum(str) {
    if (str === null || str === undefined) return 0;
    const s = String(str).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function parseItalianDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return s;
}

function cleanTicker(raw) {
    if (!raw) return '';
    let t = raw.trim().toUpperCase();
    if (t.startsWith('.')) t = t.slice(1);
    return t;
}

function splitCsv(line, sep = ';') {
    return line.split(sep).map(c => c.trim());
}

// ─── AUTO-DETECT ──────────────────────────────────────────────────────────────

function detectBroker(csvText) {
    const lines = csvText.split('\n').slice(0, 20).join('\n').toLowerCase();
    if (lines.includes('tipo operazione') && lines.includes('riferimento ordine')) return 'DIRECTA';
    if (lines.includes('data contabile') && lines.includes('causale')) return 'IFIS';
    return 'GENERIC';
}

// ─── DIRECTA PARSER ───────────────────────────────────────────────────────────

const DIRECTA_TYPE_MAP = {
    'acquisto':                    'BUY',
    'vendita':                     'SELL',
    'incasso dividendi usa':       'DIVIDEND',
    'incasso dividendi esteri':    'DIVIDEND',
    'incasso dividendi':           'DIVIDEND',
    'provento etf':                'DIVIDEND',
    'conferimento con bonifico':   'DEPOSIT',
    'prelievo':                    'WITHDRAWAL',
    'giroconto in entrata':        'DEPOSIT',
    'giroconto in uscita':         'WITHDRAWAL',
};

const DIRECTA_COMMISSION_TYPES = new Set(['commissioni', 'commissione']);
const DIRECTA_RITENUTA_TYPES   = new Set([
    'rit.div.usa', 'ritenuta dividendi esteri', 'ritenuta dividendi',
    'rit.provento etf', 'rit. etf', 'rit.etf',
    'imposta capital gain', 'ritenuta'
]);

function parseDirecta(csvText) {
    const lines = csvText.split('\n');
    const transactions = [];
    const warnings = [];

    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        if (l.includes('data operazione') && l.includes('tipo operazione')) {
            headerIdx = i;
            break;
        }
    }

    if (headerIdx === -1) {
        return { transactions: [], warnings: ['Intestazione DIRECTA non trovata. Verifica il formato del file.'] };
    }

    const headerCols = splitCsv(lines[headerIdx]);
    const col = (name) => headerCols.findIndex(h => h.toLowerCase().trim().includes(name.toLowerCase()));

    const C = {
        dataOp:  col('data operazione'),
        dataVal: col('data valuta'),
        tipo:    col('tipo operazione'),
        ticker:  col('ticker'),
        isin:    col('isin'),
        desc:    col('descrizione'),
        qty:     col('quantit'),
        impEur:  col('importo euro'),
        impDiv:  col('importo divisa'),
        divisa:  col('divisa'),
        rifOrd:  col('riferimento ordine'),
    };

    const orderGroups  = {};
    const dividendRows = [];

    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.split(';').every(c => !c.trim())) continue;

        const cols = splitCsv(line);
        if (cols.length < 6) continue;

        const tipoRaw  = (cols[C.tipo]   || '').toLowerCase().trim();
        const tickerRaw = cols[C.ticker] || '';
        const isin     = cols[C.isin]    || '';
        const rifOrd   = (cols[C.rifOrd] || '').trim();
        const dateOp   = parseItalianDate(cols[C.dataOp]);
        const dateVal  = parseItalianDate(cols[C.dataVal]);
        const impEur   = parseItalianNum(cols[C.impEur]);
        const impDiv   = parseItalianNum(cols[C.impDiv]);
        const divisa   = (cols[C.divisa] || 'EUR').trim().toUpperCase();
        const qty      = Math.abs(parseItalianNum(cols[C.qty]));
        const desc     = cols[C.desc] || '';

        const row = { tipoRaw, tickerRaw, isin, rifOrd, dateOp, dateVal, impEur, impDiv, divisa, qty, desc };

        if (DIRECTA_COMMISSION_TYPES.has(tipoRaw)) {
            if (rifOrd) {
                if (!orderGroups[rifOrd]) orderGroups[rifOrd] = { mains: [], commissions: [], ritenute: [] };
                orderGroups[rifOrd].commissions.push(row);
            }
            continue;
        }

        if (DIRECTA_RITENUTA_TYPES.has(tipoRaw)) {
            if (rifOrd) {
                // Ritenuta on a BUY/SELL order (e.g. capital gain tax on ETF sale)
                if (!orderGroups[rifOrd]) orderGroups[rifOrd] = { mains: [], commissions: [], ritenute: [] };
                orderGroups[rifOrd].ritenute.push(row);
            } else {
                // Standalone ritenuta on dividend → match later
                dividendRows.push({ ...row, isRitenuta: true });
            }
            continue;
        }

        const ftType = DIRECTA_TYPE_MAP[tipoRaw];
        if (!ftType) {
            if (tipoRaw) warnings.push(`Tipo operazione ignorato: "${tipoRaw}" (${dateOp} ${tickerRaw})`);
            continue;
        }

        if (ftType === 'DIVIDEND') {
            dividendRows.push({ ...row, isRitenuta: false, ftType: 'DIVIDEND' });
            continue;
        }

        if ((ftType === 'BUY' || ftType === 'SELL') && rifOrd) {
            if (!orderGroups[rifOrd]) orderGroups[rifOrd] = { mains: [], commissions: [], ritenute: [] };
            orderGroups[rifOrd].mains.push({ ...row, ftType });
            continue;
        }

        // DEPOSIT / WITHDRAWAL
        transactions.push({
            date: dateOp, type: ftType,
            assetTicker: 'CASH', assetName: 'Cash', assetCurrency: 'EUR',
            assetType: 'Cash', assetExchange: 'N/A',
            quantity: 0, price: 0, commission: 0, tax: 0, exchangeRate: 1,
            amount: Math.abs(impEur), isin: '', dataSource: 'MANUAL',
        });
    }

    // Merge BUY/SELL groups (partial fills + commissions)
    for (const [rifOrd, group] of Object.entries(orderGroups)) {
        if (!group.mains.length) continue;
        const first  = group.mains[0];
        const ftType = first.ftType;
        const ticker = cleanTicker(first.tickerRaw);
        const divisa = first.divisa;
        const date   = first.dateVal || first.dateOp;

        let totalQty = 0, totalCostEur = 0, totalCostDiv = 0;
        for (const m of group.mains) {
            totalQty     += m.qty;
            totalCostEur += Math.abs(m.impEur);
            totalCostDiv += Math.abs(m.impDiv);
        }
        const totalComm = group.commissions.reduce((s, c) => s + Math.abs(c.impEur), 0);
        const totalTax  = (group.ritenute || []).reduce((s, r) => s + Math.abs(r.impEur), 0);
        const avgPriceEur = totalQty > 0 ? totalCostEur / totalQty : 0;
        let fxRate = 1;
        if (divisa !== 'EUR' && totalCostDiv > 0 && totalCostEur > 0) {
            fxRate = totalCostDiv / totalCostEur;
        }
        const priceInCurrency = fxRate !== 1 ? avgPriceEur * fxRate : avgPriceEur;

        transactions.push({
            date, type: ftType,
            assetTicker: ticker, assetName: first.desc || ticker,
            assetCurrency: divisa, assetType: 'Stock', assetExchange: 'N/A',
            quantity: totalQty,
            price: parseFloat(priceInCurrency.toFixed(6)),
            commission: parseFloat(totalComm.toFixed(4)),
            tax: parseFloat(totalTax.toFixed(4)),
            exchangeRate: parseFloat(fxRate.toFixed(6)),
            amount: parseFloat(totalCostEur.toFixed(4)),
            isin: first.isin, dataSource: 'YF',
        });
    }

    // Pair dividends with ritenute
    const grossDivs = dividendRows.filter(r => !r.isRitenuta);
    const ritenute  = dividendRows.filter(r => r.isRitenuta);

    for (const div of grossDivs) {
        const ticker   = cleanTicker(div.tickerRaw);
        const grossEur = Math.abs(div.impEur);
        const date     = div.dateOp;
        const divisa   = div.divisa;

        const matchIdx = ritenute.findIndex(r =>
            cleanTicker(r.tickerRaw) === ticker &&
            Math.abs(new Date(r.dateOp) - new Date(date)) <= 86400000 * 2
        );
        let taxEur = 0;
        if (matchIdx !== -1) { taxEur = Math.abs(ritenute[matchIdx].impEur); ritenute.splice(matchIdx, 1); }

        let fxRate = 1;
        if (divisa !== 'EUR' && Math.abs(div.impDiv) > 0 && grossEur > 0) {
            fxRate = Math.abs(div.impDiv) / grossEur;
        }

        transactions.push({
            date, type: 'DIVIDEND',
            assetTicker: ticker, assetName: div.desc || ticker,
            assetCurrency: divisa, assetType: 'Stock', assetExchange: 'N/A',
            quantity: 0, price: 0, commission: 0,
            tax: parseFloat(taxEur.toFixed(4)),
            exchangeRate: parseFloat(fxRate.toFixed(6)),
            amount: parseFloat((grossEur - taxEur).toFixed(4)),
            isin: div.isin, dataSource: 'YF',
        });
    }

    for (const r of ritenute) {
        warnings.push(`Ritenuta non abbinata: ${cleanTicker(r.tickerRaw)} ${r.dateOp} (€${Math.abs(r.impEur).toFixed(2)})`);
    }

    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));
    return { transactions, warnings };
}

// ─── IFIS PARSER ──────────────────────────────────────────────────────────────

const IFIS_CAUSALE_MAP = {
    '0R': 'DIVIDEND',   // Competenze Time Deposit
    '0P': 'BUY',        // Sottoscrizione Time Deposit
    '0Q': 'SELL',       // Rimborso partita Time Deposit
    '18': 'DIVIDEND',   // Competenze c/c
    'KK': 'TAX',        // Imposta bollo
    '1B': 'TAX',        // Commissioni bancarie
    'OW': 'DEPOSIT',
    'OB': 'WITHDRAWAL',
    'BI': 'DEPOSIT',
    'VE': 'WITHDRAWAL',
};

const IFIS_SKIP_CAUSALI = new Set(['GI', 'GV', 'BS', 'CS', 'PC']);

function extractIfisTickerFromDesc(desc, portfolioName) {
    if (!desc) return `CD_${(portfolioName || 'IFIS').toUpperCase()}`;
    const upper = desc.toUpperCase();
    const numMatch = upper.match(/N[.\s]+(\d+)/);
    if (numMatch) return `CD_${(portfolioName || 'IFIS').toUpperCase()}_${numMatch[1]}`;
    const partMatch = upper.match(/PARTITA\s+(\d+)/);
    if (partMatch) return `CD_${(portfolioName || 'IFIS').toUpperCase()}_${partMatch[1]}`;
    return `CD_${(portfolioName || 'IFIS').toUpperCase()}`;
}

function parseIfis(csvText, portfolioName = 'IFIS') {
    const lines = csvText.split('\n');
    const transactions = [];
    const warnings = [];

    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        if ((l.includes('data contabile') || l.includes('data operazione')) && l.includes('causale')) {
            headerIdx = i;
            break;
        }
    }

    let C = { dataContabile: 0, dataValuta: 1, dare: 2, avere: 3, divisa: 4, causale: 5, descrizione: 6 };

    if (headerIdx !== -1) {
        const hc = splitCsv(lines[headerIdx]).map(h => h.toLowerCase().trim());
        const fi = (name) => { const i = hc.findIndex(h => h.includes(name)); return i >= 0 ? i : C[name.replace(' ','')]; };
        C.dataContabile = fi('data contabile') >= 0 ? fi('data contabile') : fi('data operazione');
        C.dataValuta    = fi('data valuta');
        C.dare          = hc.findIndex(h => h === 'dare');
        C.avere         = hc.findIndex(h => h === 'avere');
        C.divisa        = fi('divisa');
        C.causale       = fi('causale');
        C.descrizione   = fi('descrizione');
        if (C.dare  < 0) C.dare  = 2;
        if (C.avere < 0) C.avere = 3;
    }

    const startLine = headerIdx >= 0 ? headerIdx + 1 : 0;

    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = splitCsv(line);
        if (cols.length < 5) continue;

        const dateRaw = cols[C.dataContabile] || '';
        const date    = parseItalianDate(dateRaw);
        if (!date || date.length < 8) continue;

        const causale  = (cols[C.causale]      || '').trim().toUpperCase();
        const desc     = (cols[C.descrizione]  || '').trim();
        const divisa   = (cols[C.divisa]        || 'EUR').trim().toUpperCase();
        const dare     = parseItalianNum(cols[C.dare]);
        const avere    = parseItalianNum(cols[C.avere]);

        if (IFIS_SKIP_CAUSALI.has(causale)) continue;

        const absAmount = avere > 0 ? avere : Math.abs(dare);
        if (absAmount === 0) continue;

        const ftType = IFIS_CAUSALE_MAP[causale];
        if (!ftType) {
            if (causale) warnings.push(`Causale "${causale}" non riconosciuta: ${date} "${desc}" (importo: ${absAmount.toFixed(2)})`);
            continue;
        }

        let ticker      = 'CASH';
        let assetType   = 'Cash';
        let assetExch   = 'N/A';

        const isDepositOp = ['0R','0P','0Q'].includes(causale) ||
            desc.toUpperCase().includes('TIME DEPOSIT') ||
            desc.toUpperCase().includes('DEPOSITO VINCOLATO');

        if (isDepositOp && ftType !== 'TAX') {
            ticker    = extractIfisTickerFromDesc(desc, portfolioName);
            assetType = 'Deposito Vincolato';
            assetExch = 'MANUAL';
        }

        transactions.push({
            date, type: ftType,
            assetTicker:   ticker,
            assetName:     ticker === 'CASH' ? 'Cash' : ticker,
            assetCurrency: divisa,
            assetType,
            assetExchange: assetExch,
            quantity:      (ftType === 'BUY' || ftType === 'SELL') ? 1 : 0,
            price:         (ftType === 'BUY' || ftType === 'SELL') ? absAmount : 0,
            commission:    0,
            tax:           ftType === 'TAX' ? absAmount : 0,
            exchangeRate:  1,
            amount:        ftType === 'TAX' ? 0 : absAmount,
            isin:          '',
            dataSource:    'MANUAL',
        });
    }

    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));
    return { transactions, warnings };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = { detectBroker, parseDirecta, parseIfis };
