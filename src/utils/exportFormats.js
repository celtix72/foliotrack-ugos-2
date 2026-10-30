/**
 * Export Formats Utility
 * Provides generators for various transaction export formats,
 * including Wealthfolio (wealthfolio.app) and standard CSV.
 */

/**
 * Normalizes any date string (ISO, timestamp, DD/MM/YYYY, etc.) to YYYY-MM-DD
 */
function formatWealthfolioDate(dateStr) {
    if (!dateStr) return '';
    const str = String(dateStr).trim();
    if (str.includes('T')) return str.split('T')[0];

    const slashParts = str.split(/[\/\-]/);
    if (slashParts.length === 3) {
        if (slashParts[0].length === 4) {
            // YYYY-MM-DD
            return `${slashParts[0]}-${slashParts[1].padStart(2, '0')}-${slashParts[2].padStart(2, '0')}`;
        } else if (slashParts[2].length === 4) {
            // DD/MM/YYYY
            return `${slashParts[2]}-${slashParts[1].padStart(2, '0')}-${slashParts[0].padStart(2, '0')}`;
        }
    }
    return str.substring(0, 10);
}

/**
 * Maps asset class/type to Wealthfolio supported instrumentType:
 * EQUITY, ETF, CRYPTO, BOND, MUTUAL_FUND, COMMODITY, CASH (or empty for cash movements)
 */
function mapToWealthfolioInstrumentType(assetType, ticker) {
    if (!ticker || ticker.toUpperCase() === 'CASH') return '';
    const t = (assetType || '').toLowerCase().trim();
    const tick = (ticker || '').toUpperCase().trim();

    if (t.includes('etf')) return 'ETF';
    if (t.includes('crypto') || t.includes('cripto') || ['BTC', 'ETH', 'SOL', 'BTC-EUR', 'ETH-EUR', 'BTCUSD', 'ETHUSD'].includes(tick)) return 'CRYPTO';
    if (t.includes('bond') || t.includes('obblig') || t.includes('btp') || t.includes('bot') || tick.startsWith('IT000') || tick.startsWith('ROM')) return 'BOND';
    if (t.includes('fund') || t.includes('fondo')) return 'MUTUAL_FUND';
    if (t.includes('commodity') || t.includes('materia') || t.includes('oro') || t.includes('gold') || tick.includes('PHAU') || tick.includes('SGLD')) return 'COMMODITY';
    if (t.includes('liquid') || t.includes('conto') || t.includes('deposito') || tick.startsWith('CD_') || tick.startsWith('BP_')) return '';
    return 'EQUITY';
}

/**
 * Maps FolioTrack transaction type to Wealthfolio supported activityType:
 * BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, FEE, TAX, SPLIT, CREDIT, ADJUSTMENT
 */
function mapToWealthfolioActivityType(rawType) {
    const t = (rawType || 'BUY').toUpperCase().trim();
    switch (t) {
        case 'BUY':
            return 'BUY';
        case 'SELL':
            return 'SELL';
        case 'DIVIDEND':
            return 'DIVIDEND';
        case 'INTEREST':
            return 'INTEREST';
        case 'DEPOSIT':
            return 'DEPOSIT';
        case 'WITHDRAWAL':
            return 'WITHDRAWAL';
        case 'TRANSFER':
            return 'TRANSFER_OUT';
        case 'TRANSFER_IN':
            return 'TRANSFER_IN';
        case 'TRANSFER_OUT':
            return 'TRANSFER_OUT';
        case 'FEE':
        case 'COMMISSION':
            return 'FEE';
        case 'TAX':
            return 'TAX';
        case 'SPLIT':
            return 'SPLIT';
        case 'CREDIT':
            return 'CREDIT';
        case 'ADJUSTMENT':
            return 'ADJUSTMENT';
        default:
            return t;
    }
}

/**
 * Generates a Wealthfolio compatible CSV string from an array of transactions.
 * Specification:
 * date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype
 * 
 * Rules:
 * - date: YYYY-MM-DD
 * - symbol: asset ticker (empty for pure cash movements)
 * - instrumentType: EQUITY, ETF, CRYPTO, BOND, etc. (empty for cash)
 * - quantity: positive number. 1 for cash deposits/withdrawals. Empty for SPLIT.
 * - activityType: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, etc.
 * - unitPrice: price per share. 1 for cash deposits/withdrawals.
 * - currency: USD, EUR, etc.
 * - fee: commissions/fees
 * - tax: taxes paid
 * - amount: total cash amount for cash movements & dividends; split ratio for SPLIT; empty for BUY/SELL
 * - fxRate: FX exchange rate if foreign currency
 * - subtype: QUALIFIED for dividends, else empty
 * 
 * @param {Array} transactions 
 * @param {string} defaultCurrency 
 * @returns {string} CSV text
 */
