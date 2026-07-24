const express = require('express');

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
            const BOND_TYPES = ['Bond', 'ETF Obblig', 'Deposito Vincolato', 'ETF Monetario'];

            // Get open positions (only assets currently held by this user)
            const openPositions = database.db.prepare(`
                SELECT * FROM (
                    SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                           SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance,
                           a.type as assetType,
                           a.currency as currency,
                           COALESCE(a.name, 'N/A') as name
                    FROM transactions t
                    JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                    LEFT JOIN assets a ON t.assetTicker = a.ticker
                    WHERE pu.user_id = ?
                    GROUP BY ticker
                )
                WHERE balance > 0.0001
            `).all(userId);

            const allDivTx = database.db.prepare(`
                SELECT COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker, t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
                FROM transactions t 
                JOIN portfolios p ON t.portfolioId = p.id 
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
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
                WHERE pu.user_id = ? AND t.assetTicker = ? AND t.date <= ?
            `);

            const newProjections = [];

            const projectionPromises = openPositions.map(async (pos) => {
                const ticker = pos.ticker;
                const isBond = BOND_TYPES.includes(pos.assetType) || ticker.startsWith('CD_') || ticker === 'Sconosciuto';
                
                if (isBond) {
                    const lastYearDivs = allDivTx.filter(d => d.ticker === ticker && d.date.startsWith(lastYear.toString()));
                    lastYearDivs.forEach(d => {
                        const newDate = `${currentYear}-${d.date.substring(5)}`;
                        if (newDate >= now.toISOString().split('T')[0]) {
                            const month = newDate.split('-')[1];
                            const alreadyConfirmed = allDivTx.some(tx => tx.ticker === ticker && tx.date.split('-')[1] === month && tx.date.startsWith(currentYear.toString()));
                            if (!alreadyConfirmed) {
                                const balanceOnExDate = balanceOnExDateQuery.get(userId, ticker, newDate)?.balance || 0;
                                if (balanceOnExDate > 0.0001) {
                                    const lastYearNet = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
                                    const lastYearTax = toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
                                    const lastYearGross = lastYearNet + lastYearTax;
                                    newProjections.push({ ticker, name: pos.name, date: newDate, tag: 'STORICO', amount: 0, totalAmount: lastYearNet, gross: lastYearGross, tax: lastYearTax, yield: 0 });
                                }
                            }
                        }
                    });
                } else if (ticker && !ticker.startsWith('CD_') && ticker !== 'Sconosciuto') {
                    try {
                        const summary = await yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'calendarEvents'] }).catch(() => null);
                        if (summary && summary.summaryDetail && summary.summaryDetail.dividendRate > 0) {
                            const annualRate = summary.summaryDetail.dividendRate;
                            const assetYield = summary.summaryDetail.dividendYield || 0;
                            const currencyYF = summary.summaryDetail.currency || pos.currency;
                            
                            const histLastYear = allDivTx.filter(d => d.ticker === ticker && d.date.startsWith(lastYear.toString()));
                            let freq = summary.summaryDetail.dividendFrequency;
                            if (!freq) {
                                if (histLastYear.length > 0) {
                                    freq = histLastYear.length;
                                } else {
                                    freq = 4;
                                }
                            }
                            
                            let nextDateStr = null;
                            const ce = summary.calendarEvents || {};
                            const dDate = ce.dividendDate || ce.exDividendDate;
                            
                            if (dDate) {
                                nextDateStr = new Date(dDate).toISOString().split('T')[0];
                            }
                            
                            let yfProjected = false;
                            if (nextDateStr && nextDateStr >= now.toISOString().split('T')[0]) {
                                const month = nextDateStr.split('-')[1];
                                const alreadyConfirmed = allDivTx.some(tx => tx.ticker === ticker && tx.date.split('-')[1] === month && tx.date.startsWith(currentYear.toString()));
                                if (!alreadyConfirmed) {
                                    const balanceOnExDate = balanceOnExDateQuery.get(userId, ticker, nextDateStr)?.balance || 0;
                                    if (balanceOnExDate > 0.0001) {
                                        const perPayment = (annualRate * balanceOnExDate) / freq;
                                        const amtGrossEUR = toEUR(perPayment, currencyYF, null);
                                        const unitAmount = toEUR(annualRate / freq, currencyYF, null);
                                        
                                        let taxRate = taxMap[pos.assetType];
                                        if (taxRate === undefined) taxRate = 26.0;
                                        const taxEUR = amtGrossEUR * (taxRate / 100);
                                        const netEUR = amtGrossEUR - taxEUR;
                                        
                                        newProjections.push({ ticker, name: pos.name, date: nextDateStr, tag: 'YF', amount: unitAmount, totalAmount: netEUR, gross: amtGrossEUR, tax: taxEUR, yield: assetYield });
                                        yfProjected = true;
                                    }
                                }
                            }
                            
                            if (!yfProjected && annualRate > 0) {
                                if (histLastYear.length > 0) {
                                    histLastYear.forEach(d => {
                                        const newDate = `${currentYear}-${d.date.substring(5)}`;
                                        if (newDate >= now.toISOString().split('T')[0]) {
                                            const month = newDate.split('-')[1];
                                            const alreadyConfirmed = allDivTx.some(tx => tx.ticker === ticker && tx.date.split('-')[1] === month && tx.date.startsWith(currentYear.toString()));
                                            if (!alreadyConfirmed) {
                                                const balanceOnExDate = balanceOnExDateQuery.get(userId, ticker, newDate)?.balance || 0;
                                                if (balanceOnExDate > 0.0001) {
                                                    const lastYearNet = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
                                                    const lastYearTax = toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
                                                    const lastYearGross = lastYearNet + lastYearTax;
                                                    
                                                    newProjections.push({ ticker, name: pos.name, date: newDate, tag: 'SIMULATO', amount: 0, totalAmount: lastYearNet, gross: lastYearGross, tax: lastYearTax, yield: assetYield });
                                                }
                                            }
                                        }
                                    });
                                }
                            }
                        }
                    } catch(e) {
                        logger.error(`Error fetching YF data for ${ticker}:`, e.message);
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

    // GET /api/export-all-transactions
    router.get('/export-all-transactions', requireAuth, (req, res) => {
        try {
            const transactions = database.db.prepare(`
                SELECT t.*, p.name as portfolioName 
                FROM transactions t
                JOIN portfolios p ON t.portfolioId = p.id
                ORDER BY t.date ASC, t.id ASC
            `).all();

            if (transactions.length === 0) {
                return res.status(400).send('No transactions to export');
            }

            const headers = ['Portfolio', 'Type', 'Asset', 'Date', 'Quantity', 'Price', 'Commission', 'Tax', 'FX Rate', 'Amount'];
            const rows = transactions.map(t => [
                t.portfolioName,
                t.type,
                t.assetTicker || '',
                t.date,
                t.quantity,
                t.price,
                t.commission,
                t.tax,
                t.exchangeRate,
                t.amount
            ]);

            let csvContent = headers.join(',') + '\n';
            rows.forEach(row => {
                csvContent += row.map(value => {
                    if (typeof value === 'string') {
                        return `"${value.replace(/"/g, '""')}"`;
                    }
                    return value;
                }).join(',') + '\n';
            });

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=all_transactions_export_${new Date().toISOString().split('T')[0]}.csv`);
            res.status(200).send(csvContent);
        } catch (err) {
            console.error('Export all error:', err);
            res.status(500).send('Export error: ' + err.message);
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
                        const totalCost = (t.amount || (t.quantity * t.price + t.commission + t.tax)) / t.exchangeRate;
                        holdingsMap[t.assetTicker].shares += t.quantity;
                        holdingsMap[t.assetTicker].costBasis += totalCost;

                    } else if (t.type === 'SELL' && t.assetTicker) {
                        const sellQty = t.quantity;
                        const h = holdingsMap[t.assetTicker] || { shares: 0, costBasis: 0 };
                        const pmc = h.shares > 0 ? h.costBasis / h.shares : 0;
                        const sellCostBasis = sellQty * pmc;
                        const proceeds = (t.amount || (t.quantity * t.price - t.commission - t.tax)) / t.exchangeRate;
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
    router.get('/analytics/dividends', requireAuth, (req, res) => {
        try {
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
                allDividends = allDividends.concat(divs.map(d => ({
                    id:          d.id,
                    assetTicker: d.assetTicker,
                    name:        d.name,
                    isin:        d.isin,
                    assetType:   d.assetType,
                    date:        d.date,
                    amount:      d.amount,          // Netto
                    tax:         d.tax || 0,        // Tassazione
                    gross:       (d.amount || 0) + (d.tax || 0), // Lordo calcolato
                    portfolioId: d.portfolioId,
                    portfolioName: p.name
                })));
            }
            allDividends.sort((a, b) => new Date(b.date) - new Date(a.date));
            res.json(allDividends);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/dividend-projections
    router.get('/analytics/dividend-projections', requireAuth, async (req, res) => {
        try {
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
                LEFT JOIN assets a ON t.assetTicker = a.ticker
                WHERE pu.user_id = ?
                GROUP BY ticker HAVING balance > 0.0001
            `).all(req.user.id);

            const allDivTx = database.db.prepare(`
                SELECT t.id as txId,
                       COALESCE(NULLIF(NULLIF(t.assetTicker, 'null'), ''), 'Sconosciuto') as ticker,
                       t.date, t.amount, t.quantity, t.price, t.tax, t.exchangeRate, p.currency as portCurrency
                FROM transactions t 
                JOIN portfolios p ON t.portfolioId = p.id 
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE t.type = 'DIVIDEND' AND t.date LIKE ? AND pu.user_id = ?
            `).all(currentYear + '-%', req.user.id);

            const savedProjections = database.db.prepare(`SELECT * FROM dividend_projections WHERE year = ? AND user_id = ?`).all(currentYear, req.user.id);
            const taxRatesRaw = database.db.prepare(`SELECT asset_type, rate FROM tax_rates WHERE user_id = ?`).all(req.user.id);
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
                const pos = openPositions.find(p => p.ticker === d.ticker);
                if (!pos) return;

                const m = parseInt(d.date.split('-')[1]) - 1;
                const amtEUR = toEUR(d.amount || (d.quantity * d.price - (d.tax || 0)), d.portCurrency, d.exchangeRate);
                actualByMonth[m] += amtEUR;
                totalReceived += amtEUR;
                tickersByMonth[m].add(d.ticker);
                
                const gross = amtEUR + toEUR(d.tax || 0, d.portCurrency, d.exchangeRate);
                
                let realYield = 0;
                if (pos && pos.currentPrice > 0 && pos.balance > 0) {
                    const priceInEUR = (pos.assetCurrency === 'USD' && liveRate > 0) ? pos.currentPrice / liveRate : pos.currentPrice;
                    const positionValueEUR = pos.balance * priceInEUR;
                    if (positionValueEUR > 0) {
                        realYield = gross / positionValueEUR;
                    }
                }

                listItems.push({
                    id: null, txId: d.txId, ticker: d.ticker, name: pos.name, isin: pos.isin, assetType: pos.assetType, date: d.date, tag: 'REGISTRATO',
                    amount: null, totalAmount: amtEUR, gross, tax: d.tax || 0, annualProjected: 0, yield: 0, realYield
                });
            });

            savedProjections.forEach(p => {
                const m = parseInt(p.exDate.split('-')[1]) - 1;
                
                let grossEUR = p.gross;
                let taxEUR = p.tax;
                let netEUR = p.totalAmount;

                if (grossEUR === 0 && netEUR > 0 && p.tag !== 'STORICO' && p.tag !== 'SIMULATO') {
                    grossEUR = p.totalAmount;
                    const asset = openPositions.find(op => op.ticker === p.ticker);
                    const assetType = asset ? asset.assetType : 'Azioni';
                    let taxRate = taxMap[assetType];
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
                const asset = openPositions.find(op => op.ticker === p.ticker);
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

            res.json({
                year: currentYear,
                totalExpected: totalReceived + totalExpected,
                totalReceived,
                totalRemaining: totalExpected,
                months,
                assets: listItems.sort((a,b) => new Date(b.date) - new Date(a.date)),
                openTickers: openPositions.map(p => ({ ticker: p.ticker, name: p.name }))
            });
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

            const projections = database.db.prepare(`
                SELECT SUM(dp.totalAmount) as total, COUNT(*) as count 
                FROM dividend_projections dp
                WHERE dp.user_id = ? AND dp.exDate LIKE ?
            `).get(req.user.id, yearMonth + '%');

            const received = database.db.prepare(`
                SELECT SUM(t.amount) as total, COUNT(*) as count 
                FROM transactions t
                JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
                WHERE pu.user_id = ? AND t.type = 'DIVIDEND' AND t.date LIKE ?
            `).get(req.user.id, yearMonth + '%');

            const totalAmount = (projections.total || 0) + (received.total || 0);
            const totalCount = (projections.count || 0) + (received.count || 0);

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
                todayAssets: exDateTodayAssets
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
            const { range = '1Y', portfolioIds } = req.query;
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

            const portfolios = database.db.prepare(`
                SELECT p.* FROM portfolios p
                JOIN portfolio_users pu ON p.id = pu.portfolio_id
                WHERE pu.user_id = ? ${portfolioFilter}
            `).all(...params);
            if (portfolios.length === 0) return res.json({ error: 'No portfolios found' });

            const pIdsForQuery = portfolios.map(p => p.id);
            const txPlaceholders = pIdsForQuery.map(() => '?').join(',');
            const allTransactions = database.db.prepare(`
                SELECT t.* FROM transactions t
                WHERE t.portfolioId IN (${txPlaceholders})
                ORDER BY t.date ASC
            `).all(...pIdsForQuery);
            const assets = database.db.prepare('SELECT * FROM assets').all();
            const assetMap = Object.fromEntries(assets.map(a => [a.ticker, a]));

            const today = new Date();

            let startDate;
            switch (range) {
                case '1M':
                    startDate = new Date(today);
                    startDate.setMonth(today.getMonth() - 1);
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
                    startDate = allTransactions.length > 0 ? new Date(allTransactions[0].date) : new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
                    break;
                default:
                    startDate = new Date(today);
                    startDate.setFullYear(today.getFullYear() - 1);
            }

            const dateStrStart = startDate.toISOString().split('T')[0];
            const dateStrEnd = today.toISOString().split('T')[0];

            const portfolioData = await calculatePerformanceHistory(
                selectedPIds && selectedPIds.length > 0 ? selectedPIds : pIdsForQuery,
                range, false, true, null, req.user.id
            );
            if (!portfolioData || !portfolioData.dataPoints || portfolioData.dataPoints.length === 0) {
                 return res.json({ error: 'No performance data' });
            }

            const fetchBenchmark = async (ticker) => {
                try {
                    const chart = await yahooFinance.chart(ticker, {
                        period1: dateStrStart,
                        period2: dateStrEnd,
                        interval: '1mo'
                    });
                    if (chart && chart.quotes && chart.quotes.length > 0) {
                        const firstPrice = chart.quotes[0].adjclose || chart.quotes[0].close;
                        return chart.quotes.map(h => ({
                            date: new Date(h.date).toISOString().split('T')[0].substring(0, 7),
                            value: ((h.adjclose || h.close) / (firstPrice || 1)) * 100
                        }));
                    }
                } catch (e) {
                    console.warn(`Failed benchmark fetch for ${ticker}:`, e.message);
                }
                return [];
            };

            const [sp500, msci] = await Promise.all([fetchBenchmark('^GSPC'), fetchBenchmark('URTH')]);

            const downsampleToMonthly = (daily) => {
                const monthly = [];
                let currentMonthEvents = [];
                for (let i = 0; i < daily.length; i++) {
                    const day = daily[i];
                    const mStr = day.date.substring(0, 7);
                    if (day.events) currentMonthEvents.push(...day.events);
                    
                    const next = daily[i+1];
                    if (!next || next.date.substring(0, 7) !== mStr) {
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

            const monthlyGlobal = downsampleToMonthly(portfolioData.dataPoints);
            const monthlyIndividual = {};
            for (const pid in portfolioData.individual) {
                const p = portfolios.find(port => port.id == pid);
                monthlyIndividual[pid] = {
                    id: pid,
                    name: p ? p.name : pid,
                    history: downsampleToMonthly(portfolioData.individual[pid]),
                    metrics: {}
                };
            }

            const normalizeRelative = (history) => {
                if (history.length === 0) return [];
                let prevVal = null;
                let prevNet = null;
                let twr = 100;
                
                return history.map((p, idx) => {
                    if (idx === 0) {
                        prevVal = p.value;
                        prevNet = p.netDeposits;
                        twr = 100;
                    } else {
                        const netFlow = (p.netDeposits || 0) - (prevNet || 0);
                        const denominator = (prevVal || 0) + netFlow;
                        if (denominator > 0) {
                            twr = twr * (p.value / denominator);
                        }
                        prevVal = p.value;
                        prevNet = p.netDeposits;
                    }
                    return {
                        date: p.date.substring(0, 7),
                        value: parseFloat(twr.toFixed(2)),
                        absoluteValue: Math.round(p.value),
                        profit: Math.round(p.profit),
                        netDeposits: p.netDeposits || 0
                    };
                });
            };

            const normalizedGlobal = normalizeRelative(monthlyGlobal);
            const lastGlobal = normalizedGlobal.length > 0 ? normalizedGlobal[normalizedGlobal.length - 1] : null;
            const firstGlobal = normalizedGlobal.length > 0 ? normalizedGlobal[0] : null;
            const riskFreeMonthly = 0.002;

            const fxRates = {};
            const usdRates = database.db.prepare("SELECT date, price FROM asset_quotes WHERE ticker='EURUSD=X'").all();
            const usdMap = Object.fromEntries(usdRates.map(r => [r.date, r.price]));
            fxRates['USD'] = usdMap;

            for (const pid in monthlyIndividual) {
                const p = monthlyIndividual[pid];
                const portfolioObj = portfolios.find(port => port.id == pid);
                p.history = normalizeRelative(p.history);
                const last = p.history.length > 0 ? p.history[p.history.length - 1] : null;
                const first = p.history.length > 0 ? p.history[0] : null;
                
                const periodProfit = (first && last) ? last.profit - first.profit : (last ? last.profit : 0);
                const periodNetFlow = (first && last) ? last.netDeposits - first.netDeposits : (last ? last.netDeposits : 0);
                const periodStartValue = first ? first.absoluteValue : 0;
                const currentVal = last ? last.absoluteValue : 0;
                
                const roi = calculateROI(currentVal, periodStartValue + periodNetFlow, periodProfit);
                
                const indHistory = portfolioData.individual[pid];
                let indTwr = 0;
                if (indHistory.length >= 2) {
                    const subPeriods = [];
                    for (let i = 1; i < indHistory.length; i++) {
                        const prev = indHistory[i-1];
                        const curr = indHistory[i];
                        subPeriods.push({
                            startingValue: prev.value,
                            endingValue: curr.value,
                            netCashFlow: curr.netDeposits - prev.netDeposits
                        });
                    }
                    indTwr = calculateTWR(subPeriods);
                }

                const pTxs = allTransactions.filter(t => t.portfolioId == pid && ['DEPOSIT', 'WITHDRAWAL'].includes(t.type));
                const pFlows = pTxs.map(t => {
                    const rate = (portfolioObj && portfolioObj.currency === 'USD') ? (fxRates['USD']?.[t.date] || 1) : 1;
                    const amt = (t.amount || (t.quantity * t.price)) / rate;
                    return { date: new Date(t.date), amount: t.type === 'DEPOSIT' ? -amt : amt };
                });
                pFlows.push({ date: new Date(), amount: currentVal });
                pFlows.sort((a,b) => a.date - b.date);
                const indXirr = pFlows.length >= 2 ? (xirr(pFlows) || 0) : 0;

                p.metrics = {
                    totalROI: roi,
                    twr: indTwr,
                    xirr: indXirr,
                    currentValue: currentVal,
                    contribution: (lastGlobal && lastGlobal.absoluteValue > 0) ? 
                        (currentVal / lastGlobal.absoluteValue) : 0,
                    sharpeRatio: (() => {
                        const returns = [];
                        for (let i = 1; i < p.history.length; i++) {
                            const prev = p.history[i-1].value;
                            const curr = p.history[i].value;
                            if (prev > 0) returns.push((curr / prev) - 1);
                        }
                        if (returns.length < 2) return 0;
                        const m = returns.reduce((a, b) => a + b, 0) / returns.length;
                        const s = Math.sqrt(returns.map(x => Math.pow(x - m, 2)).reduce((a, b) => a + b, 0) / returns.length);
                        return s > 0 ? (m - riskFreeMonthly) / s : 0;
                    })()
                };
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
                    if (ticker.startsWith('CD_')) {
                        curPx = shares > 0 ? (holdingsCost[ticker] || 0) / shares : 0;
                    }
                    
                    const value = shares * (curPx / lastExRate);

                    const geo = a.country || 'Unknown';
                    const type = a.type || 'Other';
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
                    .reduce((sum, t) => sum + (t.amount || (t.quantity * t.price - t.commission - t.tax)) / (t.exchangeRate || 1), 0);
                dividends.push({ date: mStr, amount: monthlyDiv });
            }

            const currentTotalValue = lastGlobal ? lastGlobal.absoluteValue : 0;
            const currentProfit = lastGlobal ? lastGlobal.profit : 0;
            const currentNetDeposits = lastGlobal ? lastGlobal.netDeposits : 0;

            const gPeriodNetFlow = (firstGlobal && lastGlobal) ? lastGlobal.netDeposits - firstGlobal.netDeposits : (lastGlobal ? lastGlobal.netDeposits : 0);
            const gPeriodStartValue = firstGlobal ? firstGlobal.absoluteValue : 0;
            const gPeriodProfit = (firstGlobal && lastGlobal) ? lastGlobal.profit - firstGlobal.profit : (lastGlobal ? lastGlobal.profit : 0);
            
            const totalROI = calculateROI(currentTotalValue, gPeriodStartValue + gPeriodNetFlow, gPeriodProfit);

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

            let twrSeries = [];
            const twrValue = (() => {
                const data = portfolioData.dataPoints;
                if (data.length < 2) return 0;
                const subPeriods = [];
                let cumulativeTwr = 1;
                twrSeries.push({ date: data[0].date, value: 100, events: data[0].events });

                for (let i = 1; i < data.length; i++) {
                    const prev = data[i-1];
                    const curr = data[i];
                    const netFlow = curr.netDeposits - prev.netDeposits;
                    const hpr = prev.value > 0.01 ? (curr.value - netFlow - prev.value) / prev.value : 0;
                    cumulativeTwr *= Math.max(0, 1 + hpr);
                    
                    twrSeries.push({
                        date: curr.date,
                        value: Math.max(0, cumulativeTwr * 100),
                        events: curr.events
                    });

                    subPeriods.push({
                        startingValue: prev.value,
                        endingValue: curr.value,
                        netCashFlow: netFlow
                    });
                }
                return calculateTWR(subPeriods);
            })();

            const monthlyTwr = downsampleToMonthly(twrSeries);

            let bestAsset = { ticker: '-', profit: -Infinity };
            for (const [ticker, a] of Object.entries(assetMap)) {
                if (ticker === 'CASH') continue;
                let unrealized = 0;
                let realized = 0;
                let qty = 0;
                let costBasis = 0;
                const tks = allTransactions.filter(t => t.assetTicker === ticker);
                for (const t of tks) {
                    const total = (t.amount || (t.quantity * t.price + (t.type==='BUY'?1:-1)*(t.commission+t.tax))) / (t.exchangeRate||1);
                    if (t.type === 'BUY') {
                        qty += t.quantity;
                        costBasis += total;
                    } else if (t.type === 'SELL') {
                        const avgCost = qty > 0 ? costBasis / qty : 0;
                        realized += total - (t.quantity * avgCost);
                        qty -= t.quantity;
                        costBasis -= (t.quantity * avgCost);
                    } else if (t.type === 'DIVIDEND') {
                        realized += (t.amount || (t.quantity * t.price - t.commission - t.tax)) / (t.exchangeRate || 1);
                    }
                }
                unrealized = qty * (a.currentPrice / (tks.filter(tx=>tx.exchangeRate).at(-1)?.exchangeRate||1)) - costBasis;
                const totalProfit = realized + unrealized;
                if (totalProfit > bestAsset.profit) bestAsset = { ticker, profit: totalProfit, name: a.name };
            }

            const annualGainsMap = {};
            const currentYearString = today.getFullYear().toString();
            const liveRateValReports = await getEurUsdRate();

            for (const p of portfolios) {
                try {
                    const details = await getPortfolioDetails(p.id, liveRateValReports);
                    const rate = (p.currency === 'USD') ? liveRateValReports : 1;
                    
                    for (const pos of details.closedPositions) {
                        const y = pos.year;
                        if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                        annualGainsMap[y].realized += pos.realizedGain / rate;
                    }
                    
                    for (const group of details.dividendGroups) {
                        const y = group.year;
                        if (!annualGainsMap[y]) annualGainsMap[y] = { year: y, realized: 0, dividends: 0, unrealized: 0 };
                        annualGainsMap[y].dividends += group.total / rate;
                    }
                    
                    const pUnrealized = details.holdings.reduce((sum, h) => sum + (h.unrealizedGain || 0), 0);
                    if (!annualGainsMap[currentYearString]) annualGainsMap[currentYearString] = { year: currentYearString, realized: 0, dividends: 0, unrealized: 0 };
                    annualGainsMap[currentYearString].unrealized += pUnrealized / rate;
                    
                } catch (e) {
                    console.error(`Error aggregating annual gains for portfolio ${p.id}:`, e);
                }
            }

            const annualGains = Object.values(annualGainsMap).sort((a,b) => b.year - a.year);

            // ── Per-Asset Cumulative Gains ────────────────────────────────────────
            const assetGainsMap = {};
            const liveRate = await getEurUsdRate();

            for (const [ticker, a] of Object.entries(assetMap)) {
                if (ticker === 'CASH' || ticker.startsWith('CASH')) continue;
                const tks = allTransactions.filter(t => t.assetTicker === ticker);
                if (tks.length === 0) continue;

                const fx = (t) => t.exchangeRate || 1;
                let qty = 0;
                let totalCostAsset = 0;   // asset currency
                let realizedGain = 0;     // EUR
                let dividends = 0;        // EUR
                let totalInvested = 0;    // EUR (all-time sum of BUYs)

                const sortedTks = [...tks].sort((a,b) => new Date(a.date) - new Date(b.date));
                for (const t of sortedTks) {
                    const q = Math.abs(t.quantity || 0);
                    const p = t.price || 0;
                    const comm = t.commission || 0;
                    const tax = t.tax || 0;
                    const fxRate = fx(t);

                    if (t.type === 'BUY') {
                        const costAsset = t.amount ? (Math.abs(t.amount) * fxRate) : (q * p + comm + tax);
                        const costEur = costAsset / fxRate;
                        totalCostAsset += costAsset;
                        qty += q;
                        totalInvested += costEur;
                    } else if (t.type === 'SELL' && qty > 0) {
                        const avgCostAsset = totalCostAsset / qty;
                        const proceeds = t.amount ? Math.abs(t.amount) : ((q * p - comm - tax) / fxRate);
                        const costBasisEur = (q * avgCostAsset) / fxRate;
                        realizedGain += proceeds - costBasisEur;
                        totalCostAsset -= q * avgCostAsset;
                        qty -= q;
                        if (Math.abs(qty) < 0.00001) { qty = 0; totalCostAsset = 0; }
                    } else if (t.type === 'DIVIDEND') {
                        const net = t.amount ? (Math.abs(t.amount) / fxRate) : ((q * p - comm - tax) / fxRate);
                        dividends += net;
                    }
                    // NOTE: SPLIT transactions are audit markers only.
                    // The split route already retroactively adjusts all historical
                    // BUY/SELL quantities and prices in the DB, so we must NOT
                    // re-apply the ratio here.
                }

                // Unrealized on currently open position
                let unrealizedGain = 0;
                if (qty > 0.0001 && a.currentPrice > 0) {
                    const lastFx = tks.filter(t => t.exchangeRate).at(-1)?.exchangeRate || 1;
                    const curValEur = (qty * a.currentPrice) / lastFx;
                    const curCostEur = totalCostAsset / lastFx;
                    unrealizedGain = curValEur - curCostEur;
                }

                const totalGain = realizedGain + dividends + unrealizedGain;
                if (totalInvested < 0.01 && totalGain === 0) continue;
                const gainPct = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;

                assetGainsMap[ticker] = {
                    ticker,
                    name: a.name || ticker,
                    type: a.type || 'Stock',
                    currency: a.currency || 'EUR',
                    realizedGain: Math.round(realizedGain * 100) / 100,
                    dividends: Math.round(dividends * 100) / 100,
                    unrealizedGain: Math.round(unrealizedGain * 100) / 100,
                    totalGain: Math.round(totalGain * 100) / 100,
                    totalInvested: Math.round(totalInvested * 100) / 100,
                    gainPct: Math.round(gainPct * 100) / 100,
                    hasOpenPosition: qty > 0.0001
                };
            }
            const assetGains = Object.values(assetGainsMap).sort((a,b) => b.totalGain - a.totalGain);


            res.json({
                performance: {
                    portfolio: normalizedGlobal,
                    twr: monthlyTwr,
                    individual: monthlyIndividual,
                    sp500,
                    msci
                },
                diversification,
                dividends,
                annualGains,
                assetGains,
                metrics: {
                    totalROI,
                    totalGain: currentProfit,
                    annualizedROI: Math.pow(1 + totalROI, 1 / (Math.max(1, monthlyGlobal.length) / 12)) - 1,
                    xirr: xirrValue,
                    twr: twrValue,
                    bestAsset: bestAsset.ticker === '-' ? '-' : `${bestAsset.name} (${bestAsset.ticker})`,
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
                    dividendYield: currentTotalValue > 0 ? dividends.reduce((s, x) => s + x.amount, 0) / currentTotalValue : 0
                }
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/analytics/ai-report
    router.post('/analytics/ai-report', requireAuth, async (req, res) => {
        try {
            const { contextData } = req.body;
            const settings = database.getSettings(1);
            const engine = settings.aiReportEngine || 'Gemini_Free';
            const promptTemplate = settings.aiReportPrompt || 'Sei un analista finanziario esperto. Analizza il seguente portafoglio basandoti sui dati forniti (lista degli asset con PMC, prezzo attuale, gain, diversificazione, asset allocation e tutte le transizioni storiche). Fornisci un report strutturato in due sezioni:\n\n1. Analisi delle posizioni aperte (rischio, diversificazione e prospettive).\n2. Analisi delle posizioni chiuse e dei dividendi suddivisi per anno (valutazione della performance storica e della continuità dei dividendi).';
            
            // Get all transactions
            const txs = database.db.prepare('SELECT assetTicker, type, date, quantity, price, amount, currency, exchangeRate, commission, tax FROM transactions WHERE user_id = ? ORDER BY date ASC').all(req.user.id);
            
            // Get PMC and current price from all portfolios
            const portfolios = database.db.prepare('SELECT id FROM portfolios WHERE user_id = ?').all(req.user.id);
            const openPositions = [];
            
            for (const p of portfolios) {
                // Not calling full getPortfolioDetails to avoid circular deps if not available, 
                // but we can query openMap logic or just rely on assetGains + txs which the AI can understand.
                // However, doing a quick query for current prices is easy:
                // Actually, the user asked to have PMC, Current Price, Gain, etc.
                // contextData already has assetGains which has realizedGain, unrealizedGain, totalGain.
            }
            
            // Let's just pass contextData (which has gains) and transactions. The AI can deduce PMC from txs, 
            // but it's better to explicitly provide it.
            // Since we don't have getPortfolioDetails imported here, we can calculate PMC quickly:
            const pmcMap = {};
            for (const t of txs) {
                if (!t.assetTicker) continue;
                if (!pmcMap[t.assetTicker]) pmcMap[t.assetTicker] = { shares: 0, cost: 0 };
                if (t.type === 'BUY') {
                    pmcMap[t.assetTicker].shares += (t.quantity || 0);
                    pmcMap[t.assetTicker].cost += (t.quantity || 0) * (t.price || 0);
                } else if (t.type === 'SELL') {
                    pmcMap[t.assetTicker].shares -= (t.quantity || 0);
                    const avg = pmcMap[t.assetTicker].shares > 0 ? (pmcMap[t.assetTicker].cost / (pmcMap[t.assetTicker].shares + (t.quantity || 0))) : 0;
                    pmcMap[t.assetTicker].cost -= (t.quantity || 0) * avg;
                }
            }
            
            const enhancedContext = {
                portfolioStats: JSON.parse(contextData),
                pmcData: Object.fromEntries(
                    Object.entries(pmcMap)
                    .filter(([, data]) => data.shares > 0)
                    .map(([ticker, data]) => [ticker, { pmc: data.cost / data.shares, shares: data.shares }])
                ),
                transactionsHistory: txs
            };
            
            const fullPrompt = `${promptTemplate}\n\nDATI PORTAFOGLIO:\n${JSON.stringify(enhancedContext)}`;
            
            const aiResponse = await aiService.callAIModel(engine, fullPrompt, settings);
            
            // Save the report in the user's settings
            const now = new Date().toISOString();
            database.setSetting(req.user.id, 'lastAiReportText', aiResponse.text);
            database.setSetting(req.user.id, 'lastAiReportDate', now);
            
            res.json({ text: aiResponse.text, date: now });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/analytics/ai-report/latest
    router.get('/analytics/ai-report/latest', requireAuth, (req, res) => {
        try {
            const userSettings = database.getSettings(req.user.id);
            if (userSettings.lastAiReportText && userSettings.lastAiReportDate) {
                res.json({ text: userSettings.lastAiReportText, date: userSettings.lastAiReportDate });
            } else {
                res.json({ text: null, date: null });
            }
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
