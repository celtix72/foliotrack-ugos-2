'use strict';

/**
 * Calculates the Net Present Value (NPV) for a given rate and cash flows.
 * @param {number} rate - The discount rate.
 * @param {Array<{amount: number, date: Date}>} cashFlows - Array of cash flows.
 * @returns {number} The NPV.
 */
function npv(rate, cashFlows) {
    const firstDate = cashFlows[0].date;
    return cashFlows.reduce((acc, cf) => {
        const years = (cf.date - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
        return acc + cf.amount / Math.pow(1 + rate, years);
    }, 0);
}

/**
 * Calculates the derivative of NPV for a given rate and cash flows.
 * @param {number} rate - The discount rate.
 * @param {Array<{amount: number, date: Date}>} cashFlows - Array of cash flows.
 * @returns {number} The NPV derivative.
 */
function npvDeriv(rate, cashFlows) {
    const firstDate = cashFlows[0].date;
    return cashFlows.reduce((acc, cf) => {
        const years = (cf.date - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
        if (years === 0) return acc;
        return acc - years * cf.amount * Math.pow(1 + rate, -(years + 1));
    }, 0);
}

/**
 * Calculates the Internal Rate of Return (XIRR) using Newton-Raphson with Bisection fallback.
 * @param {Array<{amount: number, date: Date}>} cashFlows - Array of cash flows.
 * @param {number} [guess=0.0] - Initial guess for the rate.
 * @returns {number|null} The XIRR as a decimal, or null if it fails to converge.
 */
function xirr(cashFlows, guess = 0.0) {
    if (cashFlows.length < 2) return 0;

    let rate = guess;
    const maxIterations = 200;
    const precision = 1e-8;

    // 1. Try Newton-Raphson
    let success = false;
    for (let i = 0; i < maxIterations; i++) {
        const val = npv(rate, cashFlows);
        const deriv = npvDeriv(rate, cashFlows);

        if (Math.abs(deriv) < 1e-10) break;

        const nextRate = rate - val / deriv;
        if (Math.abs(nextRate - rate) < precision) {
            rate = nextRate;
            success = true;
            break;
        }
        rate = nextRate;
        if (Math.abs(rate) > 100) break; 
    }

    if (success && isFinite(rate)) return rate;

    // 2. Fallback to Bisection
    let low = -0.999, high = 100.0;
    for (let i = 0; i < 100; i++) {
        rate = (low + high) / 2;
        const val = npv(rate, cashFlows);
        if (Math.abs(val) < precision) return rate;
        if (val > 0) low = rate;
        else high = rate;
    }

    return isFinite(rate) ? rate : 0;
}

/**
 * Calculates the Time-Weighted Return (TWR) for a period.
 * @param {Array<{startingValue: number, endingValue: number, netCashFlow: number}>} subPeriods
 * @returns {number} Cumulative TWR as a decimal.
 */
function calculateTWR(subPeriods) {
    let result = 1;
    for (const period of subPeriods) {
        const denom = period.startingValue;
        // GIPS recommendation: If denom is 0, HPR is 0.
        // Also avoid very small denominators that cause extreme ratios.
        if (denom > 0.01) {
            const hpr = (period.endingValue - period.netCashFlow - period.startingValue) / denom;
            // Floor at -100% loss for the period
            result *= Math.max(0, 1 + hpr);
        }
    }
    // Final sanity check: TWR cannot result in a value less than -100%
    return Math.max(-1.0, result - 1);
}

/**
 * Checks if an asset is a bond (BTP, government/corporate bond, etc.)
 * @param {object} assetMeta
 * @returns {boolean}
 */
function isBondAsset(assetMeta) {
    if (!assetMeta) return false;
    const type = (assetMeta.type || assetMeta.quoteType || '').toLowerCase();
    const ticker = (assetMeta.ticker || '').toUpperCase();
    const isin = (assetMeta.isin || '').toUpperCase();
    const source = (assetMeta.dataSource || '').toUpperCase();

    if (type.includes('bond') || type.includes('obblig') || type === 'btp') return true;
    if (ticker.startsWith('BTP') || ticker.startsWith('BOT') || ticker.startsWith('CCT') || ticker.startsWith('CTZ')) return true;
    if (source === 'B_ITA' && (isin.startsWith('IT') || isin.startsWith('XS'))) return true;
    if (ticker.startsWith('ROM') || ticker.startsWith('IT000') || ticker.startsWith('XS')) return true;
    return false;
}

/**
 * Checks if a candidate price is valid and consistent.
 * @param {number|string} price - Candidate price
 * @param {object} [assetMeta=null] - Asset metadata (type, ticker, isin, dataSource)
 * @param {number} [lastValidPrice=null] - Previous known valid price for relative anomaly checks
 * @returns {{ valid: boolean, reason?: string }}
 */
function isValidQuotePrice(price, assetMeta = null, lastValidPrice = null) {
    if (price === null || price === undefined) return { valid: false, reason: 'price_null_or_undefined' };
    const p = typeof price === 'number' ? price : parseFloat(price);
    if (isNaN(p) || !isFinite(p)) return { valid: false, reason: 'price_nan_or_infinite' };
    if (p <= 0.0001) return { valid: false, reason: 'price_zero_or_negative' };

    const isBond = isBondAsset(assetMeta);

    // Bond price sanity checks:
    // Bonds are quoted in % of nominal par (usually around 100).
    // Values < 20 (like 0.81, 0.83, 2.50) are coupons or rates, NOT quotes.
    if (isBond) {
        if (p < 20.0) {
            return { valid: false, reason: `bond_price_too_low_${p}_likely_coupon_or_rate` };
        }
        if (p > 300.0) {
            return { valid: false, reason: `bond_price_too_high_${p}` };
        }
        if (lastValidPrice && lastValidPrice >= 20.0) {
            const ratio = p / lastValidPrice;
            if (ratio < 0.6 || ratio > 1.4) {
                return { valid: false, reason: `bond_price_unrealistic_variation_${lastValidPrice}_to_${p}` };
            }
        }
        return { valid: true };
    }

    // General asset (Stocks, ETFs, Crypto, etc.) checks against last known price:
    if (lastValidPrice && lastValidPrice > 0.0001) {
        // If lastValidPrice is <= 1.05 and candidate price is > 1.05,
        // it indicates recovery from a dummy/corrupted placeholder price (e.g. 1.00 € default),
        // NOT a genuine 500% spike. Allow recovery.
        const isLikelyDummyBaseline = lastValidPrice <= 1.05 && p > 1.05;
        if (!isLikelyDummyBaseline) {
            const ratio = p / lastValidPrice;
            // Sudden crash of > 75% without split
            if (ratio < 0.25) {
                return { valid: false, reason: `extreme_price_drop_${lastValidPrice}_to_${p}` };
            }
            // Sudden spike of > 500%
            if (ratio > 5.0) {
                return { valid: false, reason: `extreme_price_spike_${lastValidPrice}_to_${p}` };
            }
        }
    }

    return { valid: true };
}

/**
 * Sanitizes candidate price, ensuring we always keep the last valid price
 * if the candidate is 0 or inconsistent.
 * @param {number|string} candidatePrice
 * @param {object} [assetMeta=null]
 * @param {number} [fallbackPrice=null]
 * @returns {number}
 */
function sanitizeQuotePrice(candidatePrice, assetMeta = null, fallbackPrice = null) {
    const check = isValidQuotePrice(candidatePrice, assetMeta, fallbackPrice);
    if (check.valid) {
        return typeof candidatePrice === 'number' ? candidatePrice : parseFloat(candidatePrice);
    }
    if (fallbackPrice !== null && fallbackPrice !== undefined) {
        const fallbackCheck = isValidQuotePrice(fallbackPrice, assetMeta, null);
        if (fallbackCheck.valid) {
            return typeof fallbackPrice === 'number' ? fallbackPrice : parseFloat(fallbackPrice);
        }
    }
    if (isBondAsset(assetMeta)) {
        return 100.0;
    }
    return 0;
}

module.exports = { xirr, calculateTWR, isBondAsset, isValidQuotePrice, sanitizeQuotePrice };