function generateWealthfolioCSV(transactions, defaultCurrency = 'EUR') {
    const headers = [
        'date',
        'symbol',
        'instrumentType',
        'quantity',
        'activityType',
        'unitPrice',
        'currency',
        'fee',
        'tax',
        'amount',
        'fxRate',
        'subtype'
    ];

    // Ensure chronological order (oldest to newest) for flawless import
    const sorted = [...(transactions || [])].sort((a, b) => {
        const da = a.date || '';
        const db = b.date || '';
        if (da !== db) return da.localeCompare(db);
        return (a.id || 0) - (b.id || 0);
    });

    const rows = sorted.map(t => {
        const date = formatWealthfolioDate(t.date);
        const activityType = mapToWealthfolioActivityType(t.type);
        const rawTicker = (t.assetTicker || '').trim();
        const isCashTicker = !rawTicker || rawTicker.toUpperCase() === 'CASH';

        // Symbol & Instrument Type
        let symbol = '';
        if (!['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'CREDIT'].includes(activityType) && !isCashTicker) {
            symbol = rawTicker;
        } else if (!isCashTicker && rawTicker) {
            symbol = rawTicker;
        }

        const instrumentType = symbol ? mapToWealthfolioInstrumentType(t.assetType, symbol) : '';

        // Quantity
        let quantity = '';
        if (['BUY', 'SELL'].includes(activityType)) {
            quantity = (t.quantity !== undefined && t.quantity !== null && t.quantity !== '') ? Math.abs(t.quantity) : 0;
        } else if (activityType === 'DIVIDEND') {
            quantity = (t.quantity && t.quantity > 0) ? Math.abs(t.quantity) : 1;
        } else if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'INTEREST', 'FEE', 'TAX', 'CREDIT', 'ADJUSTMENT'].includes(activityType)) {
            quantity = (t.quantity && t.quantity > 0) ? Math.abs(t.quantity) : 1;
        } else if (activityType === 'SPLIT') {
            quantity = '';
        }

        // Unit Price
        let unitPrice = '';
        if (['BUY', 'SELL'].includes(activityType)) {
            unitPrice = (t.price !== undefined && t.price !== null && t.price !== '') ? Math.abs(t.price) : 0;
        } else if (activityType === 'DIVIDEND') {
            if (t.price && t.price > 0) {
                unitPrice = Math.abs(t.price);
            } else if (t.amount && quantity) {
                unitPrice = parseFloat((Math.abs(t.amount) / quantity).toFixed(4));
            } else {
                unitPrice = '';
            }
        } else if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'INTEREST', 'CREDIT'].includes(activityType)) {
            unitPrice = 1;
        }

        // Currency
        const currency = (t.assetCurrency || t.portfolioCurrency || defaultCurrency || 'EUR').toUpperCase();

        // Fee
        const fee = (t.commission && Math.abs(t.commission) > 0) ? Math.abs(t.commission) : 0;

        // Tax
        const tax = (t.tax && Math.abs(t.tax) > 0) ? Math.abs(t.tax) : 0;

        // Amount
        let amount = '';
        if (['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'INTEREST', 'FEE', 'TAX', 'CREDIT', 'ADJUSTMENT'].includes(activityType)) {
            amount = Math.abs(t.amount || (t.quantity * (t.price || 1)));
            if (!amount && t.price) amount = Math.abs(t.price);
            if (typeof amount === 'number') amount = parseFloat(amount.toFixed(2));
        } else if (activityType === 'DIVIDEND') {
            amount = Math.abs(t.amount || (quantity * (unitPrice || 0)));
            if (typeof amount === 'number') amount = parseFloat(amount.toFixed(2));
        } else if (activityType === 'SPLIT') {
            amount = t.amount || (t.quantity || 2);
        } else {
            // Wealthfolio standard leaves amount blank for BUY and SELL (derived from qty * price)
            amount = '';
        }

        // FX Rate
        let fxRate = '';
        if (t.exchangeRate && parseFloat(t.exchangeRate) > 0 && parseFloat(t.exchangeRate) !== 1) {
            fxRate = parseFloat(parseFloat(t.exchangeRate).toFixed(4));
        }

        // Subtype
        let subtype = '';
        if (activityType === 'DIVIDEND') {
            subtype = 'QUALIFIED';
        }

        return [
            date,
            symbol,
            instrumentType,
            quantity !== '' ? quantity : '',
            activityType,
            unitPrice !== '' ? unitPrice : '',
            currency,
            fee !== '' ? fee : '',
            tax !== '' ? tax : '',
            amount !== '' ? amount : '',
            fxRate,
            subtype
        ];
    });

    let csvContent = headers.join(',') + '\n';
    rows.forEach(row => {
        csvContent += row.map(val => {
            if (val === undefined || val === null) return '';
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }).join(',') + '\n';
    });

    return csvContent;
}

module.exports = {
    formatWealthfolioDate,
    mapToWealthfolioInstrumentType,
    mapToWealthfolioActivityType,
    generateWealthfolioCSV
};

