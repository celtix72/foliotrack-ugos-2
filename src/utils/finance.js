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

module.exports = { xirr, calculateTWR };
