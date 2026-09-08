const express = require('express');
const aiService = require('../services/aiService');
const { aiLogger } = require('../utils/logger');

// Stato in memoria delle analisi IA in corso per ogni utente
const aiJobStatus = {};

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        requirePortfolioAccess,
        database,
        logger,
        yahooFinance,
        getEurUsdRate,
        calculatePerformanceHistory,
        getPortfolioDetails,
        getAllPortfolioStats,
        calculateROI,
        calculateTWR,
        xirr,
        getPerformanceResultsCache,
        setPerformanceResultsCache,
        ANALYTICS_CACHE_TTL
    } = dependencies;

    // Core function to recalculate and refresh dividend projections in the database
    async function refreshDividendProjections(userId) {
        if (!userId) return 0;
        try {
            const now = new Date();
            const currentYear = now.getFullYear();
            const lastYear = currentYear - 1;
            const liveRate = await getEurUsdRate();
            const BOND_TYPES = [
                'Bond', 'ETF Obblig', 'Deposito Vincolato', 'ETF Monetario',
                'Obbligazione', 'Obbligazioni', 'Titolo di Stato', 'Titoli di Stato',
                'BTP', 'BOT', 'CCT', 'CTZ', 'Government Bond', 'Fixed Income'
            ];

            const monthCodes = {
                GE: 1, GEN: 1, FB: 2, FEB: 2, MZ: 3, MAR: 3, MR: 3, AP: 4, APR: 4,
                MG: 5, MAG: 5, GI: 6, GIU: 6, LG: 7, LUG: 7, AG: 8, AGO: 8,
                ST: 9, SET: 9, SEP: 9, OT: 10, OTT: 10, OCT: 10, NV: 11, NOV: 11,
                DC: 12, DIC: 12, DEC: 12
            };

            function isBondAsset(pos) {
                const t = (pos.ticker || '').toUpperCase();
                const n = (pos.name || '').toUpperCase();
                const at = (pos.assetType || '').toLowerCase();
                
                if (BOND_TYPES.some(bt => bt.toLowerCase() === at)) return true;
                if (at.includes('obblig') || at.includes('bond') || at.includes('stato') || at.includes('titoli')) return true;
                if (t.startsWith('BTP') || t.startsWith('BOT') || t.startsWith('CCT') || t.startsWith('CTZ') || t.startsWith('CD_') || t.startsWith('BP_') || t === 'SCONOSCIUTO') return true;
                if (n.includes('BTP') || n.includes('BOT') || n.includes('CCT') || n.includes('CTZ') || n.includes('OBBLIG') || n.includes('BUONO') || n.includes('RENDISTATO')) return true;
                return false;
            }

            function matchesAsset(tx, pos) {
                const txTicker = (tx.ticker || '').trim().toUpperCase();
                const posTicker = (pos.ticker || '').trim().toUpperCase();
                if (txTicker && posTicker && txTicker === posTicker) return true;
                
                const txIsin = (tx.isin || '').trim().toUpperCase();
                const posIsin = (pos.isin || '').trim().toUpperCase();
                if (txIsin && posIsin && txIsin === posIsin) return true;
                if (posIsin && txTicker === posIsin) return true;
                if (txIsin && posTicker === txIsin) return true;
                return false;
            }

            // Get open positions (only assets currently held by this user)
            const openPositions = database.db.prepare(`
                SELECT * FROM (
                    SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                           SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance,
                           a.type as assetType,
                           a.currency as currency,
                           a.isin as isin,
                           a.currentPrice as currentPrice,
                           COALESCE(a.name, 'N/A') as name
                    FROM transactions t
                    JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                    LEFT JOIN assets a ON t.assetTicker = a.ticker OR t.assetTicker = a.isin
                    WHERE pu.user_id = ?
                    GROUP BY ticker
                )
                WHERE balance > 0.0001
            `).all(userId);

            const allDivTx = database.db.prepare(`
                SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                       a.isin as isin, a.name as assetName,
                       t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
                FROM transactions t 
                JOIN portfolios p ON t.portfolioId = p.id 
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                LEFT JOIN assets a ON t.assetTicker = a.ticker OR t.assetTicker = a.isin
                WHERE t.type = 'DIVIDEND' AND pu.user_id = ?
            `).all(userId);

            const toEUR = (amount, currency, exchangeRate) => {
                if (currency === 'USD' && liveRate > 0) return amount / liveRate;
                if (exchangeRate && exchangeRate !== 1) return amount / exchangeRate;
                return amount;
            };

            const taxRatesRaw = database.db.prepare(`SELECT asset_type, rate FROM tax_rates WHERE user_id = ?`).all(userId);
            const taxMap = Object.fromEntries(taxRatesRaw.map(tr => [tr.asset_type, tr.rate]));

            const balanceOnExDateQuery = database.db.prepare(`
                SELECT SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ? AND (UPPER(t.assetTicker) = UPPER(?) OR (length(?) > 0 AND UPPER(t.assetTicker) = UPPER(?))) AND t.date <= ?
            `);

            const newProjections = [];

            const projectionPromises = openPositions.map(async (pos) => {
                const ticker = pos.ticker;
                const isBond = isBondAsset(pos);
                
                if (isBond) {
                    const histDivs = allDivTx.filter(d => matchesAsset(d, pos)).sort((a, b) => new Date(b.date) - new Date(a.date));
                    const isBtp = (pos.ticker || '').toUpperCase().startsWith('BTP') || 
                                  (pos.name || '').toUpperCase().includes('BTP') ||
                                  (pos.assetType || '').toLowerCase().includes('btp') ||
                                  (pos.assetType || '').toLowerCase().includes('stato');
                    const isGovt = isBtp || (pos.ticker || '').toUpperCase().startsWith('BOT') || (pos.name || '').toUpperCase().includes('BOT');
                    let defaultTaxRate = isGovt ? 12.5 : (taxMap[pos.assetType] !== undefined ? taxMap[pos.assetType] : 26.0);

                    // Determine reference year: based on the last year (currentYear - 1).
                    // If no dividends in lastYear, take the most recent year with dividend data.
                    const histYears = Array.from(new Set(histDivs.map(d => parseInt(d.date.split('-')[0], 10)))).sort((a, b) => b - a);
                    const refYear = histYears.find(y => y === lastYear) || histYears.find(y => y < currentYear) || histYears[0] || lastYear;
                    const refYearDivs = histDivs.filter(d => parseInt(d.date.split('-')[0], 10) === refYear);
                    const sourceDivs = refYearDivs.length > 0 ? refYearDivs : histDivs;

                    // Collect coupon dates based on the reference year: map each coupon month (1..12) to the day ('01'..'31')
                    const monthSchedule = new Map();
                    sourceDivs.forEach(d => {
                        const parts = d.date.split('-');
                        if (parts.length >= 3) {
                            const m = parseInt(parts[1], 10);
                            const day = parts[2];
                            if (!monthSchedule.has(m)) {
                                monthSchedule.set(m, day);
                            }
                        }
                    });

                    // For BTPs or semi-annual bonds with only 1 known month, check older history or add 6-month paired coupon date
                    if (isBtp || (!pos.ticker.startsWith('CD_') && !pos.ticker.startsWith('BP_') && monthSchedule.size === 1)) {
                        for (const d of histDivs) {
                            const parts = d.date.split('-');
                            if (parts.length >= 3) {
                                const m = parseInt(parts[1], 10);
                                const day = parts[2];
                                for (const [knownM] of Array.from(monthSchedule.entries())) {
                                    const targetPair = ((knownM + 6 - 1) % 12 + 1);
                                    if (m === targetPair && !monthSchedule.has(targetPair)) {
                                        monthSchedule.set(targetPair, day);
                                    }
                                }
                            }
                        }
                        for (const [m, day] of Array.from(monthSchedule.entries())) {
                            const pairedM = ((m + 6 - 1) % 12 + 1);
                            if (!monthSchedule.has(pairedM)) {
                                monthSchedule.set(pairedM, day);
                            }
                        }
                    }

                    // If no history found, try to extract coupon dates and rate from name or ticker
                    const rateMatch = (pos.name + ' ' + pos.ticker).match(/(\d+[.,]?\d*)\s*%/);
                    const parsedAnnualRate = rateMatch ? parseFloat(rateMatch[1].replace(',', '.')) : 0;

                    if (monthSchedule.size === 0 && (isBtp || isBond)) {
                        const monthMatch = (pos.name + ' ' + pos.ticker).match(/(?:^|\s|-)(\d{1,2})?\s*(GE|GEN|FB|FEB|MZ|MAR|MR|AP|APR|MG|MAG|GI|GIU|LG|LUG|AG|AGO|ST|SET|SEP|OT|OTT|OCT|NV|NOV|DC|DIC|DEC)\s*(\d{2,4})?/i);
                        if (monthMatch) {
                            const day = monthMatch[1] ? parseInt(monthMatch[1], 10).toString().padStart(2, '0') : '15';
                            const mCode = monthMatch[2].toUpperCase();
                            const m = monthCodes[mCode];
                            if (m) {
                                monthSchedule.set(m, day);
                                if (isBtp || (!pos.ticker.startsWith('CD_') && !pos.ticker.startsWith('BP_'))) {
                                    const pairedM = ((m + 6 - 1) % 12 + 1);
                                    if (!monthSchedule.has(pairedM)) {
                                        monthSchedule.set(pairedM, day);
                                    }
                                }
                            }
                        }
                    }

                    const curMonthIdx = now.getMonth(); // 0-indexed
                    const todayStr = now.toISOString().split('T')[0];

                    const sortedMonths = Array.from(monthSchedule.keys()).sort((a, b) => a - b);
                    for (const schedM of sortedMonths) {
                        const day = monthSchedule.get(schedM);
                        const mStr = schedM.toString().padStart(2, '0');
                        const schedDate = `${currentYear}-${mStr}-${day}`;
                        const mIdx = schedM - 1;

                        // Check if already confirmed in currentYear
                        const alreadyConfirmed = allDivTx.some(tx => 
                            matchesAsset(tx, pos) && 
                            tx.date.startsWith(currentYear.toString()) && 
                            parseInt(tx.date.split('-')[1], 10) === schedM
                        );

                        if (alreadyConfirmed) continue;

                        // Projected if in future month, or current month (even if schedDate earlier in this month)
                        if (mIdx < curMonthIdx) continue;

                        const bObj = balanceOnExDateQuery.get(userId, pos.ticker, pos.isin || '', pos.isin || '', schedDate);
                        const balanceAtDate = (bObj && bObj.balance > 0.0001) ? bObj.balance : pos.balance;
                        if (balanceAtDate <= 0.0001) continue;

                        // Find reference historical dividend from reference year (prefer same month, else first in reference year, fallback to histDivs)
                        const refDiv = sourceDivs.find(d => parseInt(d.date.split('-')[1], 10) === schedM) 
                                    || sourceDivs[0] 
                                    || histDivs.find(d => parseInt(d.date.split('-')[1], 10) === schedM) 
                                    || histDivs[0];

                        let projGross = 0;
                        let projTax = 0;
                        let projNet = 0;
                        let unitAmount = 0;
                        let taxRate = defaultTaxRate;

                        if (refDiv) {
                            const rawHistNet = (refDiv.amount !== null && refDiv.amount !== undefined && refDiv.amount !== 0)
                                ? refDiv.amount
                                : (refDiv.quantity * refDiv.price - (refDiv.tax || 0));
                            const histNet = toEUR(rawHistNet, refDiv.portCurrency, refDiv.exchangeRate);
                            const histTax = toEUR(refDiv.tax || 0, refDiv.portCurrency, refDiv.exchangeRate);
                            const histGross = histNet + histTax;

                            // Find historical quantity when refDiv was paid
                            let histBal = 0;
                            if (refDiv.quantity > 1) {
                                histBal = refDiv.quantity;
                            } else {
                                const b = balanceOnExDateQuery.get(userId, pos.ticker, pos.isin || '', pos.isin || '', refDiv.date);
                                if (b && b.balance > 1) histBal = b.balance;
                            }

                            if (parsedAnnualRate > 0 && parsedAnnualRate <= 15) {
                                const semiAnnualRate = (parsedAnnualRate / 100) / 2;
                                projGross = balanceAtDate * semiAnnualRate;
                                if (histTax > 0 && histGross > 0) taxRate = (histTax / histGross) * 100;
                                projTax = projGross * (taxRate / 100);
                                projNet = projGross - projTax;
                                unitAmount = semiAnnualRate;
                            } else if (histBal > 1 && histGross > 0) {
                                const ratio = balanceAtDate / histBal;
                                const safeRatio = (ratio >= 0.01 && ratio <= 100) ? ratio : 1;
                                projGross = histGross * safeRatio;
                                if (histTax > 0) taxRate = (histTax / histGross) * 100;
                                projTax = projGross * (taxRate / 100);
                                projNet = projGross - projTax;
                                unitAmount = projGross / balanceAtDate;
                            } else {
                                projGross = histGross;
                                projTax = histTax > 0 ? histTax : projGross * (taxRate / 100);
                                projNet = projGross - projTax;
                                unitAmount = balanceAtDate > 0 ? projGross / balanceAtDate : 0;
                            }
                        } else if (parsedAnnualRate > 0) {
                            const semiAnnualRate = (parsedAnnualRate / 100) / 2;
                            projGross = balanceAtDate * semiAnnualRate;
                            projTax = projGross * (taxRate / 100);
                            projNet = projGross - projTax;
                            unitAmount = semiAnnualRate;
                        }

                        if (projGross > 0 || projNet > 0) {
                            const projDate = schedDate >= todayStr ? schedDate : todayStr;
                            const projMonthStr = projDate.substring(0, 7);
                            const alreadyProjected = newProjections.some(p => 
                                matchesAsset(p, pos) && p.date.substring(0, 7) === projMonthStr
                            );
                            if (!alreadyProjected) {
                                newProjections.push({
                                    ticker: pos.ticker,
                                    isin: pos.isin,
                                    name: pos.name,
                                    date: projDate,
                                    tag: 'STORICO',
                                    amount: unitAmount,
                                    totalAmount: projNet,
                                    gross: projGross,
                                    tax: projTax,
                                    yield: (pos.currentPrice > 0 && balanceAtDate > 0) ? ((projGross * (isBtp ? 2 : 1)) / (pos.currentPrice * balanceAtDate)) : 0
                                });
                            }
                        }
                    }
                } else if (ticker && !ticker.startsWith('CD_') && !ticker.startsWith('BP_') && ticker !== 'Sconosciuto') {
                    try {
                        const summary = await yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'calendarEvents', 'price'] }).catch(() => null);
                        
                        let annualRate = summary?.summaryDetail?.dividendRate || 0;
                        const assetYield = summary?.summaryDetail?.dividendYield || summary?.summaryDetail?.yield || 0;
                        const currencyYF = summary?.summaryDetail?.currency || pos.currency || 'EUR';
                        const currentPrice = summary?.price?.regularMarketPrice || pos.currentPrice || 0;

                        // If annualRate is 0 but yield is available and price > 0, calculate annualRate:
                        if (annualRate <= 0 && assetYield > 0 && currentPrice > 0) {
                            const yFraction = assetYield > 1 ? (assetYield / 100) : assetYield;
                            annualRate = currentPrice * yFraction;
                        }

                        const histDivs = allDivTx.filter(d => matchesAsset(d, pos)).sort((a, b) => new Date(b.date) - new Date(a.date));
                        let freq = summary?.summaryDetail?.dividendFrequency;
                        if (!freq) {
                            freq = histDivs.length > 0 ? Math.min(Math.max(histDivs.length, 1), 12) : 4;
                        }

                        let nextDateStr = null;
                        const ce = summary?.calendarEvents || {};
                        const dDate = ce.dividendDate || ce.exDividendDate;
                        if (dDate) {
                            nextDateStr = new Date(dDate).toISOString().split('T')[0];
                        }

                        let yfProjected = false;
                        const todayStr = now.toISOString().split('T')[0];
                        const curMonthIdx = now.getMonth();

                        let taxRate = taxMap[pos.assetType];
                        if (taxRate === undefined) taxRate = 26.0;

                        // 1. If Yahoo Finance has upcoming dividend date >= today:
                        if (annualRate > 0 && nextDateStr && nextDateStr >= todayStr) {
                            const yfMonthStr = nextDateStr.substring(0, 7);
                            const yfMonth = parseInt(nextDateStr.split('-')[1], 10);
                            const alreadyConfirmed = allDivTx.some(tx => 
                                matchesAsset(tx, pos) && 
                                parseInt(tx.date.split('-')[1], 10) === yfMonth && 
                                tx.date.startsWith(currentYear.toString())
                            );
                            if (!alreadyConfirmed) {
                                const bObj = balanceOnExDateQuery.get(userId, pos.ticker, pos.isin || '', pos.isin || '', nextDateStr);
                                const balanceOnExDate = (bObj && bObj.balance > 0.0001) ? bObj.balance : pos.balance;
                                if (balanceOnExDate > 0.0001) {
                                    const perPayment = (annualRate * balanceOnExDate) / freq;
                                    const amtGrossEUR = toEUR(perPayment, currencyYF, null);
                                    const unitAmount = toEUR(annualRate / freq, currencyYF, null);
                                    const taxEUR = amtGrossEUR * (taxRate / 100);
                                    const netEUR = amtGrossEUR - taxEUR;

                                    if (!newProjections.some(p => matchesAsset(p, pos) && p.date.substring(0, 7) === yfMonthStr)) {
                                        newProjections.push({
                                            ticker: pos.ticker,
                                            isin: pos.isin,
                                            name: pos.name,
                                            date: nextDateStr,
                                            tag: 'YF',
                                            amount: unitAmount,
                                            totalAmount: netEUR,
                                            gross: amtGrossEUR,
                                            tax: taxEUR,
                                            yield: assetYield
                                        });
                                    }
                                }
                            }
                        }

                        // 2. Also project any remaining historical payment months for the current year based on reference year (last year)
                        if (histDivs.length > 0) {
                            const histYears = Array.from(new Set(histDivs.map(d => parseInt(d.date.split('-')[0], 10)))).sort((a, b) => b - a);
                            const refYear = histYears.find(y => y === lastYear) || histYears.find(y => y < currentYear) || histYears[0] || lastYear;
                            const refYearDivs = histDivs.filter(d => parseInt(d.date.split('-')[0], 10) === refYear);
                            const sourceDivs = refYearDivs.length > 0 ? refYearDivs : histDivs;

                            const monthSchedule = new Map();
                            sourceDivs.forEach(d => {
                                const parts = d.date.split('-');
                                if (parts.length >= 3) {
                                    const m = parseInt(parts[1], 10);
                                    const day = parts[2];
                                    if (!monthSchedule.has(m)) {
                                        monthSchedule.set(m, day);
                                    }
                                }
                            });

                            const sortedMonths = Array.from(monthSchedule.keys()).sort((a, b) => a - b);
                            for (const schedM of sortedMonths) {
                                const day = monthSchedule.get(schedM);
                                const mStr = schedM.toString().padStart(2, '0');
                                const schedDate = `${currentYear}-${mStr}-${day}`;
                                const mIdx = schedM - 1;

                                const alreadyConfirmed = allDivTx.some(tx => 
                                    matchesAsset(tx, pos) && 
                                    tx.date.startsWith(currentYear.toString()) && 
                                    parseInt(tx.date.split('-')[1], 10) === schedM
                                );
                                if (alreadyConfirmed) continue;
                                if (mIdx < curMonthIdx) continue;

                                const projDate = schedDate >= todayStr ? schedDate : todayStr;
                                const projMonthStr = projDate.substring(0, 7);

                                // Check if this month is already projected (e.g. by YF above)
                                const alreadyProjected = newProjections.some(p => 
                                    matchesAsset(p, pos) && p.date.substring(0, 7) === projMonthStr
                                );
                                if (alreadyProjected) continue;

                                const bObj = balanceOnExDateQuery.get(userId, pos.ticker, pos.isin || '', pos.isin || '', schedDate);
                                const balanceOnExDate = (bObj && bObj.balance > 0.0001) ? bObj.balance : pos.balance;
                                if (balanceOnExDate <= 0.0001) continue;

                                let grossEUR = 0;
                                let taxEUR = 0;
                                let netEUR = 0;
                                let unitAmt = 0;

                                // PRIORITY 1: If Yahoo Finance has annualRate > 0, USE IT!
                                if (annualRate > 0) {
                                    const perPayment = (annualRate * balanceOnExDate) / freq;
                                    grossEUR = toEUR(perPayment, currencyYF, null);
                                    unitAmt = toEUR(annualRate / freq, currencyYF, null);
                                    taxEUR = grossEUR * (taxRate / 100);
                                    netEUR = grossEUR - taxEUR;
                                } else {
                                    // PRIORITY 2: Use historical dividend from the reference year
                                    const refDiv = sourceDivs.find(d => parseInt(d.date.split('-')[1], 10) === schedM) 
                                                || sourceDivs[0] 
                                                || histDivs.find(d => parseInt(d.date.split('-')[1], 10) === schedM) 
                                                || histDivs[0];
                                    const rawNet = (refDiv.amount !== null && refDiv.amount !== undefined && refDiv.amount !== 0)
                                        ? refDiv.amount
                                        : (refDiv.quantity * refDiv.price - (refDiv.tax || 0));
                                    const histNet = toEUR(rawNet, refDiv.portCurrency, refDiv.exchangeRate);
                                    const histTax = toEUR(refDiv.tax || 0, refDiv.portCurrency, refDiv.exchangeRate);
                                    const histGross = histNet + histTax;

                                    let histBal = 0;
                                    if (refDiv.quantity > 0) {
                                        histBal = refDiv.quantity;
                                    } else {
                                        const b = balanceOnExDateQuery.get(userId, pos.ticker, pos.isin || '', pos.isin || '', refDiv.date);
                                        if (b && b.balance > 0.0001) histBal = b.balance;
                                    }

                                    if (histBal > 0 && histGross > 0 && balanceOnExDate > 0) {
                                        const ratio = balanceOnExDate / histBal;
                                        if (ratio >= 0.1 && ratio <= 10) {
                                            grossEUR = histGross * ratio;
                                            taxEUR = histTax > 0 ? histTax * ratio : grossEUR * (taxRate / 100);
                                        } else {
                                            grossEUR = histGross;
                                            taxEUR = histTax > 0 ? histTax : grossEUR * (taxRate / 100);
                                        }
                                    } else {
                                        grossEUR = histGross;
                                        taxEUR = histTax > 0 ? histTax : grossEUR * (taxRate / 100);
                                    }

                                    netEUR = grossEUR - taxEUR;
                                    unitAmt = balanceOnExDate > 0 ? grossEUR / balanceOnExDate : 0;
                                }

                                if (grossEUR > 0 || netEUR > 0) {
                                    newProjections.push({
                                        ticker: pos.ticker,
                                        isin: pos.isin,
                                        name: pos.name,
                                        date: projDate,
                                        tag: 'SIMULATO',
                                        amount: unitAmt,
                                        totalAmount: netEUR,
                                        gross: grossEUR,
                                        tax: taxEUR,
                                        yield: assetYield || ((currentPrice > 0 && balanceOnExDate > 0) ? (grossEUR * (freq || 1) / (currentPrice * balanceOnExDate)) : 0)
                                    });
                                }
                            }
                        }
                    } catch(e) {
                        logger.error(`Error fetching YF/history projection for ${ticker}:`, e.message);
                    }
                }
            });

            await Promise.all(projectionPromises);

            const tx = database.db.transaction((projs) => {
                database.db.prepare(`DELETE FROM dividend_projections WHERE tag != 'MANUALE' AND year = ? AND user_id = ?`).run(currentYear, userId);
                const insert = database.db.prepare(`
                    INSERT INTO dividend_projections (user_id, ticker, name, exDate, amount, totalAmount, gross, tax, yield, tag, year)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                for (const p of projs) {
                    insert.run(userId, p.ticker, p.name, p.date, p.amount, p.totalAmount, p.gross || 0, p.tax || 0, p.yield, p.tag, currentYear);
                }
            });
            tx(newProjections);
            return newProjections.length;
        } catch (err) {
            logger.error('refreshDividendProjections error', err);
            throw err;
        }
    }

    router.refreshDividendProjections = refreshDividendProjections;

    function getAssetTypeColor(type) {
        const t = (type || 'Other').toUpperCase();
        if (t.includes('LIQUID') || t.includes('CASH')) return '#166534'; // Verde Scuro
        if (t.includes('DEPOSITO') || t.includes('CONTO')) return '#15803d'; // Verde Medio
        if (t.includes('MONETARIO')) return '#4ade80'; // Verde Chiaro
        if (t.includes('BOND') || t.includes('OBBLIG')) return '#eab308'; // Giallo
        if (t.includes('ETF AZION') || t.includes('ETF')) return '#f97316'; // Arancio
        if (t.includes('AZION') || t.includes('STOCK') || t.includes('EQUITY')) return '#ef4444'; // Rosso
        if (t.includes('CRYPTO') || t.includes('VALUTA')) return '#8b5cf6'; // Viola
        return '#94a3b8'; // Slate
    }

    // GET /api/performance
    router.get('/performance', requireAuth, async (req, res) => {
        try {
            const { range, benchmark, tagIds } = req.query;
            const tags = tagIds ? tagIds.split(',').map(Number) : null;
            const data = await calculatePerformanceHistory(null, range || '1Y', false, true, benchmark, req.user.id, tags);
            res.json(data);
        } catch (err) {
            console.error('API Error /api/performance:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/global-allocation
    router.get('/analytics/global-allocation', requireAuth, async (req, res) => {
        try {
            const { portfolioIds } = req.query;
            let pIdsToUse = (portfolioIds && portfolioIds.trim() !== '') ? portfolioIds.split(',').map(Number) : null;

            let portfolios;
            if (pIdsToUse && pIdsToUse.length > 0) {
                const placeholders = pIdsToUse.map(() => '?').join(',');
                portfolios = database.db.prepare(`
                    SELECT p.id FROM portfolios p
                    JOIN portfolio_users pu ON p.id = pu.portfolio_id
                    WHERE pu.user_id = ? AND p.id IN (${placeholders})
                `).all(req.user.id, ...pIdsToUse);
            } else {
                portfolios = database.db.prepare(`
                    SELECT p.id FROM portfolios p
                    JOIN portfolio_users pu ON p.id = pu.portfolio_id
                    WHERE pu.user_id = ? AND p.include_in_totals != 0
                `).all(req.user.id);
            }

            const liveRate = await getEurUsdRate();
            const typeMap = {};
            let totalGrossValue = 0;

            for (const { id } of portfolios) {
                const details = await getPortfolioDetails(id, liveRate);
                const holdings = details.holdings;
                for (const h of holdings) {
                    const tp = h.type || 'Other';
                    typeMap[tp] = (typeMap[tp] || 0) + h.currentValue;
                    totalGrossValue += h.currentValue;
                }
                if (details.currentCash > 0) {
                    typeMap['Liquidity'] = (typeMap['Liquidity'] || 0) + details.currentCash;
                    totalGrossValue += details.currentCash;
                }
            }

            const allocation = Object.entries(typeMap)
                .map(([type, value]) => ({
                    type,
                    value: Math.round(value * 100) / 100,
                    percent: totalGrossValue > 0 ? Math.round((value / totalGrossValue) * 1000) / 10 : 0,
                    color: getAssetTypeColor(type)
                })).sort((a, b) => b.value - a.value);

            res.json(allocation);
        } catch (err) {
            console.error('Global allocation error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/portfolio-performance/:id
    router.get('/analytics/portfolio-performance/:id', requireAuth, requirePortfolioAccess, async (req, res) => {
        try {
            const { range } = req.query;
            const portfolioId = req.params.id;
            const cacheKey = `portfolio_perf_${portfolioId}_${range || 'ALL'}`;
            const performanceResultsCache = getPerformanceResultsCache();

            if (performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < ANALYTICS_CACHE_TTL)) {
                return res.json(performanceResultsCache[cacheKey].data);
            }

            const dataPoints = await calculatePerformanceHistory([portfolioId], range);
            
            let changePercent = 0;
            if (dataPoints.length > 1) {
                const startVal = dataPoints[0].value;
                const endVal = dataPoints[dataPoints.length - 1].value;
                if (startVal > 0) changePercent = ((endVal - startVal) / startVal) * 100;
            }

            const result = { dataPoints, changePercent };
            setPerformanceResultsCache(cacheKey, { data: result, timestamp: Date.now() });
            res.json(result);
        } catch (err) {
            console.error('Portfolio performance error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/global-performance
    router.get('/analytics/global-performance', requireAuth, async (req, res) => {
        try {
            const { range, benchmark, tagIds, portfolioIds } = req.query;
            const tags = tagIds ? tagIds.split(',').map(Number) : null;
            let pIdsToUse = portfolioIds ? portfolioIds.split(',').map(Number).filter(n => !isNaN(n)) : null;
            const cacheKey = `global_perf_${req.user.id}_${range || 'ALL'}_${benchmark || 'none'}_${portfolioIds || 'all'}_${tagIds || 'all'}`;
            const performanceResultsCache = getPerformanceResultsCache();

            if (performanceResultsCache[cacheKey] && (Date.now() - performanceResultsCache[cacheKey].timestamp < ANALYTICS_CACHE_TTL)) {
                return res.json(performanceResultsCache[cacheKey].data);
            }

            const userPortfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
            `).all(req.user.id);
            const userPIds = userPortfolios.map(p => p.id);

            if (pIdsToUse) {
                pIdsToUse = pIdsToUse.filter(id => userPIds.includes(id));
            } else {
                pIdsToUse = userPIds;
            }

            if (pIdsToUse.length === 0) {
                return res.json({ dataPoints: [], changePercent: 0 });
            }

            const dataPoints = await calculatePerformanceHistory(pIdsToUse, range, false, false, benchmark, req.user.id, tags, true);

            let changePercent = 0;
            if (dataPoints.length > 1) {
                const startVal = dataPoints[0].value;
                const endVal = dataPoints[dataPoints.length - 1].value;
                if (startVal > 0) changePercent = ((endVal - startVal) / startVal) * 100;
            }

            const result = { dataPoints, changePercent };
            setPerformanceResultsCache(cacheKey, { data: result, timestamp: Date.now() });
            res.json(result);
        } catch (err) {
            console.error('Global performance error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/daily-gains
    router.get('/analytics/daily-gains', requireAuth, async (req, res) => {
        try {
            const { portfolioIds } = req.query;
            let pIds = portfolioIds ? portfolioIds.split(',').map(Number).filter(n => !isNaN(n)) : null;

            const userPortfolios = database.db.prepare(`
                SELECT p.id FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
            `).all(req.user.id);
            const userPIds = userPortfolios.map(p => p.id);

            if (pIds) {
                pIds = pIds.filter(id => userPIds.includes(id));
            } else {
                pIds = userPIds;
            }

            if (pIds.length === 0) return res.json({ days: [] });

            const todayStr = new Date().toISOString().split('T')[0];

            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 15);
            const cutoffStr = cutoff.toISOString().split('T')[0];

            const placeholders = pIds.map(() => '?').join(',');
            const rows = database.db.prepare(`
                SELECT date,
                       SUM(totalValue)   AS totalValue,
                       SUM(netDeposits)  AS netDeposits
                FROM portfolio_history
                WHERE portfolioId IN (${placeholders})
                  AND date >= ?
                  AND date < ?
                GROUP BY date
                ORDER BY date ASC
            `).all(...pIds, cutoffStr, todayStr);

            const days = [];
            for (let i = 1; i < rows.length; i++) {
                const prev = rows[i - 1];
                const curr = rows[i];
                const depositsDelta = (curr.netDeposits || 0) - (prev.netDeposits || 0);
                const gain = (curr.totalValue || 0) - (prev.totalValue || 0) - depositsDelta;
                days.push({ date: curr.date, gain: Math.round(gain * 100) / 100 });
            }

            const liveRows = database.db.prepare(`
                SELECT performance1D, performance1DPrePost, currency
                FROM portfolios
                WHERE id IN (${placeholders})
            `).all(...pIds);

            const liveGain = liveRows.reduce((sum, p) => sum + (p.performance1D || 0), 0);

            if (liveRows.length > 0) {
                days.push({ date: todayStr, gain: Math.round(liveGain * 100) / 100 });
            } else if (rows.length >= 2) {
                const last = rows[rows.length - 1];
                const prev = rows[rows.length - 2];
                const depositsDelta = (last.netDeposits || 0) - (prev.netDeposits || 0);
                const gain = (last.totalValue || 0) - (prev.totalValue || 0) - depositsDelta;
                days.push({ date: last.date, gain: Math.round(gain * 100) / 100 });
            }

            const validDays = days.filter(d => {
                const dateObj = new Date(d.date);
                const dayOfWeek = dateObj.getDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                // Exclude weekends, and exclude exactly 0 gain days (which are likely holidays)
                // We keep 0 gain if it's the current live day which just hasn't moved yet.
                const isHoliday = !isWeekend && d.gain === 0 && d.date !== todayStr;
                return !isWeekend && !isHoliday;
            });

            res.json({ days: validDays.slice(-7) });
        } catch (err) {
            logger.error('Daily gains error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/history
    router.get('/analytics/history', requireAuth, (req, res) => {
        try {
            const portfolios = database.db.prepare(`
                SELECT p.id, p.name, p.currency FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
            `).all(req.user.id);
            let allClosed = [];

            for (const p of portfolios) {
                const trans = database.db.prepare('SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC').all(p.id);
                const assets = database.db.prepare('SELECT * FROM assets').all();
                const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

                let holdingsMap = {}; 
                let closed = [];

                for (const t of trans) {
                    const year = t.date.split('-')[0];
                    const asset = assetMap[t.assetTicker] || { name: t.assetTicker || 'Liquidità' };

                    if (t.type === 'BUY' && t.assetTicker) {
                        if (!holdingsMap[t.assetTicker]) holdingsMap[t.assetTicker] = { shares: 0, costBasis: 0 };
                        const fx = t.exchangeRate || 1;
                        const totalCost = t.amount ? Math.abs(t.amount) : (t.quantity * t.price + t.commission + t.tax) / fx;
                        holdingsMap[t.assetTicker].shares += t.quantity;
                        holdingsMap[t.assetTicker].costBasis += totalCost;

                    } else if (t.type === 'SELL' && t.assetTicker) {
                        const sellQty = t.quantity;
                        const h = holdingsMap[t.assetTicker] || { shares: 0, costBasis: 0 };
                        const pmc = h.shares > 0 ? h.costBasis / h.shares : 0;
                        const sellCostBasis = sellQty * pmc;
                        const fx = t.exchangeRate || 1;
                        const proceeds = t.amount ? Math.abs(t.amount) : (t.quantity * t.price - t.commission - t.tax) / fx;
                        const gain = proceeds - sellCostBasis;
                        const gainPct = sellCostBasis > 0 ? ((gain / sellCostBasis) * 100).toFixed(2) : 0;

                        closed.push({
                            id: t.id,
                            ticker: t.assetTicker,
                            name: asset.name,
                            type: t.type,
                            assetType: asset.type || 'Stock',
                            year,
                            quantity: sellQty,
                            pmc: Math.round(pmc * 100) / 100,
                            sellPrice: Math.round((t.price / (t.exchangeRate || 1)) * 100) / 100,
                            totalProceeds: Math.round(proceeds * 100) / 100,
                            totalCostBasis: Math.round(sellCostBasis * 100) / 100,
                            realizedGain: Math.round(gain * 100) / 100,
                            gainPct,
                            portfolioName: p.name,
                            date: t.date
                        });

                        if (holdingsMap[t.assetTicker]) {
                            holdingsMap[t.assetTicker].shares -= sellQty;
                            holdingsMap[t.assetTicker].costBasis -= sellCostBasis;
                            if (holdingsMap[t.assetTicker].shares <= 0.0001) delete holdingsMap[t.assetTicker];
                        }
                    } else if (['DEPOSIT', 'WITHDRAWAL', 'TAX', 'TRANSFER'].includes(t.type)) {
                        closed.push({
                            id: t.id,
                            ticker: t.assetTicker || 'CASH',
                            name: t.type === 'TAX' ? 'Tasse' : (t.type === 'TRANSFER' ? 'Trasferimento' : 'Movimento Cassa'),
                            type: t.type,
                            assetType: 'Cash',
                            year,
                            quantity: 0,
                            pmc: 0,
                            totalProceeds: Math.abs(t.amount),
                            totalCostBasis: 0,
                            realizedGain: 0,
                            gainPct: 0,
                            portfolioName: p.name,
                            date: t.date
                        });
                    }
                }
                allClosed = allClosed.concat(closed);
            }

            allClosed.sort((a, b) => new Date(b.date) - new Date(a.date));
            res.json(allClosed);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/dividends
    router.get('/analytics/dividends', requireAuth, async (req, res) => {
        try {
            const liveRate = await getEurUsdRate();
            const toEUR = (amount, currency, exchangeRate) => {
                if (currency === 'USD' && liveRate > 0) return amount / liveRate;
                if (exchangeRate && exchangeRate !== 1) return amount / exchangeRate;
                return amount;
            };

            const portfolios = database.db.prepare(`
                SELECT p.id, p.name, p.currency FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
            `).all(req.user.id);
            let allDividends = [];

            for (const p of portfolios) {
                const divs = database.db.prepare(`
                    SELECT t.*, a.name, a.isin, a.type as assetType
                    FROM transactions t
                    LEFT JOIN assets a ON t.assetTicker = a.ticker
                    WHERE t.portfolioId = ? AND t.type = 'DIVIDEND'
                    ORDER BY t.date DESC
                `).all(p.id);
                allDividends = allDividends.concat(divs.map(d => {
                    const rawNet = (d.amount !== null && d.amount !== undefined && d.amount !== 0)
                        ? d.amount 
                        : (d.quantity * d.price - (d.tax || 0));
                    const netEUR = toEUR(rawNet, p.currency, d.exchangeRate);
                    const taxEUR = toEUR(d.tax || 0, p.currency, d.exchangeRate);
                    const grossEUR = netEUR + taxEUR;

                    return {
                        id:          d.id,
                        assetTicker: d.assetTicker,
                        name:        d.name,
                        isin:        d.isin,
                        assetType:   d.assetType,
                        date:        d.date,
                        amount:      netEUR,          // Netto in EUR
                        tax:         taxEUR,          // Tassazione in EUR
                        gross:       grossEUR,        // Lordo calcolato in EUR
                        portfolioId: d.portfolioId,
                        portfolioName: p.name
                    };
                }));
            }
            allDividends.sort((a, b) => new Date(b.date) - new Date(a.date));
            res.json(allDividends);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    async function calculateDividendProjections(userId) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const liveRate = await getEurUsdRate();

        const openPositions = database.db.prepare(`
            SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                   a.name as name, a.isin as isin, a.type as assetType,
                   a.currentPrice,
                   a.currency as assetCurrency,
                   SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance
            FROM transactions t 
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            LEFT JOIN assets a ON t.assetTicker = a.ticker OR t.assetTicker = a.isin
            WHERE pu.user_id = ?
            GROUP BY ticker HAVING balance > 0.0001
        `).all(userId);

        const allDivTx = database.db.prepare(`
            SELECT t.id as txId,
                   COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                   a.isin as isin,
                   t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
            FROM transactions t 
            JOIN portfolios p ON t.portfolioId = p.id 
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            LEFT JOIN assets a ON t.assetTicker = a.ticker OR t.assetTicker = a.isin
            WHERE t.type = 'DIVIDEND' AND t.date LIKE ? AND pu.user_id = ?
        `).all(currentYear + '-%', userId);

        let savedProjections = database.db.prepare(`SELECT * FROM dividend_projections WHERE year = ? AND user_id = ?`).all(currentYear, userId);
        
        // Clean up duplicate non-manual projections from DB and in-memory list if any exist
        if (savedProjections.length > 0) {
            savedProjections.sort((a, b) => new Date(b.exDate) - new Date(a.exDate));
            const seenKeys = new Set();
            const duplicateIds = [];
            const filteredProjections = [];

            for (const p of savedProjections) {
                if (p.tag === 'MANUALE') {
                    filteredProjections.push(p);
                    continue;
                }
                const asset = openPositions.find(op => op.ticker === p.ticker || (op.isin && op.isin === p.ticker));
                const assetKey = ((asset && (asset.isin || asset.ticker)) || p.ticker).trim().toUpperCase();
                const key = `${assetKey}_${p.exDate.substring(0, 7)}`;
                if (seenKeys.has(key)) {
                    duplicateIds.push(p.id);
                } else {
                    seenKeys.add(key);
                    filteredProjections.push(p);
                }
            }

            if (duplicateIds.length > 0) {
                try {
                    const deleteStmt = database.db.prepare(`DELETE FROM dividend_projections WHERE id = ?`);
                    for (const id of duplicateIds) {
                        deleteStmt.run(id);
                    }
                } catch (e) {
                    logger.error('Error cleaning duplicate projections:', e.message);
                }
                savedProjections = filteredProjections;
            }
        }
        const taxRatesRaw = database.db.prepare(`SELECT asset_type, rate FROM tax_rates WHERE user_id = ?`).all(userId);
        const taxMap = Object.fromEntries(taxRatesRaw.map(tr => [tr.asset_type, tr.rate]));

        const listItems = [];
        const actualByMonth = Array(12).fill(0);
        const projectedByMonth = Array(12).fill(0);
        const tickersByMonth = Array.from({length: 12}, () => new Set());
        let totalExpected = 0;
        let totalReceived = 0;

        const toEUR = (amount, currency, exchangeRate) => {
            if (currency === 'USD' && liveRate > 0) return amount / liveRate;
            if (exchangeRate && exchangeRate !== 1) return amount / exchangeRate;
            return amount;
        };

        allDivTx.forEach(d => {
            const pos = openPositions.find(p => p.ticker === d.ticker || (p.isin && (p.isin === d.ticker || p.isin === d.isin)));
            let assetName = pos ? pos.name : null;
            let assetIsin = pos ? pos.isin : d.isin;
            let assetType = pos ? pos.assetType : null;
            
            if (!assetName || !assetType) {
                const a = database.db.prepare(`SELECT name, isin, type FROM assets WHERE ticker = ? OR isin = ?`).get(d.ticker, d.ticker);
                if (a) {
                    assetName = assetName || a.name;
                    assetIsin = assetIsin || a.isin;
                    assetType = assetType || a.type;
                }
            }
            if (!assetName) assetName = d.ticker;
            if (!assetType) assetType = 'Azioni';

            const m = parseInt(d.date.split('-')[1]) - 1;
            const rawNet = (d.amount !== null && d.amount !== undefined && d.amount !== 0)
                ? d.amount 
                : (d.quantity * d.price - (d.tax || 0));
            const amtEUR = toEUR(rawNet, d.portCurrency, d.exchangeRate);
            if (m >= 0 && m < 12) {
                actualByMonth[m] += amtEUR;
                tickersByMonth[m].add(d.ticker);
            }
            totalReceived += amtEUR;
            
            const taxEUR = toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
            const gross = amtEUR + taxEUR;
            
            let realYield = 0;
            if (pos && pos.currentPrice > 0 && pos.balance > 0) {
                const priceInEUR = (pos.assetCurrency === 'USD' && liveRate > 0) ? pos.currentPrice / liveRate : pos.currentPrice;
                const positionValueEUR = pos.balance * priceInEUR;
                if (positionValueEUR > 0) {
                    realYield = gross / positionValueEUR;
                }
            }

            listItems.push({
                id: null, txId: d.txId, ticker: d.ticker, name: assetName, isin: assetIsin, assetType, date: d.date, tag: 'REGISTRATO',
                amount: null, totalAmount: amtEUR, gross, tax: taxEUR, annualProjected: 0, yield: 0, realYield
            });
        });

        savedProjections.forEach(p => {
            const m = parseInt(p.exDate.split('-')[1]) - 1;
            
            let grossEUR = p.gross;
            let taxEUR = p.tax;
            let netEUR = p.totalAmount;

            if (grossEUR === 0 && netEUR > 0 && p.tag !== 'STORICO' && p.tag !== 'SIMULATO') {
                grossEUR = p.totalAmount;
                const asset = openPositions.find(op => op.ticker === p.ticker || (op.isin && op.isin === p.ticker));
                const isGovt = (p.ticker || '').toUpperCase().startsWith('BTP') ||
                               (p.name || '').toUpperCase().includes('BTP') ||
                               (p.ticker || '').toUpperCase().startsWith('BOT') ||
                               (asset && asset.assetType && asset.assetType.toLowerCase().includes('stato'));
                let taxRate = isGovt ? 12.5 : taxMap[asset ? asset.assetType : 'Azioni'];
                if (taxRate === undefined) taxRate = 26.0;
                taxEUR = grossEUR * (taxRate / 100);
                netEUR = grossEUR - taxEUR;
            }

            if (p.tag === 'MANUALE') {
                if (p.tax !== undefined && p.tax > 0) {
                    taxEUR = p.tax;
                    grossEUR = p.gross > 0 ? p.gross : p.totalAmount + p.tax;
                    netEUR = p.totalAmount;
                }
            }

            projectedByMonth[m] += netEUR;
            totalExpected += netEUR;
            tickersByMonth[m].add(p.ticker);
            const asset = openPositions.find(op => op.ticker === p.ticker || (op.isin && op.isin === p.ticker));
            listItems.push({
                id: p.id, ticker: p.ticker, name: p.name, isin: asset ? asset.isin : null, assetType: asset ? asset.assetType : null, date: p.exDate, tag: p.tag,
                amount: p.amount, 
                totalAmount: netEUR, 
                gross: grossEUR, 
                tax: taxEUR, 
                annualProjected: 0, yield: p.yield, isCustom: p.isCustom
            });
        });

        const distinctTickers = [...new Set(listItems.map(l => l.ticker))];
        for (const t of distinctTickers) {
            const tot = listItems.filter(l => l.ticker === t).reduce((sum, l) => sum + l.totalAmount, 0);
            listItems.filter(l => l.ticker === t).forEach(l => l.annualProjected = tot);
        }

        const months = [];
        const MONTH_NAMES = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
        for (let i = 0; i < 12; i++) {
            months.push({
                month: i + 1, name: MONTH_NAMES[i], actual: actualByMonth[i], projected: projectedByMonth[i],
                display: projectedByMonth[i], tickers: Array.from(tickersByMonth[i])
            });
        }

        return {
            year: currentYear,
            totalExpected: totalReceived + totalExpected,
            totalReceived,
            totalRemaining: totalExpected,
            months,
            assets: listItems.sort((a,b) => new Date(b.date) - new Date(a.date)),
            openTickers: openPositions.map(p => ({ ticker: p.ticker, name: p.name }))
        };
    }

    // GET /api/analytics/dividend-projections
    router.get('/analytics/dividend-projections', requireAuth, async (req, res) => {
        try {
            const data = await calculateDividendProjections(req.user.id);
            res.json(data);
        } catch (err) {
            logger.error('Dividend projections error', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/current-month-dividends
    router.get('/analytics/current-month-dividends', requireAuth, async (req, res) => {
        try {
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth() + 1;
            const monthStr = currentMonth.toString().padStart(2, '0');
            const yearMonth = `${currentYear}-${monthStr}`;



            const projList = database.db.prepare(`
                SELECT ticker, totalAmount as amount, exDate as paymentDate, exDate, 'PROJECTION' as type
                FROM dividend_projections
                WHERE user_id = ? AND exDate LIKE ?
                ORDER BY exDate ASC
            `).all(req.user.id, yearMonth + '%');

            const recList = database.db.prepare(`
                SELECT t.assetTicker as ticker, t.amount, t.date as paymentDate, t.date as exDate, 'RECEIVED' as type
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ? AND t.type = 'DIVIDEND' AND t.date LIKE ?
                ORDER BY t.date ASC
            `).all(req.user.id, yearMonth + '%');
            
            const dividendList = [...projList, ...recList].sort((a, b) => new Date(a.exDate || a.paymentDate) - new Date(b.exDate || b.paymentDate));

            const totalAmount = dividendList.reduce((sum, d) => sum + (d.amount || 0), 0);
            const totalCount = dividendList.length;

            const todayStr = now.toISOString().split('T')[0];
            const exDateTodayAssets = database.db.prepare(`
                SELECT ticker, totalAmount 
                FROM dividend_projections 
                WHERE user_id = ? AND exDate = ?
            `).all(req.user.id, todayStr);
            const todayCount = exDateTodayAssets.length;

            const MONTH_NAMES_LONG = [
                'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
                'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
            ];

            res.json({
                monthName: MONTH_NAMES_LONG[currentMonth - 1],
                year: currentYear,
                count: totalCount,
                amount: totalAmount,
                hasDividends: totalCount > 0,
                isExDateToday: todayCount > 0,
                todayCount: todayCount,
                todayAssets: exDateTodayAssets,
                dividendList: dividendList
            });
        } catch (err) {
            logger.error('Current month dividends error', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/earnings-alerts
    router.get('/analytics/earnings-alerts', requireAuth, async (req, res) => {
        try {
            const userId = req.user.id;
            const alerts = database.db.prepare(`
                SELECT ea.*, a.name as assetName, a.currency
                FROM earnings_alerts ea
                JOIN assets a ON ea.ticker = a.ticker
                LEFT JOIN (
                    SELECT assetTicker, SUM(CASE WHEN type = 'BUY' THEN quantity WHEN type = 'SELL' THEN -quantity ELSE 0 END) as balance
                    FROM transactions t
                    JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                    WHERE pu.user_id = ?
                    GROUP BY assetTicker
                ) t ON a.ticker = t.assetTicker
                WHERE ea.is_read = 0 
                  AND (a.inWatchlist = 1 OR IFNULL(t.balance, 0) > 0.0001)
                ORDER BY ea.released_date DESC, ea.id DESC
            `).all(userId);
            
            res.json(alerts);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/analytics/earnings-alerts/:id/read
    router.post('/analytics/earnings-alerts/:id/read', requireAuth, async (req, res) => {
        try {
            database.db.prepare(`
                UPDATE earnings_alerts SET is_read = 1 WHERE id = ?
            `).run(req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/reports
    router.get('/analytics/reports', requireAuth, async (req, res) => {
        try {
            const { range = '1Y', portfolioIds, assetType = 'all' } = req.query;
            const hasAssetTypeFilter = assetType && assetType !== 'all';

            const matchAssetType = (aType, ticker, filter) => {
                if (!filter || filter === 'all' || filter === 'tutti') return true;
                const t = (aType || '').toLowerCase().trim();
                const tick = (ticker || '').toUpperCase().trim();
                const f = filter.toLowerCase().trim();
                if (f === 'azioni' || f === 'stock' || f === 'azione' || f === 'equity') {
                    return (t === 'azioni' || t === 'stock' || t === 'azione' || t === 'equity' || t.includes('azion')) && !t.includes('etf');
                }
                if (f === 'etf_az' || f === 'etf azionari' || f === 'etf azionario') {
                    return t.includes('etf') && !t.includes('monet') && !t.includes('obblig') && !t.includes('bond');
                }
                if (f === 'etf_mon' || f === 'etf monetario' || f === 'etf monetari') {
                    return t.includes('monet') || ['XEON.DE', 'C3M.PA', 'SMART.MI'].includes(tick);
                }
                if (f === 'obbl' || f === 'obbligazionario' || f === 'obbligazioni' || f === 'bond') {
                    return t.includes('obblig') || t.includes('bond') || t.includes('btp') || tick.startsWith('IT000') || tick.startsWith('ROM');
                }
                if (f === 'liquidity' || f === 'liquidità' || f === 'liquidita' || f === 'depositi vincolati') {
                    return t.includes('liquid') || t.includes('deposito') || t.includes('conto') || t.includes('buono') || tick.startsWith('CD_') || tick.startsWith('BP_') || tick === 'CASH';
                }
                return t.includes(f);
            };
            const selectedPIds = (portfolioIds && portfolioIds.trim() !== '')
                ? portfolioIds.split(',').map(Number).filter(n => !isNaN(n))
                : null;

            let portfolioFilter = '';
            let params = [req.user.id];
            if (selectedPIds && selectedPIds.length > 0) {
                const placeholders = selectedPIds.map(() => '?').join(',');
                portfolioFilter = ` AND p.id IN (${placeholders})`;
                params = [...params, ...selectedPIds];
            }

            let portfolios = database.db.prepare(`
                SELECT p.* FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ? ${portfolioFilter}
            `).all(...params);

            if (portfolios.length === 0 && selectedPIds && selectedPIds.length > 0) {
                portfolios = database.db.prepare(`
                    SELECT p.* FROM portfolios p
                    JOIN portfolio_users pu ON p.id = pu.portfolio_id
                    WHERE pu.user_id = ?
                `).all(req.user.id);
            }
            if (portfolios.length === 0) return res.json({ error: 'No portfolios found' });

            const pIdsForQuery = portfolios.map(p => p.id);
            const txPlaceholders = pIdsForQuery.map(() => '?').join(',');
            const allTransactions = pIdsForQuery.length > 0 ? database.db.prepare(`
                SELECT t.* FROM transactions t
                WHERE t.portfolioId IN (${txPlaceholders})
                ORDER BY t.date ASC
            `).all(...pIdsForQuery) : [];
            const assets = database.db.prepare('SELECT * FROM assets').all();
            const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

            const today = new Date();

            let startDate;
            switch (range) {
                case '1W':
                    startDate = new Date(today);
                    startDate.setDate(today.getDate() - 7);
                    break;
                case '1M':
                    startDate = new Date(today);
                    startDate.setMonth(today.getMonth() - 1);
                    break;
                case '3M':
                    startDate = new Date(today);
                    startDate.setMonth(today.getMonth() - 3);
                    break;
                case '6M':
                    startDate = new Date(today);
                    startDate.setMonth(today.getMonth() - 6);
                    break;
                case '1Y':
                    startDate = new Date(today);
                    startDate.setFullYear(today.getFullYear() - 1);
                    break;
                case '2Y':
                    startDate = new Date(today);
                    startDate.setFullYear(today.getFullYear() - 2);
                    break;
                case '3Y':
                    startDate = new Date(today);
                    startDate.setFullYear(today.getFullYear() - 3);
                    break;
                case '5Y':
                    startDate = new Date(today);
                    startDate.setFullYear(today.getFullYear() - 5);
                    break;
                case 'YTD':
                    startDate = new Date(today.getFullYear(), 0, 1);
                    break;
                case 'ALL':
                case 'MAX':
                    startDate = allTransactions.length > 0 ? new Date(allTransactions[0].date) : new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
                    break;
                default:
                    startDate = new Date(today);
                    startDate.setFullYear(today.getFullYear() - 1);
            }

            const dateStrStart = startDate.toISOString().split('T')[0];
            const dateStrEnd = today.toISOString().split('T')[0];

            const portfolioData = await calculatePerformanceHistory(
                pIdsForQuery,
                range, false, true, null, req.user.id, null, false, assetType
            );
            if (!portfolioData || !portfolioData.dataPoints || portfolioData.dataPoints.length === 0) {
                 return res.json({ error: 'No performance data' });
            }

            const isShortRange = range === '1W' || range === '1M' || range === '3M' || range === '1D';

            const fetchBenchmark = async (ticker) => {
                try {
                    // Margin before startDate to capture prior closing price
                    const qStart = new Date(startDate);
                    qStart.setDate(qStart.getDate() - (isShortRange ? 7 : 45));
                    const qStartStr = qStart.toISOString().split('T')[0];

                    // Query up to tomorrow to ensure today's quote is included if available
                    const qEnd = new Date(today);
                    qEnd.setDate(qEnd.getDate() + 1);
                    const qEndStr = qEnd.toISOString().split('T')[0];

                    const chart = await yahooFinance.chart(ticker, {
                        period1: qStartStr,
                        period2: qEndStr,
                        interval: isShortRange ? '1d' : '1mo'
                    });
                    if (chart && chart.quotes && chart.quotes.length > 0) {
                        return chart.quotes
                            .filter(h => h && h.date && (h.adjclose != null || h.close != null))
                            .map(h => ({
                                date: new Date(h.date).toISOString().split('T')[0].substring(0, isShortRange ? 10 : 7),
                                price: (h.adjclose ?? h.close) || 0
                            }))
                            .filter(q => q.price > 0);
                    }
                } catch (e) {
                    console.warn(`Failed benchmark fetch for ${ticker}:`, e.message);
                }
                return [];
            };

            const [sp500Quotes, msciQuotes, ftsemibQuotes, nasdaqQuotes, btcQuotes] = await Promise.all([
                fetchBenchmark('^GSPC'),
                fetchBenchmark('URTH'),
                fetchBenchmark('FTSEMIB.MI'),
                fetchBenchmark('^IXIC'),
                fetchBenchmark('BTC-USD')
            ]);

            const downsampleToMonthly = (daily) => {
                if (!daily || !Array.isArray(daily)) return [];
                const monthly = [];
                let currentMonthEvents = [];
                for (let i = 0; i < daily.length; i++) {
                    const day = daily[i];
                    if (!day || !day.date) continue;
                    const mStr = day.date.substring(0, 7);
                    if (day.events) currentMonthEvents.push(...day.events);
                    
                    const next = daily[i+1];
                    if (!next || !next.date || next.date.substring(0, 7) !== mStr) {
                        monthly.push({
                            ...day,
                            date: mStr,
                            events: [...currentMonthEvents]
                        });
                        currentMonthEvents = [];
                    }
                }
                return monthly;
            };

            const samplePoints = (daily) => {
                if (!daily || !Array.isArray(daily)) return [];
                if (isShortRange) {
                    return daily.map(d => ({
                        ...d,
                        date: (d && d.date) ? d.date.substring(0, 10) : '',
                        events: (d && d.events) || []
                    }));
                }
                return downsampleToMonthly(daily);
            };

            const rawPoints = portfolioData.dataPoints || [];
            const firstPt = rawPoints[0] || {};
            const lastPt = rawPoints[rawPoints.length - 1] || {};

            // 1. Total ROI (TWR): exactly matching Dashboard Performance (%) mode
            const startNorm = (firstPt.normalized !== undefined && firstPt.normalized > 0) ? firstPt.normalized : 100;
            const endNorm = (lastPt.normalized !== undefined) ? lastPt.normalized : 100;
            const totalROI = startNorm > 0 ? ((endNorm - startNorm) / startNorm) : 0;
            const twrValue = totalROI;

            // 2. Total Gain (€): exactly matching Dashboard P&L Netto mode (end profit - start profit)
            const startProfit = firstPt.profit !== undefined ? firstPt.profit : 0;
            const endProfit = lastPt.profit !== undefined ? lastPt.profit : 0;
            const rawPeriodProfit = endProfit - startProfit;

            // 3. Current & Start Values
            const currentTotalValue = lastPt.value || 0;
            const gPeriodStartValue = firstPt.value || 0;
            const gPeriodNetFlow = (lastPt.netDeposits || 0) - (firstPt.netDeposits || 0);

            // 4. Sampled normalized chart series directly using simulated TWR and values
            const normalizedGlobal = samplePoints(rawPoints).map(p => ({
                date: isShortRange ? (p.date || '').substring(0, 10) : (p.date || '').substring(0, 7),
                value: parseFloat((p.normalized !== undefined ? p.normalized : 100).toFixed(2)),
                absoluteValue: Math.round(p.value || 0),
                profit: Math.round(p.profit || 0),
                netDeposits: Math.round(p.netDeposits || 0),
                events: p.events || []
            }));
            const lastGlobal = normalizedGlobal.length > 0 ? normalizedGlobal[normalizedGlobal.length - 1] : null;
            const firstGlobal = normalizedGlobal.length > 0 ? normalizedGlobal[0] : null;
            const monthlyTwr = normalizedGlobal;
            const riskFreeMonthly = 0.002;

            // Align benchmarks strictly to the portfolio timeline so they reach the end of the X axis
            const targetDates = normalizedGlobal.map(p => p.date);
            const alignBenchmarkToTimeline = (quotes, tDates) => {
                if (!quotes || quotes.length === 0 || !tDates || tDates.length === 0) return [];
                const sortedQuotes = [...quotes].sort((a, b) => a.date.localeCompare(b.date));
                let firstPrice = sortedQuotes[0].price;
                const startMatch = sortedQuotes.filter(q => q.date <= tDates[0]);
                if (startMatch.length > 0) {
                    firstPrice = startMatch[startMatch.length - 1].price;
                }
                if (!firstPrice || firstPrice <= 0) firstPrice = 1;

                let lastKnownPrice = firstPrice;
                let quoteIdx = 0;

                return tDates.map(tDate => {
                    while (quoteIdx < sortedQuotes.length && sortedQuotes[quoteIdx].date <= tDate) {
                        if (sortedQuotes[quoteIdx].price && sortedQuotes[quoteIdx].price > 0) {
                            lastKnownPrice = sortedQuotes[quoteIdx].price;
                        }
                        quoteIdx++;
                    }
                    return {
                        date: tDate,
                        value: parseFloat(((lastKnownPrice / firstPrice) * 100).toFixed(2))
                    };
                });
            };

            const sp500 = alignBenchmarkToTimeline(sp500Quotes, targetDates);
            const msci = alignBenchmarkToTimeline(msciQuotes, targetDates);
            const ftsemib = alignBenchmarkToTimeline(ftsemibQuotes, targetDates);
            const nasdaq = alignBenchmarkToTimeline(nasdaqQuotes, targetDates);
            const btc = alignBenchmarkToTimeline(btcQuotes, targetDates);

            const calcBenchmarkReturn = (pts) => {
                if (!pts || pts.length < 2) return null;
                const first = pts[0].value;
                const last = pts[pts.length - 1].value;
                if (!first || first <= 0) return null;
                return ((last - first) / first) * 100;
            };

            const benchmarkReturns = {
                sp500: calcBenchmarkReturn(sp500),
                msci: calcBenchmarkReturn(msci),
                ftsemib: calcBenchmarkReturn(ftsemib),
                nasdaq: calcBenchmarkReturn(nasdaq),
                btc: calcBenchmarkReturn(btc)
            };

            const fxRates = {};
            const usdRates = database.db.prepare("SELECT date, price FROM asset_quotes WHERE ticker='EURUSD=X'").all();
            const usdMap = Object.fromEntries(usdRates.map(r => [r.date, r.price]));
            fxRates['USD'] = usdMap;

            // 5. Individual Portfolios
            const monthlyIndividual = {};
            if (portfolioData.individual) {
                for (const pid in portfolioData.individual) {
                    const p = portfolios.find(port => port.id == pid);
                    const indDaily = portfolioData.individual[pid] || [];
                    const indFirst = indDaily[0] || {};
                    const indLast = indDaily[indDaily.length - 1] || {};
                    const indStartNorm = (indFirst.normalized !== undefined && indFirst.normalized > 0) ? indFirst.normalized : 100;
                    const indEndNorm = (indLast.normalized !== undefined) ? indLast.normalized : 100;
                    const indROI = indStartNorm > 0 ? ((indEndNorm - indStartNorm) / indStartNorm) : 0;
                    const indProfit = (indLast.profit !== undefined ? indLast.profit : 0) - (indFirst.profit !== undefined ? indFirst.profit : 0);
                    const indCurVal = indLast.value || 0;

                    const indHistory = samplePoints(indDaily).map(pt => ({
                        date: isShortRange ? (pt.date || '').substring(0, 10) : (pt.date || '').substring(0, 7),
                        value: parseFloat((pt.normalized !== undefined ? pt.normalized : 100).toFixed(2)),
                        absoluteValue: Math.round(pt.value || 0),
                        profit: Math.round(pt.profit || 0),
                        netDeposits: Math.round(pt.netDeposits || 0)
                    }));

                    const pTxs = allTransactions.filter(t => t.portfolioId == pid && ['DEPOSIT', 'WITHDRAWAL'].includes(t.type));
                    const pFlows = pTxs.map(t => {
                        const rate = (p && p.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
                        const amt = (t.amount || (t.quantity * t.price)) / rate;
                        return { date: new Date(t.date), amount: t.type === 'DEPOSIT' ? -amt : amt };
                    });
                    pFlows.push({ date: new Date(), amount: indCurVal });
                    pFlows.sort((a,b) => a.date - b.date);
                    const indXirr = pFlows.length >= 2 ? (xirr(pFlows) || 0) : 0;

                    monthlyIndividual[pid] = {
                        id: pid,
                        name: p ? p.name : pid,
                        history: indHistory,
                        metrics: {
                            totalROI: indROI,
                            twr: indROI,
                            totalGain: indProfit,
                            xirr: indXirr,
                            currentValue: indCurVal,
                            contribution: (currentTotalValue > 0) ? (indCurVal / currentTotalValue) : 0,
                            sharpeRatio: (() => {
                                const returns = [];
                                for (let i = 1; i < indHistory.length; i++) {
                                    const prev = indHistory[i-1].value;
                                    const curr = indHistory[i].value;
                                    if (prev > 0) returns.push((curr / prev) - 1);
                                }
                                if (returns.length < 2) return 0;
                                const m = returns.reduce((a, b) => a + b, 0) / returns.length;
                                const s = Math.sqrt(returns.map(x => Math.pow(x - m, 2)).reduce((a, b) => a + b, 0) / returns.length);
                                return s > 0 ? (m - riskFreeMonthly) / s : 0;
                            })()
                        }
                    };
                }
            }

            const diversification = {
                geography: {},
                assetType: {},
                currency: {}
            };

            for (const p of portfolios) {
                const holdings = {};
                const holdingsCost = {};
                const pTxs = allTransactions.filter(t => t.portfolioId === p.id);
                for (const t of pTxs) {
                    if (t.type === 'BUY') {
                        holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + t.quantity;
                        const costAsset = t.amount ? (Math.abs(t.amount) * (t.exchangeRate || 1)) : (t.quantity * t.price + t.commission + t.tax);
                        holdingsCost[t.assetTicker] = (holdingsCost[t.assetTicker] || 0) + costAsset;
                    }
                    if (t.type === 'SELL') {
                        const avgCost = holdings[t.assetTicker] > 0 ? (holdingsCost[t.assetTicker] || 0) / holdings[t.assetTicker] : 0;
                        holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - t.quantity;
                        holdingsCost[t.assetTicker] = Math.max(0, (holdingsCost[t.assetTicker] || 0) - (t.quantity * avgCost));
                    }
                }
                for (const [ticker, shares] of Object.entries(holdings)) {
                    if (shares <= 0.0001) continue;
                    const a = assetMap[ticker];
                    if (!a) continue;
                    const lastExRate = pTxs.filter(tx => tx.assetTicker === ticker && tx.exchangeRate).at(-1)?.exchangeRate || 1;
                    
                    let curPx = a.currentPrice;
                    if (ticker.startsWith('CD_') || ticker.startsWith('BP_') || ['Conto Deposito', 'Buono Postale'].includes(a.type)) {
                        curPx = shares > 0 ? (holdingsCost[ticker] || 0) / shares : 0;
                    }
                    
                    const value = shares * (curPx / lastExRate);

                    const geo = a.country || 'Unknown';
                    let type = a.type || 'Other';
                    if (ticker.startsWith('CD_') || ticker.startsWith('BP_') || ticker.startsWith('CASH')) type = 'Liquidità';
                    const currency = a.currency || p.currency || 'EUR';
                    diversification.geography[geo] = (diversification.geography[geo] || 0) + value;
                    diversification.assetType[type] = (diversification.assetType[type] || 0) + value;
                    diversification.currency[currency] = (diversification.currency[currency] || 0) + value;
                }
            }

            const dividends = [];
            for (let i = 11; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const mStr = d.toISOString().substring(0, 7);
                const monthlyDiv = allTransactions
                    .filter(t => t.type === 'DIVIDEND' && t.date.startsWith(mStr))
                    .reduce((sum, t) => sum + (t.amount ? Math.abs(t.amount) : (t.quantity * t.price - t.commission - t.tax) / (t.exchangeRate || 1)), 0);
                dividends.push({ date: mStr, amount: monthlyDiv });
            }

            const externalTxs = allTransactions.filter(t => ['DEPOSIT', 'WITHDRAWAL'].includes(t.type));
            const flows = [];
            for (const t of externalTxs) {
                const p = portfolios.find(port => port.id === t.portfolioId);
                const rate = (p && p.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
                const amt = (t.amount || (t.quantity * t.price)) / rate;
                flows.push({
                    date: new Date(t.date),
                    amount: t.type === 'DEPOSIT' ? -amt : amt
                });
            }
            flows.push({ date: new Date(), amount: currentTotalValue });
            flows.sort((a,b) => a.date - b.date);
            const xirrValue = flows.length >= 2 ? (xirr(flows) || 0) : 0;

            let bestAsset = { ticker: '-', profit: -Infinity };
            for (const [ticker, a] of Object.entries(assetMap)) {
                if (ticker === 'CASH') continue;
                if (assetType && assetType !== 'all' && !matchAssetType(a.type, ticker, assetType)) continue;
                let unrealized = 0;
                let realized = 0;
                let qty = 0;
                let costBasis = 0;
                const tks = allTransactions.filter(t => t.assetTicker === ticker);
                for (const t of tks) {
                    const fx = t.exchangeRate || 1;
                    const total = t.amount ? Math.abs(t.amount) : (t.quantity * t.price + (t.type==='BUY'?1:-1)*(t.commission+t.tax)) / fx;
                    if (t.type === 'BUY') {
                        qty += t.quantity;
                        costBasis += total;
                    } else if (t.type === 'SELL') {
                        const avgCost = qty > 0 ? costBasis / qty : 0;
                        realized += total - (t.quantity * avgCost);
                        qty -= t.quantity;
                        costBasis -= (t.quantity * avgCost);
                    } else if (t.type === 'DIVIDEND') {
                        realized += t.amount ? Math.abs(t.amount) : (t.quantity * t.price - t.commission - t.tax) / fx;
                    }
                }
                unrealized = qty * (a.currentPrice / (tks.filter(tx=>tx.exchangeRate).at(-1)?.exchangeRate||1)) - costBasis;
                const totalProfit = realized + unrealized;
                if (totalProfit > bestAsset.profit) bestAsset = { ticker, profit: totalProfit, name: a.name };
            }

            const annualGainsMap = {};
            const currentYearString = today.getFullYear().toString();
            const liveRateValReports = await getEurUsdRate();
            const assetGainsMap = {};

            const resolveAssetTypeAndName = (ticker, rawType, rawName, aMeta) => {
                let name = rawName || aMeta?.name || ticker;
                let type = rawType || aMeta?.type;
                const tick = (ticker || '').toUpperCase();
                if (!type || type === 'Stock' || type === 'Manual' || type === 'Azioni') {
                    if (tick.startsWith('CD_') || tick.startsWith('BP_') || (aMeta && ['Conto Deposito', 'Buono Postale', 'Liquidità'].includes(aMeta.type)) || tick === 'CASH') {
                        type = 'Conto Deposito';
                        if (name === ticker) {
                            name = tick.startsWith('CD_') ? 'Conto Deposito ' + ticker.replace('CD_', '').replace(/_/g, ' ') : (tick.startsWith('BP_') ? 'Buono Postale ' + ticker.replace('BP_', '').replace(/_/g, ' ') : ticker);
                        }
                    } else if (tick.startsWith('IT000') || tick.startsWith('BTP') || tick.startsWith('BOT') || tick.startsWith('CCT') || tick.startsWith('ROM') || (aMeta && ['Bond', 'Obbligazioni', 'Obbligazione'].includes(aMeta.type))) {
                        type = 'Bond';
                    } else if (tick.includes('ETF') || tick.endsWith('.MI') && (tick.startsWith('SWDA') || tick.startsWith('VWCE') || tick.startsWith('XEON') || tick.startsWith('C3M') || tick.startsWith('X25'))) {
                        type = (tick.startsWith('XEON') || tick.startsWith('C3M')) ? 'ETF Monetario' : (tick.startsWith('X25') ? 'ETF Obblig' : 'ETF Azionario');
                    } else {
                        type = type || 'Azioni';
                    }
                }
                return { name, type };
            };

            let totalEstimatedDividendsEUR = 0;

            for (const p of portfolios) {
                try {
                    const details = await getPortfolioDetails(p.id, liveRateValReports);
                    if (!details) continue;
                    const rate = (p.currency === 'USD') ? liveRateValReports : 1;
                    
                    // 1. Closed positions (Realized Gains & Cost Basis)
                    for (const pos of (details.closedPositions || [])) {
                        const aMeta = assetMap[pos.ticker] || {};
                        const { name: resName, type: posType } = resolveAssetTypeAndName(pos.ticker, pos.type, pos.name, aMeta);
                        if (hasAssetTypeFilter && !matchAssetType(posType, pos.ticker, assetType)) continue;
                        
                        const y = pos.year;
                        if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                        const rGainEur = (pos.realizedGain || 0) / rate;
                        const costBasisEur = (pos.totalCostBasis || 0) / rate;
                        annualGainsMap[y].realized += rGainEur;

                        if (!assetGainsMap[pos.ticker]) {
                            assetGainsMap[pos.ticker] = {
                                ticker: pos.ticker,
                                name: resName,
                                type: posType,
                                currency: aMeta.currency || p.currency || 'EUR',
                                realizedGain: 0,
                                dividends: 0,
                                unrealizedGain: 0,
                                totalGain: 0,
                                totalInvested: 0,
                                hasOpenPosition: false
                            };
                        }
                        assetGainsMap[pos.ticker].realizedGain += rGainEur;
                        assetGainsMap[pos.ticker].totalInvested += costBasisEur;
                    }
                    
                    // 2. Dividends & Interest
                    const divsList = details.dividends || [];
                    if (divsList.length > 0) {
                        for (const d of divsList) {
                            const aMeta = assetMap[d.ticker] || {};
                            const { name: resName, type: dType } = resolveAssetTypeAndName(d.ticker, null, null, aMeta);
                            if (hasAssetTypeFilter && !matchAssetType(dType, d.ticker, assetType)) continue;
                            
                            const y = d.year;
                            if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                            const divAmtEur = (d.amount || 0) / rate;
                            annualGainsMap[y].dividends += divAmtEur;

                            if (!assetGainsMap[d.ticker]) {
                                assetGainsMap[d.ticker] = {
                                    ticker: d.ticker,
                                    name: resName,
                                    type: dType,
                                    currency: aMeta.currency || p.currency || 'EUR',
                                    realizedGain: 0,
                                    dividends: 0,
                                    unrealizedGain: 0,
                                    totalGain: 0,
                                    totalInvested: 0,
                                    hasOpenPosition: false
                                };
                            }
                            assetGainsMap[d.ticker].dividends += divAmtEur;
                        }
                    } else {
                        for (const group of (details.dividendGroups || [])) {
                            const aMeta = assetMap[group.ticker] || {};
                            const { name: resName, type: dType } = resolveAssetTypeAndName(group.ticker, group.type || group.assetType, null, aMeta);
                            if (hasAssetTypeFilter && !matchAssetType(dType, group.ticker, assetType)) continue;
                            const y = group.year;
                            if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                            const divAmtEur = (group.total || 0) / rate;
                            annualGainsMap[y].dividends += divAmtEur;
                        }
                    }
                    
                    // 3. Open Holdings (Unrealized Gains & Cost Basis)
                    for (const h of (details.holdings || [])) {
                        const aMeta = assetMap[h.ticker] || {};
                        const { name: resName, type: hType } = resolveAssetTypeAndName(h.ticker, h.type, h.name, aMeta);
                        if (hasAssetTypeFilter && !matchAssetType(hType, h.ticker, assetType)) continue;

                        const uGainEur = (h.unrealizedGain || 0) / rate;
                        const costInEur = (h.totalCostInPCurr || 0) / rate;
                        
                        if (h.shares > 0.0001 && h.currentPrice && h.dividendYield) {
                            const annualDivEUR = ((h.currentPrice * h.dividendYield * h.shares) / rate) || 0;
                            totalEstimatedDividendsEUR += annualDivEUR;
                        }

                        if (!annualGainsMap[currentYearString]) annualGainsMap[currentYearString] = { year: currentYearString, realized: 0, dividends: 0, unrealized: 0 };
                        annualGainsMap[currentYearString].unrealized += uGainEur;

                        if (!assetGainsMap[h.ticker]) {
                            assetGainsMap[h.ticker] = {
                                ticker: h.ticker,
                                name: resName,
                                type: hType,
                                currency: h.currency || p.currency || 'EUR',
                                realizedGain: 0,
                                dividends: 0,
                                unrealizedGain: 0,
                                totalGain: 0,
                                totalInvested: 0,
                                hasOpenPosition: false
                            };
                        }
                        assetGainsMap[h.ticker].unrealizedGain += uGainEur;
                        assetGainsMap[h.ticker].totalInvested += costInEur;
                        if (h.shares > 0.0001) {
                            assetGainsMap[h.ticker].hasOpenPosition = true;
                        }
                    }
                    
                } catch (e) {
                    console.error(`Error aggregating annual and asset gains for portfolio ${p.id}:`, e);
                }
            }

            const totalDividendsAllTime = Object.values(annualGainsMap).reduce((s, ag) => s + (ag.dividends || 0), 0);
            const totalDividendsCurrentYear = annualGainsMap[currentYearString]?.dividends || 0;
            const totalDividends12M = dividends.reduce((s, x) => s + (x.amount || 0), 0);

            // Use the comprehensive dividend projections engine if available for the user
            let totalProjectedAnnualDividendsEUR = totalEstimatedDividendsEUR;
            try {
                const divProj = await calculateDividendProjections(req.user.id);
                if (divProj && typeof divProj.totalExpected === 'number' && divProj.totalExpected > 0) {
                    totalProjectedAnnualDividendsEUR = divProj.totalExpected;
                }
            } catch (projErr) {
                console.warn('Could not integrate dividend projections into reports:', projErr.message);
            }

            const estimatedDividendYield = currentTotalValue > 0 ? (totalProjectedAnnualDividendsEUR / currentTotalValue) : 0;

            const annualGains = Object.values(annualGainsMap).map(ag => ({
                ...ag,
                realized: Math.round(ag.realized * 100) / 100,
                dividends: Math.round(ag.dividends * 100) / 100,
                unrealized: Math.round(ag.unrealized * 100) / 100,
                projectedDividends: ag.year === currentYearString ? Math.round(totalProjectedAnnualDividendsEUR * 100) / 100 : undefined
            })).sort((a,b) => b.year - a.year);

            // Finalize assetGains
            const assetGains = Object.values(assetGainsMap).map(ag => {
                const totalGain = ag.realizedGain + ag.dividends + ag.unrealizedGain;
                const gainPct = ag.totalInvested > 0 ? (totalGain / ag.totalInvested) * 100 : 0;
                return {
                    ...ag,
                    realizedGain: Math.round(ag.realizedGain * 100) / 100,
                    dividends: Math.round(ag.dividends * 100) / 100,
                    unrealizedGain: Math.round(ag.unrealizedGain * 100) / 100,
                    totalGain: Math.round(totalGain * 100) / 100,
                    totalInvested: Math.round(ag.totalInvested * 100) / 100,
                    gainPct: Math.round(gainPct * 100) / 100
                };
            }).sort((a,b) => b.totalGain - a.totalGain);

            const trueAllTimeGain = assetGains.reduce((sum, a) => sum + a.totalGain, 0);
            const isAllTime = !isShortRange && (!range || range === 'MAX' || range === 'ALL');
            const totalGain = isAllTime ? trueAllTimeGain : rawPeriodProfit;

            res.json({
                performance: {
                    portfolio: normalizedGlobal,
                    twr: monthlyTwr,
                    individual: monthlyIndividual,
                    sp500,
                    msci,
                    ftsemib,
                    nasdaq,
                    btc,
                    benchmarks: benchmarkReturns
                },
                diversification,
                dividends,
                annualGains,
                assetGains,
                metrics: {
                    totalROI,
                    totalGain,
                    allTimeGain: trueAllTimeGain,
                    annualizedROI: (totalROI > -1 && normalizedGlobal.length > 0) ? (Math.pow(1 + totalROI, 1 / (Math.max(1, normalizedGlobal.length) / 12)) - 1) : totalROI,
                    xirr: xirrValue || 0,
                    twr: twrValue || 0,
                    bestAsset: (bestAsset && bestAsset.ticker && bestAsset.ticker !== '-') ? `${bestAsset.name || bestAsset.ticker} (${bestAsset.ticker})` : '-',
                    sharpeRatio: (() => {
                        const returns = [];
                        for (let i = 1; i < normalizedGlobal.length; i++) {
                            const prev = normalizedGlobal[i-1].value;
                            const curr = normalizedGlobal[i].value;
                            if (prev > 0) returns.push((curr / prev) - 1);
                        }
                        if (returns.length < 2) return 0;
                        const meanValue = returns.reduce((a, b) => a + b, 0) / returns.length;
                        const stdDevValue = Math.sqrt(returns.map(x => Math.pow(x - meanValue, 2)).reduce((a, b) => a + b, 0) / returns.length);
                        return stdDevValue > 0 ? (meanValue - riskFreeMonthly) / stdDevValue : 0;
                    })(),
                    estimatedDividends: Math.round(totalProjectedAnnualDividendsEUR * 100) / 100,
                    estimatedDividendYield: Math.round(estimatedDividendYield * 10000) / 10000,
                    totalDividendsCurrentYear: Math.round(totalDividendsCurrentYear * 100) / 100,
                    totalDividendsAllTime: Math.round(totalDividendsAllTime * 100) / 100,
                    totalDividends12M: Math.round(totalDividends12M * 100) / 100,
                    dividendYield: estimatedDividendYield > 0 ? estimatedDividendYield : (currentTotalValue > 0 ? totalDividends12M / currentTotalValue : 0)
                }
            });

        } catch (err) {
            console.error('[reports 500] range=%s assetType=%s portfolioIds=%s — %s', 
                req.query.range, req.query.assetType, req.query.portfolioIds, err.message);
            console.error(err.stack || err);
            res.status(500).json({ error: err.message, stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined });
        }
    });

    // POST /api/analytics/ai-report
    router.post('/analytics/ai-report', requireAuth, async (req, res) => {
        const userId = req.user.id;
        try {
            aiLogger.info(`[AI Report] Requested by user: ${userId || 'unknown'}`);
            
            // Imposta lo stato su in corso
            aiJobStatus[userId] = { status: 'running', ts: Date.now() };
            
            const { contextData } = req.body;
            
            // Read settings for the logged-in user (merged with admin settings)
            const adminSettings = database.getSettings(1);
            const userSettings = database.getSettings(req.user ? req.user.id : 1);
            const settings = { ...adminSettings, ...userSettings };
            
            const engine = settings.aiReportEngine || settings.aiEngine || 'Gemini_Free';
            aiLogger.info(`[AI Report] Selected engine: ${engine}`);

            const promptTemplate = settings.aiReportPrompt || `Sei un analista finanziario esperto. Analizza il seguente portafoglio.
Restituisci la tua risposta ESCLUSIVAMENTE in formato JSON con questa esatta struttura:
{
  "risk_score": <numero da 1 a 5, 1=Basso, 5=Alto>,
  "diversification_score": <numero da 1 a 5, 1=Scarsa, 5=Ottima>,
  "allocation_score": <numero da 1 a 5, 1=Scarsa, 5=Ottima>,
  "quality_score": <numero da 1 a 5, 1=Bassa, 5=Alta>,
  "markdown_content": "<IL TUO REPORT IN MARKDOWN>"
}
Nel report markdown usa TITOLI (## Titolo), TABELLE in formato Markdown (| Col 1 | Col 2 |) per Top Performer, Peggiori e Dividendi, metti in grassetto i dati chiave e usa Emoji. Il json deve essere formattato correttamente.`;

            // Get all transactions for the user's portfolios
            const txs = database.db.prepare(`
                SELECT t.assetTicker, t.type, t.date, t.quantity, t.price, t.amount, p.currency, t.exchangeRate, t.commission, t.tax 
                FROM transactions t
                JOIN portfolios p ON t.portfolioId = p.id
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ?
                ORDER BY t.date ASC
            `).all(req.user.id);
            
            const pmcMap = {};
            for (const t of txs) {
                if (!t.assetTicker) continue;
                if (!pmcMap[t.assetTicker]) pmcMap[t.assetTicker] = { shares: 0, cost: 0 };
                if (t.type === 'BUY') {
                    pmcMap[t.assetTicker].shares += (t.quantity || 0);
                    pmcMap[t.assetTicker].cost += (t.quantity || 0) * (t.price || 0);
                } else if (t.type === 'SELL') {
                    const oldShares = pmcMap[t.assetTicker].shares;
                    const oldCost = pmcMap[t.assetTicker].cost;
                    const avgPrice = oldShares > 0 ? (oldCost / oldShares) : 0;
                    
                    pmcMap[t.assetTicker].shares -= (t.quantity || 0);
                    if (pmcMap[t.assetTicker].shares <= 0.000001) {
                        pmcMap[t.assetTicker].shares = 0;
                        pmcMap[t.assetTicker].cost = 0;
                    } else {
                        pmcMap[t.assetTicker].cost -= (t.quantity || 0) * avgPrice;
                    }
                }
            }
            
            let parsedContext = {};
            try {
                parsedContext = typeof contextData === 'string' ? JSON.parse(contextData) : (contextData || {});
            } catch (pErr) {
                aiLogger.warn('[AI Report] Context parse warning:', pErr.message);
                parsedContext = contextData || {};
            }

            // Get open positions details for formatting
            const openAssetsList = database.db.prepare(`
                SELECT 
                    COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                    SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as shares,
                    a.name as name,
                    a.type as assetType,
                    a.currency as currency,
                    a.currentPrice as currentPrice
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                LEFT JOIN assets a ON t.assetTicker = a.ticker
                WHERE pu.user_id = ?
                GROUP BY ticker
                HAVING shares > 0.0001
            `).all(req.user.id);

            const assetGainMap = {};
            if (parsedContext.assetGains && Array.isArray(parsedContext.assetGains)) {
                for (const ag of parsedContext.assetGains) {
                    if (ag.ticker) assetGainMap[ag.ticker] = ag;
                }
            }

            const formattedAssetLines = openAssetsList.map(pos => {
                const ticker = pos.ticker;
                const pmcVal = (pmcMap[ticker] && pmcMap[ticker].shares > 0) ? (pmcMap[ticker].cost / pmcMap[ticker].shares) : 0;
                
                const ag = assetGainMap[ticker] || {};
                const nameStr = pos.name || ag.name || ticker;
                const typeStr = pos.assetType || ag.assetType || 'Generico';
                const currencyStr = pos.currency || ag.currency || 'EUR';
                const currSymbol = currencyStr === 'USD' ? '$' : '€';
                
                const currentPriceVal = (pos.currentPrice > 0 ? pos.currentPrice : (ag.currentPrice > 0 ? ag.currentPrice : pmcVal)) || 0;
                
                const pmcStr = pmcVal > 0 
                    ? pmcVal.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
                    : '0,00';
                const priceStr = currentPriceVal > 0 
                    ? currentPriceVal.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
                    : '0,00';
                const qtyStr = Number(pos.shares).toLocaleString('it-IT', { maximumFractionDigits: 4 });

                return `- ${ticker} | ${nameStr} | Tipo: ${typeStr} | Q.tà: ${qtyStr} | PMC: ${pmcStr} ${currSymbol} | Prezzo Attuale: ${priceStr} ${currSymbol}`;
            });

            const openAssetsText = `ASSET APERTI:\n` + (formattedAssetLines.length > 0 ? formattedAssetLines.join('\n') : '- Nessun asset aperto.');

            const enhancedContext = {
                portfolioStats: parsedContext,
                pmcData: Object.fromEntries(
                    Object.entries(pmcMap)
                    .filter(([, data]) => data.shares > 0)
                    .map(([ticker, data]) => [ticker, { pmc: data.cost / data.shares, shares: data.shares }])
                ),
                openAssetsFormatted: openAssetsText,
                openAssetsList: openAssetsList.map(pos => {
                    const ticker = pos.ticker;
                    const pmcVal = (pmcMap[ticker] && pmcMap[ticker].shares > 0) ? (pmcMap[ticker].cost / pmcMap[ticker].shares) : 0;
                    const ag = assetGainMap[ticker] || {};
                    return {
                        ticker,
                        name: pos.name || ag.name || ticker,
                        type: pos.assetType || ag.assetType || 'Generico',
                        quantity: pos.shares,
                        pmc: pmcVal,
                        currentPrice: pos.currentPrice || ag.currentPrice || pmcVal,
                        currency: pos.currency || ag.currency || 'EUR'
                    };
                }),
                transactionsHistory: txs
            };
            
            // Calculate Portfolio P/E
            let totalValueForPE = 0;
            let weightedPE = 0;
            if (parsedContext.assetGains) {
                for (const a of parsedContext.assetGains) {
                    if (a.ticker === 'CASH' || !a.currentValue) continue;
                    // fetch PE from DB
                    const fund = database.db.prepare('SELECT forwardPE, pegRatio FROM asset_fundamentals WHERE ticker = ? COLLATE NOCASE').get(a.ticker);
                    if (fund && fund.forwardPE && fund.forwardPE > 0) {
                        weightedPE += (fund.forwardPE * a.currentValue);
                        totalValueForPE += a.currentValue;
                    }
                }
            }
            const portfolioPE = totalValueForPE > 0 ? (weightedPE / totalValueForPE) : null;
            enhancedContext.portfolioPE = portfolioPE;
            
            const fullPrompt = `${promptTemplate}\n\n${openAssetsText}\n\nDATI COMPLETI PORTAFOGLIO (JSON):\n${JSON.stringify(enhancedContext)}`;
            
            aiLogger.info(`[AI Report] Invoking AI model for user ${req.user.id}...`);
            const aiResponse = await aiService.callAIModel(engine, fullPrompt, settings);
            
            let reportData;
            try {
                // Pulizia json se l'AI mette i backtick
                let cleanText = aiResponse.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                reportData = JSON.parse(cleanText);
            } catch(e) {
                aiLogger.warn('[AI Report] JSON parse failed, falling back to dummy scores');
                reportData = {
                    risk_score: 3, diversification_score: 3, allocation_score: 3, quality_score: 3,
                    markdown_content: aiResponse.text
                };
            }
            
            aiLogger.info(`[AI Report] Success! Generated content.`);

            const now = new Date().toISOString();
            
            // Save to DB
            const stmt = database.db.prepare(`
                INSERT INTO ai_portfolio_reports (user_id, date, risk_score, diversification_score, allocation_score, quality_score, pe_value, markdown_content, raw_context)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const info = stmt.run(
                req.user.id, now,
                reportData.risk_score || 0,
                reportData.diversification_score || 0,
                reportData.allocation_score || 0,
                reportData.quality_score || 0,
                portfolioPE,
                reportData.markdown_content || '',
                JSON.stringify(parsedContext)
            );
            
            aiJobStatus[userId] = { status: 'success', reportId: info.lastInsertRowid, ts: Date.now() };
            
            res.json({ id: info.lastInsertRowid, date: now, data: reportData, portfolioPE });
        } catch (err) {
            aiLogger.error('[AI Report Error]', err.stack || err.message || err);
            console.error('[AI Report Error]', err);
            
            aiJobStatus[userId] = { status: 'error', error: err.message, ts: Date.now() };
            
            res.status(500).json({ error: err.message || 'Errore nella generazione del report IA', stack: err.stack });
        }
    });

    // GET /api/analytics/ai-status
    router.get('/analytics/ai-status', requireAuth, (req, res) => {
        const status = aiJobStatus[req.user.id] || { status: 'idle' };
        res.json(status);
    });

    // DELETE /api/analytics/ai-status
    router.delete('/analytics/ai-status', requireAuth, (req, res) => {
        if (aiJobStatus[req.user.id]) {
            delete aiJobStatus[req.user.id];
        }
        res.json({ success: true });
    });

    // GET /api/analytics/ai-report/latest
    router.get('/analytics/ai-report/latest', requireAuth, (req, res) => {
        try {
            const report = database.db.prepare(`
                SELECT id, date, markdown_content as text
                FROM ai_portfolio_reports 
                WHERE user_id = ? 
                ORDER BY date DESC 
                LIMIT 1
            `).get(req.user.id);
            
            if (report) {
                res.json(report);
            } else {
                res.status(404).json({ error: 'No report found' });
            }
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/ai-reports
    router.get('/analytics/ai-reports', requireAuth, (req, res) => {
        try {
            const reports = database.db.prepare(`
                SELECT id, date, risk_score, diversification_score, allocation_score, quality_score, pe_value, markdown_content, raw_context 
                FROM ai_portfolio_reports 
                WHERE user_id = ? 
                ORDER BY date DESC
            `).all(req.user.id);
            res.json(reports);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/analytics/ai-reports/:id
    router.delete('/analytics/ai-reports/:id', requireAuth, (req, res) => {
        try {
            const reportId = req.params.id;
            database.db.prepare(`DELETE FROM ai_portfolio_reports WHERE id = ? AND user_id = ?`).run(reportId, req.user.id);
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
