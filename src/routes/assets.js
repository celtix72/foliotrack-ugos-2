const express = require('express');

/**
 * Assets & Fundamentals Router
 * Dependencies injected via factory function.
 */
module.exports = function(dependencies) {
    const router = express.Router();
    const {
        requireAuth,
        requireAdmin,
        requirePortfolioAccess,
        database,
        logger,
        yahooFinance,
        getEurUsdRate,
        getMarketStatus,
        isUSMarket,
        fetchAssetMetadata,
        clearPerformanceCache,
        callAIModel,
        parseAIResponse,
        notifyUser,
        APP_VERSION,
        triggerHistoryRebuild,
        recalculateAllPortfoliosWithOverrides,
        historicalPricesCache,
        isValidISIN,
        sanitizeTicker,
        B_ITA,
    } = dependencies;

    const fundamentalsCache = new Map();
    const FUNDAMENTALS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
// FUNDAMENTALS API  — PEG Ratio, FCF, indicatori fondamentali
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cache in-memory per i dati fondamentali.
 * TTL: 6 ore (i fondamentali non cambiano spesso).
 */

/**
 * GET /api/fundamentals/:ticker
 *
 * Restituisce:
 *  - pegRatio         : Forward PEG (P/E forward / EPS growth 5Y), da defaultKeyStatistics
 *  - pegRatioTrend    : PEG per periodo forward da earningsTrend (0q, +1q, 0y, +1y)
 *  - pegHistorical    : PEG storico calcolato manualmente (prezzo / EPS TTM / crescita EPS)
 *  - fcfTTM           : Free Cash Flow TTM corrente
 *  - operatingCFTTM   : Operating Cash Flow TTM corrente
 *  - fcfAnnual        : Storico FCF annuale (fundamentalsTimeSeries)
 *  - fcfQuarterly     : Storico FCF trimestrale (fundamentalsTimeSeries)
 *  - financialData    : Margini, ROE, ROA, crescita ricavi/utili, target price
 *  - earningsHistory  : Storico EPS effettivi (ultimi 4 quarter)
 */
async function getAssetFundamentals(ticker) {
    if (!ticker) throw new Error('Ticker mancante');
    ticker = ticker.toUpperCase();

    

    // Check cache
    const cached = fundamentalsCache.get(ticker);
    if (cached && (Date.now() - cached.ts) < FUNDAMENTALS_CACHE_TTL_MS) {
        logger.info(`[Fundamentals] Cache hit: ${ticker}`);
        return res.json(cached.data);
    }

    logger.info(`[Fundamentals] Fetching data for: ${ticker}`);

    const result = {
        ticker,
        fetchedAt: new Date().toISOString(),
        pegRatio: null,
        pegRatioTrend: [],
        pegHistorical: [],
        fcfTTM: null,
        operatingCFTTM: null,
        fcfAnnual: [],
        fcfQuarterly: [],
        financialData: {},
        earningsHistory: [],
        errors: []
    };

    // ── 1. defaultKeyStatistics: PEG forward + FCF TTM ──────────────────────
    try {
        const ks = await yahooFinance.quoteSummary(ticker, {
            modules: ['defaultKeyStatistics', 'summaryDetail', 'calendarEvents']
        });
        const s = ks.defaultKeyStatistics || {};
        result.pegRatio        = s.pegRatio       ?? null;
        result.fcfTTM          = s.freeCashflow   ?? null;
        result.operatingCFTTM  = s.operatingCashflow ?? null;
        const sd = ks.summaryDetail || {};
        const ce = ks.calendarEvents || {};
        result.summaryDetail = sd;
        result.calendarEvents = ce;
        result.keyStats = {
            forwardPE:      s.forwardPE       ?? null,
            trailingEps:    s.trailingEps     ?? null,
            forwardEps:     s.forwardEps      ?? null,
            earningsGrowth: s.earningsGrowth  ?? null,
            revenueGrowth:  s.revenueGrowth   ?? null,
            priceToBook:    s.priceToBook     ?? null,
            enterpriseValue:s.enterpriseValue ?? null,
            enterpriseToEbitda:    s.enterpriseToEbitda    ?? null,
            enterpriseToRevenue:   s.enterpriseToRevenue   ?? null,
            '52WeekChange':        s['52WeekChange']        ?? null,
            sharesOutstanding:     s.sharesOutstanding      ?? null,
            bookValue:             s.bookValue              ?? null,
            netIncomeToCommon:     s.netIncomeToCommon      ?? null
        };
    } catch (e) {
        logger.warn(`[Fundamentals] defaultKeyStatistics error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'defaultKeyStatistics', error: e.message });
    }

    // ── 2. financialData: margini, crescita, target price ───────────────────
    try {
        const fd = await yahooFinance.quoteSummary(ticker, {
            modules: ['financialData']
        });
        const f = fd.financialData || {};
        result.fcfTTM         = result.fcfTTM ?? f.freeCashflow ?? null;
        result.operatingCFTTM = result.operatingCFTTM ?? f.operatingCashflow ?? null;
        result.financialData  = {
            currentPrice:        f.currentPrice        ?? null,
            targetMeanPrice:     f.targetMeanPrice      ?? null,
            targetHighPrice:     f.targetHighPrice      ?? null,
            targetLowPrice:      f.targetLowPrice       ?? null,
            recommendationMean:  f.recommendationMean   ?? null,
            recommendationKey:   f.recommendationKey    ?? null,
            numberOfAnalysts:    f.numberOfAnalystOpinions ?? null,
            ebitdaMargins:       f.ebitdaMargins        ?? null,
            profitMargins:       f.profitMargins        ?? null,
            grossMargins:        f.grossMargins         ?? null,
            operatingMargins:    f.operatingMargins     ?? null,
            returnOnAssets:      f.returnOnAssets       ?? null,
            returnOnEquity:      f.returnOnEquity       ?? null,
            totalCash:           f.totalCash            ?? null,
            totalDebt:           f.totalDebt            ?? null,
            totalRevenue:        f.totalRevenue         ?? null,
            revenueGrowth:       f.revenueGrowth        ?? null,
            earningsGrowth:      f.earningsGrowth       ?? null,
            ebitda:              f.ebitda               ?? null,
            debtToEquity:        f.debtToEquity         ?? null,
            currentRatio:        f.currentRatio         ?? null,
            quickRatio:          f.quickRatio           ?? null,
            freeCashflow:        f.freeCashflow         ?? null,
            operatingCashflow:   f.operatingCashflow    ?? null
        };
    } catch (e) {
        logger.warn(`[Fundamentals] financialData error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'financialData', error: e.message });
    }

    // ── 3. earningsTrend: PEG forward per periodo ───────────────────────────
    try {
        const et = await yahooFinance.quoteSummary(ticker, {
            modules: ['earningsTrend']
        });
        const trend = et.earningsTrend?.trend || [];
        result.pegRatioTrend = trend.map(t => ({
            period:          t.period,
            endDate:         t.endDate ? (t.endDate instanceof Date ? t.endDate.toISOString().split('T')[0] : t.endDate) : null,
            pegRatio:        t.pegRatio        ?? null,
            growth:          t.growth?.raw     ?? t.growth   ?? null,
            epsEstimateMean: t.earningsEstimate?.avg?.raw ?? t.earningsEstimate?.avg ?? null,
            epsEstimateHigh: t.earningsEstimate?.high?.raw ?? t.earningsEstimate?.high ?? null,
            epsEstimateLow:  t.earningsEstimate?.low?.raw  ?? t.earningsEstimate?.low  ?? null,
            revenueEstimateMean: t.revenueEstimate?.avg?.raw ?? t.revenueEstimate?.avg ?? null,
        }));
    } catch (e) {
        logger.warn(`[Fundamentals] earningsTrend error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'earningsTrend', error: e.message });
    }

    // ── 4. earningsHistory: storico EPS effettivi ───────────────────────────
    try {
        const eh = await yahooFinance.quoteSummary(ticker, {
            modules: ['earningsHistory']
        });
        const history = eh.earningsHistory?.history || [];
        result.earningsHistory = history.map(h => ({
            period:          h.period,
            date:            h.quarter ? (h.quarter instanceof Date ? h.quarter.toISOString().split('T')[0] : h.quarter) : null,
            epsActual:       h.epsActual?.raw    ?? h.epsActual    ?? null,
            epsEstimate:     h.epsEstimate?.raw  ?? h.epsEstimate  ?? null,
            epsDifference:   h.epsDifference?.raw ?? h.epsDifference ?? null,
            surprisePercent: h.surprisePercent?.raw ?? h.surprisePercent ?? null
        }));
    } catch (e) {
        logger.warn(`[Fundamentals] earningsHistory error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'earningsHistory', error: e.message });
    }

    // ── 5. FCF storico annuale (fundamentalsTimeSeries) ─────────────────────
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 6); // Ultimi 6 anni
        const cfAnnual = await yahooFinance.fundamentalsTimeSeries(ticker, {
            period1: from.toISOString().split('T')[0],
            type: 'annual',
            module: 'cash-flow'
        });
        result.fcfAnnual = (cfAnnual || []).map(item => {
            const fcf  = item.annualFreeCashFlow       ?? item.freeCashFlow       ?? null;
            const ocf  = item.annualOperatingCashFlow  ?? item.operatingCashFlow  ?? item.cashFlowFromContinuingOperatingActivities ?? null;
            const capex = item.annualCapitalExpenditure ?? item.capitalExpenditure ?? null;
            return {
                date:             item.date instanceof Date ? item.date.toISOString().split('T')[0] : (item.date ?? null),
                freeCashFlow:     fcf,
                operatingCashFlow: ocf,
                capitalExpenditure: capex,
                // Se FCF non è disponibile direttamente, calcolalo da OCF - CapEx
                fcfCalculated:    (fcf === null && ocf !== null && capex !== null) ? ocf - capex : null
            };
        }).filter(i => i.date);
    } catch (e) {
        logger.warn(`[Fundamentals] fundamentalsTimeSeries annual cash-flow error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'fundamentalsTimeSeries-annual', error: e.message });
    }

    // ── 5.1 Storico Finanziario Annuale (Revenue, Net Income, Price, P/E) ───
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 6);
        const p1 = from.toISOString().split('T')[0];
        
        const [finAnnual, chartData] = await Promise.all([
            yahooFinance.fundamentalsTimeSeries(ticker, { period1: p1, type: 'annual', module: 'financials' }).catch(() => null),
            yahooFinance.chart(ticker, { period1: p1, interval: '1mo' }).catch(() => null)
        ]);
        
        const prices = chartData?.quotes || [];
        
        result.historicalFinancials = (finAnnual || []).map(item => {
            const dateStr = item.date instanceof Date ? item.date.toISOString().split('T')[0] : (item.date ?? null);
            let closestPrice = null;
            if (dateStr && prices.length > 0) {
                const targetTime = new Date(dateStr).getTime();
                let minDiff = Infinity;
                for (const q of prices) {
                    if (!q.date || !q.close) continue;
                    const diff = Math.abs(new Date(q.date).getTime() - targetTime);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestPrice = q.close;
                    }
                }
            }
            
            const eps = item.dilutedEPS ?? item.basicEPS ?? null;
            const pe = (closestPrice !== null && eps !== null && eps > 0) ? (closestPrice / eps) : null;
            
            return {
                date: dateStr,
                totalRevenue: item.totalRevenue ?? item.operatingRevenue ?? null,
                netIncome: item.netIncome ?? item.netIncomeCommonStockholders ?? null,
                eps: eps,
                price: closestPrice,
                pe: pe
            };
        }).filter(i => i.date && (i.totalRevenue !== null || i.netIncome !== null));
        
        // Append current year (TTM)
        if (result.financialData && result.keyStats) {
            const tr = result.financialData.totalRevenue;
            const ni = result.keyStats.netIncomeToCommon;
            const eps = result.keyStats.trailingEps;
            const price = result.financialData.currentPrice;
            if (tr || ni) {
                result.historicalFinancials.push({
                    date: 'TTM',
                    totalRevenue: tr ?? null,
                    netIncome: ni ?? null,
                    eps: eps ?? null,
                    price: price ?? null,
                    pe: (price !== null && eps !== null && eps > 0) ? (price / eps) : null
                });
            }
        }
    } catch (e) {
        logger.warn(`[Fundamentals] fundamentalsTimeSeries annual financials error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'fundamentalsTimeSeries-financials', error: e.message });
    }

    // ── 6. FCF storico trimestrale (fundamentalsTimeSeries) ─────────────────
    try {
        const from = new Date();
        from.setFullYear(from.getFullYear() - 3); // Ultimi 3 anni
        const cfQuarterly = await yahooFinance.fundamentalsTimeSeries(ticker, {
            period1: from.toISOString().split('T')[0],
            type: 'quarterly',
            module: 'cash-flow'
        });
        result.fcfQuarterly = (cfQuarterly || []).map(item => {
            const fcf   = item.quarterlyFreeCashFlow       ?? item.freeCashFlow       ?? null;
            const ocf   = item.quarterlyOperatingCashFlow  ?? item.operatingCashFlow  ?? item.cashFlowFromContinuingOperatingActivities ?? null;
            const capex = item.quarterlyCapitalExpenditure ?? item.capitalExpenditure ?? null;
            return {
                date:              item.date instanceof Date ? item.date.toISOString().split('T')[0] : (item.date ?? null),
                freeCashFlow:      fcf,
                operatingCashFlow: ocf,
                capitalExpenditure: capex,
                fcfCalculated:     (fcf === null && ocf !== null && capex !== null) ? ocf - capex : null
            };
        }).filter(i => i.date);
    } catch (e) {
        logger.warn(`[Fundamentals] fundamentalsTimeSeries quarterly cash-flow error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'fundamentalsTimeSeries-quarterly', error: e.message });
    }

    // ── 7. PEG storico calcolato manualmente ────────────────────────────────
    // PEG = (Prezzo / EPS_trailing) / crescita_EPS_annua
    // Richiede: storico prezzi annuale + earningsHistory per EPS
    try {
        if (result.earningsHistory.length >= 2) {
            // Calcola crescita EPS annua dagli ultimi quarter disponibili
            const validEps = result.earningsHistory.filter(h => h.epsActual !== null).reverse();
            if (validEps.length >= 2) {
                // EPS TTM = somma ultimi 4 quarter (se disponibili 4)
                const last4 = validEps.slice(0, 4);
                const epsTTM = last4.reduce((sum, h) => sum + (h.epsActual || 0), 0);

                // Crescita EPS Y/Y: confronto last2 vs prev2
                if (validEps.length >= 4) {
                    const epsYoy1 = validEps[0].epsActual;
                    const epsYoy2 = validEps[validEps.length > 4 ? 4 : validEps.length - 1].epsActual;
                    if (epsYoy2 && epsYoy2 > 0 && epsYoy1 > 0) {
                        const epsGrowthRate = (epsYoy1 - epsYoy2) / Math.abs(epsYoy2); // decimale
                        const currentPrice = result.financialData.currentPrice;
                        if (currentPrice && epsTTM > 0 && epsGrowthRate > 0) {
                            const peTrailing = currentPrice / epsTTM;
                            const pegCalc    = peTrailing / (epsGrowthRate * 100); // crescita in %
                            result.pegHistorical.push({
                                date:           new Date().toISOString().split('T')[0],
                                peTrailing:     Math.round(peTrailing * 100) / 100,
                                epsTTM:         Math.round(epsTTM * 100) / 100,
                                epsGrowthRate:  Math.round(epsGrowthRate * 10000) / 100, // in %
                                pegCalculated:  Math.round(pegCalc * 100) / 100,
                                note:           'Calcolato da EPS trailing 4Q e crescita Y/Y'
                            });
                        }
                    }
                }
            }
        }
    } catch (e) {
        logger.warn(`[Fundamentals] PEG historical calc error for ${ticker}: ${e.message}`);
        result.errors.push({ module: 'peg-historical-calc', error: e.message });
    }

    // ── 8. Analisi Tecnica (da DB: assets.ai_reasoning) ──────────────────────
    try {
        const assetRow = database.db.prepare('SELECT ai_reasoning FROM assets WHERE ticker = ?').get(ticker);
        if (assetRow && assetRow.ai_reasoning) {
            const getAiParam = (text, param) => {
                if (!text) return null;
                const normalizedText = text.replace(/\\n/g, '\n');
                const escapedParam = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(?:\\-|\\•|\\*)\\s*${escapedParam}\\s*:\\s*([^\\n]+)`, 'i');
                let m = normalizedText.match(regex);
                if (m) return m[1].trim();
                
                const regex2 = new RegExp(`${escapedParam}\\s*:\\s*([^\\n]+)`, 'i');
                m = normalizedText.match(regex2);
                return m ? m[1].trim() : null;
            };

            const reasoning = assetRow.ai_reasoning;
            const trend = getAiParam(reasoning, 'Trend di fondo') || getAiParam(reasoning, 'View Operativa') || null;
            const buyZone = getAiParam(reasoning, 'Zona di Ingresso ideale (Buy)') || getAiParam(reasoning, 'Livello di Ingresso (Buy Zone)') || null;
            const support = getAiParam(reasoning, 'Area di Supporto critico') || null;
            const resistance = getAiParam(reasoning, 'Area di Resistenza critica') || null;

            if (trend || buyZone || support || resistance) {
                result.technicalAnalysis = {
                    trend,
                    buyZone,
                    support,
                    resistance
                };
            }
        }
    } catch (e) {
        logger.warn(`[Fundamentals] Technical analysis fetch error for ${ticker}: ${e.message}`);
    }

    // Salva in cache
    fundamentalsCache.set(ticker, { ts: Date.now(), data: result });

    logger.info(`[Fundamentals] Done for ${ticker}: PEG=${result.pegRatio}, FCF TTM=${result.fcfTTM}, FCF annual records=${result.fcfAnnual.length}, quarterly=${result.fcfQuarterly.length}`);
    return result;
}

router.get('/fundamentals/:ticker', requireAuth, async (req, res) => {
    try {
        const data = await getAssetFundamentals(req.params.ticker);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * DELETE /api/fundamentals/:ticker/cache
 * Invalida la cache per un ticker specifico (utile per forzare refresh).
 */
router.delete('/fundamentals/:ticker/cache', requireAuth, (req, res) => {
    const ticker = (req.params.ticker || '').toUpperCase();
    const deleted = fundamentalsCache.delete(ticker);
    res.json({ ticker, cacheCleared: deleted });
});

// ════════════════════════════════════════════════════════════════════════════
// ASSETS API
// ════════════════════════════════════════════════════════════════════════════

router.get('/assets', requireAuth, async (req, res) => {
    const userId = req.user.id;
    // Return all assets except CASH, with a flag indicating if they have an active position for THIS user
    const rows = database.db.prepare(`
        SELECT a.id, a.ticker, a.name, a.type, a.exchange, a.currency, a.currentPrice, 
               a.changePercent, a.changeValue, a.pe, a.country, a.isManual, a.updatedAt, 
               a.dataSource, a.isin, a.lastUpdateError, a.quoteDate, a.forwardPE, 
               a.dividendYield, a.eps, a.beta, a.nextDividendDate, 
               a.preMarketChangePercent, a.postMarketChangePercent, a.isMonitored,
               CASE WHEN t.balance IS NOT NULL AND t.balance > 0.0001 THEN 1 ELSE 0 END as hasPosition,
               IFNULL(t.balance, 0) as totalQuantity,
               IFNULL(t.totalCostAsset, 0) as totalCostAssetCurr,
               CASE WHEN uw.user_id IS NOT NULL THEN 1 ELSE 0 END as inWatchlist,
               uw.targetPrice as userTargetPrice,
               uw.stopLoss as userStopLoss,
               uw.volatilityAlert as userVolatilityAlert,
               a.ai_action as aiAction,
               a.ai_reasoning as aiReasoning,
               a.ai_updated_at as aiUpdatedAt,
               (SELECT COUNT(*) FROM asset_ai_history ah WHERE ah.ticker = a.ticker) as aiHistoryCount
        FROM assets a
        LEFT JOIN (
            SELECT t.assetTicker, 
                   SUM(CASE WHEN t.type = 'BUY' THEN t.quantity WHEN t.type = 'SELL' THEN -t.quantity ELSE 0 END) as balance,
                   SUM(CASE 
                        WHEN t.type = 'BUY' THEN (t.quantity * t.price + t.commission + t.tax)
                        WHEN t.type = 'SELL' THEN -(t.quantity * (SELECT AVG(t2.price) FROM transactions t2 JOIN portfolio_users pu2 ON t2.portfolioId = pu2.portfolio_id WHERE t2.assetTicker = t.assetTicker AND t2.type = 'BUY' AND pu2.user_id = ?))
                        ELSE 0 
                   END) as totalCostAsset
            FROM transactions t
            JOIN portfolio_users pu ON t.portfolioId = pu.portfolio_id
            WHERE pu.user_id = ?
            GROUP BY t.assetTicker
        ) t ON a.ticker = t.assetTicker
        LEFT JOIN user_watchlist uw ON a.ticker = uw.ticker AND uw.user_id = ?
        WHERE a.ticker != 'CASH' AND (a.type != 'Cash' OR a.type IS NULL) 
        -- Only show what matters to the user in Market Overview: positions they own OR assets in their specific watchlist
        AND (hasPosition = 1 OR (uw.user_id IS NOT NULL))
        ORDER BY a.name ASC
    `).all(userId, userId, userId);

    // 1. Calculate holdings per portfolio to get specific PMCs (Filtered by user)
    const portfolioHoldings = {}; 
    const allP = database.db.prepare(`
        SELECT p.id, p.name, p.color, p.currency 
        FROM portfolios p
        JOIN portfolio_users pu ON p.id = pu.portfolio_id
        WHERE pu.user_id = ?
    `).all(userId);
    for (const p of allP) {
        const txs = database.db.prepare(`
            SELECT type, assetTicker, quantity, price, commission, tax, exchangeRate, amount 
            FROM transactions 
            WHERE portfolioId = ? 
            ORDER BY date ASC
        `).all(p.id);
        
        const pOpenMap = {};
        for (const t of txs) {
            if (!t.assetTicker || t.assetTicker === 'CASH') continue;
            const ticker = t.assetTicker;
            if (t.type === 'BUY') {
                if (!pOpenMap[ticker]) pOpenMap[ticker] = { qty: 0, cost: 0, costBase: 0 };
                const fx = t.exchangeRate || 1;
                const costBase = t.amount ? Math.abs(t.amount) : ((t.quantity * t.price + t.commission + t.tax) / fx);

                pOpenMap[ticker].qty += t.quantity;
                pOpenMap[ticker].cost += (t.quantity * t.price + t.commission + t.tax);
                pOpenMap[ticker].costBase += costBase;
            } else if (t.type === 'SELL') {
                if (pOpenMap[ticker] && pOpenMap[ticker].qty > 0) {
                    const pmc = pOpenMap[ticker].cost / pOpenMap[ticker].qty;
                    const pmcBase = pOpenMap[ticker].costBase / pOpenMap[ticker].qty;
                    pOpenMap[ticker].qty -= t.quantity;
                    pOpenMap[ticker].cost -= t.quantity * pmc;
                    pOpenMap[ticker].costBase -= t.quantity * pmcBase;
                    if (pOpenMap[ticker].qty <= 0.0001) delete pOpenMap[ticker];
                }
            } else if (t.type === 'SPLIT') {
                if (pOpenMap[ticker] && pOpenMap[ticker].qty > 0 && t.quantity > 0) {
                    pOpenMap[ticker].qty *= t.quantity;
                }
            }
        }
        for (const [ticker, data] of Object.entries(pOpenMap)) {
            if (!portfolioHoldings[ticker]) portfolioHoldings[ticker] = [];
            portfolioHoldings[ticker].push({
                name: p.name,
                color: p.color,
                currency: p.currency,
                qty: data.qty,
                costBase: data.costBase,
                pmc: data.cost / data.qty
            });
        }
    }

    const liveRate = await getEurUsdRate();
    const today = new Date().toISOString().split('T')[0];

    // Add sparkline data (last 7 days from cache)
    
        const allTickers = rows.map(r => r.ticker);
        const badgesByTicker = {};
        if (allTickers.length > 0) {
            const placeholders = allTickers.map(() => '?').join(',');
            const aiHistoryStmt = database.db.prepare(`
                SELECT ticker, engine, action as aiAction, targetPrice as aiTargetPrice, created_at
                FROM asset_ai_history
                WHERE ticker IN (${placeholders}) AND engine IS NOT NULL
                ORDER BY created_at DESC
            `);
            const allBadges = aiHistoryStmt.all(...allTickers);
            for (const b of allBadges) {
                if (!badgesByTicker[b.ticker]) badgesByTicker[b.ticker] = [];
                if (badgesByTicker[b.ticker].length < 5) badgesByTicker[b.ticker].push(b);
            }
        }
        
        const marketStatus = getMarketStatus();
        const result = rows.map(a => {
            const aiBadges = badgesByTicker[a.ticker] || [];

        let sparkline = [];
        if (historicalPricesCache[a.ticker]) {
            const history = historicalPricesCache[a.ticker];
            const dates = Object.keys(history).sort();
            sparkline = dates.slice(-7).map(d => history[d]);
        }
        const isToday = a.quoteDate === today;
        const isUS = isUSMarket(a);
        const openedToday = isUS ? marketStatus.US_openedToday : marketStatus.EU_openedToday;
        const showVariation = isToday && openedToday;

        let totalGainEUR = 0;
        
        // Attach portfoliosInfo and compute totalGainEUR
        const portfoliosInfo = (portfolioHoldings[a.ticker] || []).map(ph => {
            const roi = (a.currentPrice > 0 && ph.pmc > 0) ? ((a.currentPrice - ph.pmc) / ph.pmc) * 100 : 0;
            
            const currentValAsset = ph.qty * (a.currentPrice || 0);
            let currentValBase = currentValAsset;
            if (a.currency === 'USD' && ph.currency === 'EUR') {
                currentValBase = currentValAsset / liveRate;
            } else if (a.currency === 'EUR' && ph.currency === 'USD') {
                currentValBase = currentValAsset * liveRate;
            }
            
            const gainBase = currentValBase - ph.costBase;
            
            let gainEUR = gainBase;
            if (ph.currency === 'USD') {
                gainEUR = gainBase / liveRate;
            }
            
            totalGainEUR += gainEUR;
            
            return {
                name: ph.name,
                color: ph.color,
                roi: roi
            };
        });

        // Override flawed SQL properties with accurately calculated portfolio holdings data
        const actualTotalQuantity = (portfolioHoldings[a.ticker] || []).reduce((sum, ph) => sum + ph.qty, 0);
        const actualTotalCostAssetCurr = (portfolioHoldings[a.ticker] || []).reduce((sum, ph) => sum + (ph.pmc * ph.qty), 0);

        return { 
            ...a, 
            totalQuantity: actualTotalQuantity > 0.0001 ? actualTotalQuantity : 0,
            totalCostAssetCurr: actualTotalCostAssetCurr,
            sparkline,
            changePercent: showVariation ? a.changePercent : 0,
            changeValue: showVariation ? a.changeValue : 0,
            // Override global alert settings with user-specific ones
            targetPrice: a.userTargetPrice !== null ? a.userTargetPrice : a.targetPrice,
            stopLoss: a.userStopLoss !== null ? a.userStopLoss : a.stopLoss,
            volatilityAlert: a.userVolatilityAlert !== null ? a.userVolatilityAlert : a.volatilityAlert,
            portfoliosInfo,
            totalGainEUR,
            aiBadges
        };
    });

    res.json(result);
});

// Historical quotes for a specific asset (for chart popup)
router.get('/asset-quotes/:ticker', requireAuth, (req, res) => {
    const { ticker } = req.params;
    const { from, to } = req.query;
    try {
        let sql = `SELECT date, price FROM asset_quotes WHERE UPPER(ticker) = UPPER(?) ORDER BY date ASC`;
        const params = [ticker];
        if (from && to) {
            sql = `SELECT date, price FROM asset_quotes WHERE UPPER(ticker) = UPPER(?) AND date >= ? AND date <= ? ORDER BY date ASC`;
            params.push(from, to);
        }
        const rows = database.db.prepare(sql).all(...params);
        res.json(rows);
    } catch (err) {
        logger.error('Error fetching asset quotes', err);
        res.status(500).json({ error: err.message });
    }
});



router.post('/assets/manual-update', requireAuth, async (req, res) => {
    const { ticker, price, date, type, country, dataSource, isin } = req.body;
    if (!ticker) return res.status(400).send('Ticker is required');
    const sanitizedTicker = sanitizeTicker(ticker);
    if (!isValidISIN(isin)) return res.status(400).send('Invalid ISIN format (must be 12 chars e.g. IT000...)');

    database.db.prepare(`
        UPDATE assets 
        SET currentPrice = ?, updatedAt = ?, isManual = 1, changePercent = 0,
            type = COALESCE(?, type), country = COALESCE(?, country),
            dataSource = COALESCE(?, dataSource), isin = COALESCE(?, isin),
            lastUpdateError = NULL
        WHERE ticker = ?
    `).run(
        parseFloat(price), 
        date || new Date().toISOString().split('T')[0], 
        type || null,
        country || null,
        dataSource || 'YF',
        isin ? isin.toUpperCase().trim() : null,
        sanitizedTicker
    );
    
    const liveRate = await getEurUsdRate();
    await recalculateAllPortfoliosWithOverrides(liveRate);
    clearPerformanceCache();
    res.json({ success: true });
});

router.post('/assets/toggle-manual', requireAuth, (req, res) => {
    const { ticker, isManual } = req.body;
    database.db.prepare(`UPDATE assets SET isManual = ? WHERE ticker = ?`).run(isManual ? 1 : 0, ticker);
    res.json({ success: true });
});

router.get('/assets/:id', requireAuth, (req, res) => {
    const row = database.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).send('Asset not found');
    res.json(row);
});

// Borsa Italiana Debug Endpoint (admin only)
router.post('/debug/borsa-italiana', requireAuth, requireAdmin, async (req, res) => {
    const { isin, assetType } = req.body;
    if (!isin) return res.status(400).send('ISIN is required');
    const result = await B_ITA(isin, assetType);
    res.json(result);
});

// Import historical data (usually from frontend scraper)
router.post('/assets/import-history', requireAuth, (req, res) => {
    const { ticker, history } = req.body; // history: [{dt, closePx}, ...]
    if (!ticker || !history || !Array.isArray(history)) {
        return res.status(400).send('Ticker and history array are required');
    }

    try {
        const insert = database.db.prepare('INSERT OR REPLACE INTO asset_quotes (ticker, date, price) VALUES (?, ?, ?)');
        database.db.transaction(() => {
            for (const entry of history) {
                // Handle different date formats (YYYYMMDD from Bitaly or YYYY-MM-DD)
                let dateStr = entry.dt || entry.date;
                if (dateStr.length === 8 && !dateStr.includes('-')) {
                    dateStr = `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`;
                }
                const price = parseFloat(entry.closePx || entry.price);
                if (dateStr && !isNaN(price)) {
                    insert.run(ticker, dateStr, price);
                }
            }
        })();
        
        logger.info(`Imported ${history.length} historical quotes for ${ticker}`);
        clearPerformanceCache();
        res.json({ success: true, count: history.length });
    } catch (err) {
        logger.error(`Failed to import history for ${ticker}`, err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/assets', requireAuth, async (req, res) => {
    try {
        let { ticker, name, type, currency, exchange, pe, currentPrice, changePercent, isin, dataSource } = req.body;
        ticker = sanitizeTicker(ticker);
        if (!ticker) return res.status(400).send('Invalid Ticker');
        if (!isValidISIN(isin)) return res.status(400).send('Invalid ISIN format');

        let assetData = {
            id:           ticker || `MANUAL-${Date.now()}`,
            ticker:       ticker || '',
            name:         name   || ticker || 'Unknown',
            type:         type   || 'Other',
            exchange:     exchange || 'Unknown',
            currency:     currency || 'USD',
            currentPrice: parseFloat(currentPrice || 0),
            changePercent:parseFloat(changePercent || 0),
            pe:           pe ? parseFloat(pe) : null,
            dataSource:   req.body.dataSource || 'YF',
            isin:         req.body.isin || null
        };

        if (ticker) {
            const metadata = await fetchAssetMetadata(ticker);
            if (metadata) {
                assetData = {
                    id:           ticker,
                    ticker,
                    name:         name || metadata.name,
                    type:         type || metadata.type,
                    exchange:     exchange || metadata.exchange,
                    currency:     currency || metadata.currency,
                    currentPrice: parseFloat(currentPrice || metadata.currentPrice),
                    changePercent:parseFloat(changePercent || metadata.changePercent),
                    pe:           pe ? parseFloat(pe) : metadata.pe,
                    forwardPE:    metadata.forwardPE,
                    dividendYield:metadata.dividendYield,
                    eps:          metadata.eps,
                    beta:         metadata.beta,
                    nextDividendDate: metadata.nextDividendDate,
                    country:      metadata.country,
                    dataSource:   dataSource || 'YF',
                    isin:         isin || metadata.isin || null
                };
            }
        }

        const existing = database.db.prepare(`SELECT id FROM assets WHERE ticker = ?`).get(assetData.ticker);
        if (existing && assetData.ticker) return res.status(400).send('Asset already in monitoring list');

        database.db.prepare(`
            INSERT INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, forwardPE, dividendYield, eps, beta, pegRatio, nextDividendDate, country, dataSource, isin, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            assetData.id, assetData.ticker, assetData.name, assetData.type,
            assetData.exchange, assetData.currency, assetData.currentPrice,
            assetData.changePercent, assetData.pe, assetData.forwardPE || null,
            assetData.dividendYield || null, assetData.eps || null, assetData.beta || null,
            assetData.pegRatio || null, assetData.nextDividendDate || null, assetData.country,
            assetData.dataSource || 'YF', assetData.isin || null
        );

        res.status(201).json(assetData);
    } catch (err) {
        console.error('Add asset error:', err);
        res.status(500).send('Failed to add asset: ' + err.message);
    }
});

router.put('/assets/:id', requireAuth, (req, res) => {
    const { targetPrice, stopLoss, volatilityAlert, isMonitored, dataSource, isin, name, type, exchange, currency, currentPrice, changePercent, pe } = req.body;
    
    // 1. Update Asset Metadata (Global)
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (type !== undefined) { updates.push("type = ?"); params.push(type); }
    if (exchange !== undefined) { updates.push("exchange = ?"); params.push(exchange); }
    if (currency !== undefined) { updates.push("currency = ?"); params.push(currency); }
    if (currentPrice !== undefined) { updates.push("currentPrice = ?"); params.push(currentPrice); }
    if (changePercent !== undefined) { updates.push("changePercent = ?"); params.push(changePercent); }
    if (pe !== undefined) { updates.push("pe = ?"); params.push(pe); }
    if (isMonitored !== undefined) { updates.push("isMonitored = ?"); params.push(isMonitored); }
    if (dataSource !== undefined) { updates.push("dataSource = ?"); params.push(dataSource); }
    if (isin !== undefined) { updates.push("isin = ?"); params.push(isin); }
    
    if (updates.length > 0) {
        params.push(req.params.id);
        params.push(req.params.id);
        database.db.prepare(`UPDATE assets SET ${updates.join(', ')} WHERE id = ? OR ticker = ?`).run(...params);
    }

    // 2. Update User Alerts (Private)
    const tickerParam = req.params.id; 
    const watchUpdates = [];
    const watchParams = [];
    if (targetPrice !== undefined) { watchUpdates.push("targetPrice = ?"); watchParams.push(targetPrice); }
    if (stopLoss !== undefined) { watchUpdates.push("stopLoss = ?"); watchParams.push(stopLoss); }
    if (volatilityAlert !== undefined) { watchUpdates.push("volatilityAlert = ?"); watchParams.push(volatilityAlert); }
    
    if (watchUpdates.length > 0) {
        try {
            // First ensure the row exists
            const actualTickerRow = database.db.prepare(`SELECT ticker FROM assets WHERE id = ? OR ticker = ?`).get(tickerParam, tickerParam);
            if (actualTickerRow) {
                const ticker = actualTickerRow.ticker;
                database.db.prepare(`INSERT OR IGNORE INTO user_watchlist (user_id, ticker) VALUES (?, ?)`).run(req.user.id, ticker);
                database.db.prepare(`
                    UPDATE user_watchlist 
                    SET ${watchUpdates.join(', ')} 
                    WHERE user_id = ? AND ticker = ?
                `).run(...watchParams, req.user.id, ticker);
            }
        } catch (e) {
            logger.error('Error updating user watchlist in PUT /api/assets', e);
        }
    }

    res.json({ success: true });
});
router.post('/assets/split', requireAuth, async (req, res) => {
    const { oldTicker, newTicker, ratio, splitDate } = req.body;
    
    if (!oldTicker || !ratio || !splitDate) {
        return res.status(400).json({ error: 'oldTicker, ratio and splitDate are required' });
    }

    const r = parseFloat(ratio);
    if (isNaN(r) || r <= 0) {
        return res.status(400).json({ error: 'Invalid ratio' });
    }

    const targetTicker = newTicker && newTicker.trim() !== '' ? newTicker.trim() : oldTicker;
    
    try {
        // Find existing asset
        const asset = database.db.prepare('SELECT * FROM assets WHERE ticker = ?').get(oldTicker);
        if (!asset) return res.status(404).json({ error: 'Asset not found' });

        database.db.transaction(() => {
            // 1. Rename Ticker if provided
            if (targetTicker !== oldTicker) {
                // Insert new asset if not exists
                database.db.prepare(`
                    INSERT OR IGNORE INTO assets (id, ticker, name, type, exchange, currency, currentPrice, changePercent, pe, country, isManual, dataSource, isin, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `).run(targetTicker, targetTicker, asset.name, asset.type, asset.exchange, asset.currency, asset.currentPrice, asset.changePercent, asset.pe, asset.country, asset.isManual, asset.dataSource, asset.isin);
                
                // Update all relations
                database.db.prepare('UPDATE transactions SET assetTicker = ? WHERE assetTicker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_quotes SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE user_watchlist SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE dividend_projections SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_ai_analyses SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                database.db.prepare('UPDATE asset_ai_history SET ticker = ? WHERE ticker = ?').run(targetTicker, oldTicker);
                
                // Try deleting old asset if it has no remaining relations
                try {
                    database.db.prepare('DELETE FROM assets WHERE ticker = ?').run(oldTicker);
                } catch (e) {
                    // Ignore foreign key constraints if it's still linked somewhere unexpected
                }
            }

            // 2. Adjust Transactions
            // Multiply quantity, divide price for dates <= splitDate
            database.db.prepare(`
                UPDATE transactions 
                SET quantity = quantity * ?, price = price / ?
                WHERE assetTicker = ? AND date <= ? AND type != 'SPLIT'
            `).run(r, r, targetTicker, splitDate);

            // 3. Adjust Asset Quotes
            database.db.prepare(`
                UPDATE asset_quotes
                SET price = price / ?
                WHERE ticker = ? AND date <= ?
            `).run(r, targetTicker, splitDate);
            
            // 4. Insert Audit Split Transaction in all portfolios containing the asset
            const portfolios = database.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
            const insertTx = database.db.prepare(`
                INSERT INTO transactions (portfolioId, type, assetTicker, date, quantity, price, amount)
                VALUES (?, 'SPLIT', ?, ?, ?, 0, 0)
            `);
            for (const p of portfolios) {
                insertTx.run(p.portfolioId, targetTicker, splitDate, r);
            }
        })();

        // Re-fetch current price if possible (background)
        if (asset.dataSource !== 'MANUAL') {
            fetchAssetMetadata(targetTicker).then(m => {
                if (m && m.currentPrice) {
                    database.db.prepare('UPDATE assets SET currentPrice = ? WHERE ticker = ?').run(m.currentPrice, targetTicker);
                }
            }).catch(e => logger.error('Error refreshing split asset metadata:', e));
        }

        // Rebuild portfolios and clear cache
        const portfolios = database.db.prepare('SELECT DISTINCT portfolioId FROM transactions WHERE assetTicker = ?').all(targetTicker);
        const liveRate = await getEurUsdRate();
        for (const p of portfolios) {
            database.recalculatePortfolio(p.portfolioId, liveRate);
            triggerHistoryRebuild(p.portfolioId);
        }
        clearPerformanceCache();

        res.json({ success: true, newTicker: targetTicker });
    } catch (err) {
        logger.error('Error during asset split:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/assets/:id', requireAuth, (req, res) => {
    // Assets are global, but we can delete from the user's watchlist
    try {
        database.db.prepare(`DELETE FROM user_watchlist WHERE user_id = ? AND ticker = (SELECT ticker FROM assets WHERE id = ? OR ticker = ?)`).run(req.user.id, req.params.id, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/assets/:ticker/history', requireAuth, async (req, res) => {
    const { ticker } = req.params;
    const { range } = req.query;
    
    try {
        const now = new Date();
        const rangeMap = {
            '1W': 7,
            '2W': 14,
            '1M': 30,
            '3M': 90,
            '6M': 180,
            '1Y': 365,
            'ALL': 3650
        };
        const days = rangeMap[range] || 30; // 1M default
        const period1 = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

        const historical = await yahooFinance.historical(ticker, {
            period1: period1,
            period2: now,
            interval: '1d'
        }).catch(() => []);

        // Filter and map for Chart.js
        const result = historical
            .filter(h => h.close !== null && h.close !== undefined)
            .map(h => ({
                date: h.date instanceof Date ? h.date.toISOString().split('T')[0] : h.date,
                price: h.close
            }));

        res.json(result);
    } catch (err) {
        console.error(`Error fetching history for ${ticker}:`, err.message);
        res.json([]);
    }
});

router.get('/assets/:ticker/portfolios', requireAuth, (req, res) => {
    const { ticker } = req.params;
    const userId = req.user.id;
    try {
        const rows = database.db.prepare(`
            SELECT DISTINCT p.id, p.name 
            FROM portfolios p
            JOIN transactions t ON p.id = t.portfolioId
            JOIN portfolio_users pu ON p.id = pu.portfolio_id
            WHERE t.assetTicker = ? AND pu.user_id = ?
        `).all(ticker, userId);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/assets/:ticker/details', requireAuth, async (req, res) => {
    const { ticker } = req.params;
    try {
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'calendarEvents', 'fundProfile']
        });
        
        // Enrich with ISIN from DB
        const asset = database.db.prepare(`SELECT isin FROM assets WHERE ticker = ?`).get(ticker);
        const enriched = { 
            ...summary, 
            dbIsin: asset ? asset.isin : null 
        };
        
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/assets/:id', requireAuth, (req, res) => {
    const asset = database.db.prepare(`SELECT * FROM assets WHERE id = ? OR ticker = ?`).get(req.params.id, req.params.id);
    if (!asset) return res.status(404).send('Asset not found');

    // 1. Check for transactions/positions
    // We check if it's used in any transaction
    const txCount = database.db.prepare(`SELECT COUNT(*) as count FROM transactions WHERE assetTicker = ?`).get(asset.ticker).count;
    
    // 2. Check for open positions (simplified: if sum(qty) > 0 in any portfolio)
    // Actually, if we just check if it's used in any transaction, we might want to keep it as "referenced".
    // But the user specifically asked for "remove from monitoring if NO OPEN POSITIONS".

    
    let hasOpenPosition = false;
    const portfolios = database.db.prepare(`SELECT id FROM portfolios`).all();
    for (const p of portfolios) {
        const txs = database.db.prepare(`SELECT type, quantity FROM transactions WHERE portfolioId = ? AND assetTicker = ?`).all(p.id, asset.ticker);
        let qty = 0;
        for (const t of txs) {
            if (t.type === 'BUY') qty += t.quantity;
            if (t.type === 'SELL') qty -= t.quantity;
        }
        if (Math.abs(qty) > 0.000001) {
            hasOpenPosition = true;
            break;
        }
    }

    if (hasOpenPosition) {
        return res.status(400).send('Cannot stop monitoring an asset with active positions.');
    }

    if (txCount > 0) {
        // Just hide from monitoring, keep for historical records
        database.db.prepare(`UPDATE assets SET isMonitored = 0 WHERE id = ?`).run(req.params.id);
        res.json({ ...asset, isMonitored: 0 });
    } else {
        // No transactions at all, safe to hard delete
        database.db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id);
        res.json({ ...asset, deleted: true });
    }
});

router.get('/assets/:ticker/ai-analysis', requireAuth, async (req, res) => {
    try {
        const globalSettings = database.getSettings(1) || {};


        // Setup SSE Headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const sendEvent = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const ticker = req.params.ticker;
        sendEvent('progress', { message: 'Recupero informazioni asset...' });

        // Fetch asset info
        const assetRow = database.db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
        if (!assetRow) {
            throw new Error('Asset non trovato.');
        }

        // Fetch recent news
        let newsTitles = '';
        const tavilyKey = globalSettings.tavilyApiKey || process.env.TAVILY_API_KEY;
        if (tavilyKey) {
            sendEvent('progress', { message: 'Ricerca news recenti tramite Tavily...' });
            try {
                const tavilyRes = await axios.post('https://api.tavily.com/search', {
                    api_key: tavilyKey,
                    query: `${assetRow.ticker} ${assetRow.name} stock news latest analysis`,
                    search_depth: 'basic',
                    max_results: 5
                });
                if (tavilyRes.data && Array.isArray(tavilyRes.data.results)) {
                    newsTitles = tavilyRes.data.results.map(r => `${r.title}: ${r.content}`).join('\n');
                }
            } catch (err) {
                logger.error('[Tavily API Error]', err.message);
            }
        }
        
        if (!newsTitles) {
            sendEvent('progress', { message: 'Ricerca news recenti...' });
            const newsRes = await yahooFinance.search(ticker, { newsCount: 3 }).catch(() => ({}));
            newsTitles = (newsRes.news || []).map(n => n.title).join('; ');
        }
        
        // Fetch earnings/fundamentals
        sendEvent('progress', { message: 'Recupero dati fondamentali (presenti e storici)...' });
        const fundamentalsData = await getAssetFundamentals(ticker).catch(() => ({}));
        
        let earningsDate = 'Sconosciuta';
        if (fundamentalsData.calendarEvents?.earnings?.earningsDate?.[0]) {
            earningsDate = new Date(fundamentalsData.calendarEvents.earnings.earningsDate[0]).toISOString().split('T')[0];
        }

        const ks = fundamentalsData.keyStats || {};
        const sd = fundamentalsData.summaryDetail || {};
        
        let historicalStr = '';
        if (fundamentalsData.historicalFinancials && fundamentalsData.historicalFinancials.length > 0) {
            const lines = fundamentalsData.historicalFinancials.map(item => {
                const year = item.date ? String(item.date).substring(0,4) : 'N/D';
                const rev = item.totalRevenue ?? null;
                const ni = item.netIncome ?? null;
                return `    * ${year}: Revenue ${rev ? (rev/1e9).toFixed(2)+'B' : 'N/D'}, Net Income ${ni ? (ni/1e9).toFixed(2)+'B' : 'N/D'}`;
            });
            historicalStr = '\n  - Storico Dati Finanziari (Annuale):\n' + lines.join('\n');
        }
        
        const fundamentalsStr = `
  - P/E (Trailing): ${sd.trailingPE ? sd.trailingPE.toFixed(2) : 'N/D'}
  - P/E (Forward): ${ks.forwardPE ? ks.forwardPE.toFixed(2) : 'N/D'}
  - PEG Ratio: ${fundamentalsData.pegRatio ? fundamentalsData.pegRatio.toFixed(2) : 'N/D'}
  - EPS (Trailing): ${ks.trailingEps ? ks.trailingEps.toFixed(2) : 'N/D'}
  - EPS (Forward): ${ks.forwardEps ? ks.forwardEps.toFixed(2) : 'N/D'}
  - Dividend Yield: ${sd.dividendYield ? (sd.dividendYield * 100).toFixed(2) + '%' : 'N/D'}
  - Beta: ${sd.beta ? sd.beta.toFixed(2) : 'N/D'}${historicalStr}`;
        
        const contextData = `
- **${assetRow.ticker} (${assetRow.name})**:
  - Asset Type: ${assetRow.type}
  - Exchange: ${assetRow.exchange}
  - Currency: ${assetRow.currency}
  - Current Price: ${assetRow.currentPrice}
  - Prossima Trimestrale (Earnings): ${earningsDate}${fundamentalsStr}
  - Ultime News: ${newsTitles || 'Nessuna news rilevante recente'}`;

        sendEvent('progress', { message: 'Generazione responso IA in corso...' });

        let customPromptText = globalSettings.aiAssetPrompt || '';
        if (customPromptText) {
            const assetName = assetRow.name || assetRow.ticker;
            const assetExchange = assetRow.exchange || 'Mercato';
            customPromptText = customPromptText.replace(/\[INSERIRE TICKER E MERCATO\]/gi, `${assetRow.ticker} (${assetExchange})`);
            customPromptText = customPromptText.replace(/\[TICKER\]/gi, assetRow.ticker);
            customPromptText = customPromptText.replace(/\[ASSET\]/gi, assetName);
        }

        const customPrompt = customPromptText ? `\nIstruzioni personalizzate dall'utente:\n${customPromptText}\n` : '';

        const prompt = `
Sei un esperto analista finanziario. Il tuo compito è analizzare questo asset in base ai dati forniti e soddisfare scrupolosamente le istruzioni personalizzate dell'utente.

${customPrompt}

Dati Asset Attuali:
${contextData}

REGOLE DI OUTPUT FONDAMENTALI:
Devi restituire ESATTAMENTE ed ESCLUSIVAMENTE un oggetto JSON valido. NESSUN TESTO al di fuori del JSON. Nessun blocco markdown \`\`\`json.
Tutta la tua analisi discorsiva, comprese le risposte alle istruzioni dell'utente e la scheda tecnica richiesta, DEVONO ESSERE INSERITE ALL'INTERNO del campo testuale "reasoning" formattato in Markdown.
Inoltre, devi estrarre l'indicazione operativa e i prezzi chiave per popolare i campi strutturati "action", "targetProfit" and "stopLoss".

Struttura JSON richiesta:
{
  "action": "BUY",
  "reasoning": "INSERISCI QUI TUTTA L'ANALISI COMPLETA E LA SCHEDA TECNICA RICHIESTA (in formato Markdown).",
  "targetProfit": 150.50,
  "stopLoss": 90.00
}

NB: 
- "action" deve essere una singola parola in maiuscolo (es. BUY, SELL, HOLD, INCREASE, DECREASE). 
- "targetProfit" e "stopLoss" devono essere numeri (usa il punto per i decimali, es. 10.50). Se non hai un target o stop loss definito, inserisci 0.
- IMPORTANTE: Per i ritorni a capo all'interno di "reasoning", devi ASSOLUTAMENTE USARE il carattere di escape "\n" e non andare mai a capo fisicamente. Fai l'escape anche delle eventuali virgolette interne con \" per non invalidare il JSON.
`;

        const engine = req.query.engine || globalSettings.aiEngine || 'Gemini';
        let parsedResponse = null;
        let tokensUsed = 0;
        let usage = {};

        try {
            if (engine === 'Both') {
                sendEvent('progress', { message: 'Generazione in corso (Gemini + Qwen)...' });
                const [geminiRes, qwenRes] = await Promise.allSettled([
                    callAIModel('Gemini', prompt, globalSettings),
                    callAIModel('Qwen', prompt, globalSettings)
                ]);

                let geminiText = "{}";
                if (geminiRes.status === 'fulfilled') {
                    geminiText = geminiRes.value.text;
                    tokensUsed += (geminiRes.value.usage.totalTokenCount || 0);
                }

                let qwenText = "{}";
                if (qwenRes.status === 'fulfilled') {
                    qwenText = qwenRes.value.text;
                    // Qwen tokens approximation or tracking if provided
                    tokensUsed += (qwenRes.value.usage.total_tokens || 0);
                }

                let parsedGemini = {};
                let parsedQwen = {};
                
                parsedGemini = parseAIResponse(geminiText);
                
                parsedQwen = parseAIResponse(qwenText);

                parsedResponse = {
                    action: parsedGemini.action || parsedQwen.action || 'HOLD',
                    targetProfit: parsedGemini.targetProfit || parsedQwen.targetProfit || 0,
                    stopLoss: parsedGemini.stopLoss || parsedQwen.stopLoss || 0,
                    reasoning: `### Analisi prodotta da Gemini\n\n${parsedGemini.reasoning || 'Nessuna risposta valida da Gemini.'}\n\n---\n\n### Analisi prodotta da Qwen\n\n${parsedQwen.reasoning || 'Nessuna risposta valida da Qwen.'}`
                };

            } else {
                sendEvent('progress', { message: `Generazione responso IA in corso tramite ${engine}...` });
                const res = await callAIModel(engine, prompt, globalSettings);
                const rawText = res.text;
                tokensUsed = res.usage.totalTokenCount || res.usage.total_tokens || 0;
                usage = res.usage;
                
                parsedResponse = parseAIResponse(rawText);
                parsedResponse.reasoning = `### Analisi prodotta da ${engine}\n\n` + (parsedResponse.reasoning || '');
            }
        } catch (e) {
            console.error('Failed to parse AI JSON response or execute model:', e);
            throw e;
        }
        
        database.db.transaction(() => {
            // Aggiorna token count
            const today = new Date().toISOString().split('T')[0];
            let currentTokens = parseInt(globalSettings.aiTokensUsedToday) || 0;
            let tokenDate = globalSettings.aiTokensDate || today;
            
            if (tokenDate !== today) {
                currentTokens = 0;
                database.setSetting(1, 'aiTokensDate', today);
            }
            database.setSetting(1, 'aiTokensUsedToday', (currentTokens + tokensUsed).toString());

            // Aggiorna asset con targetPrice, stopLoss e info IA
            const targetPrice = parsedResponse.targetProfit > 0 ? parsedResponse.targetProfit : assetRow.targetPrice;
            const stopLoss = parsedResponse.stopLoss > 0 ? parsedResponse.stopLoss : assetRow.stopLoss;
            const action = (parsedResponse.action || 'HOLD').toUpperCase();
            const reasoning = parsedResponse.reasoning || '';

            database.db.prepare(`
                UPDATE assets 
                SET targetPrice = ?, stopLoss = ?, ai_action = ?, ai_reasoning = ?, ai_engine = ?, ai_updated_at = CURRENT_TIMESTAMP
                WHERE ticker = ?
            `).run(targetPrice, stopLoss, action, reasoning, engine, ticker);

            // Se l'utente ha una watchlist per questo asset, sovrascrivi anche le sue impostazioni personali
            const userId = req.user.id;
            const userWl = database.db.prepare(`SELECT 1 FROM user_watchlist WHERE user_id = ? AND ticker = ?`).get(userId, ticker);
            if (userWl) {
                database.db.prepare(`
                    UPDATE user_watchlist
                    SET targetPrice = ?, stopLoss = ?
                    WHERE user_id = ? AND ticker = ?
                `).run(targetPrice, stopLoss, userId, ticker);
            } else {
                database.db.prepare(`
                    INSERT INTO user_watchlist (user_id, ticker, targetPrice, stopLoss)
                    VALUES (?, ?, ?, ?)
                `).run(userId, ticker, targetPrice, stopLoss);
            }

            // Inserisci nello storico
            database.db.prepare(`
                INSERT INTO asset_ai_history (ticker, action, reasoning, targetPrice, stopLoss, engine)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ticker, action, reasoning, targetPrice, stopLoss, engine);
        })();

        sendEvent('complete', { 
            analysis: parsedResponse,
            usage: usage 
        });
        res.end();
    } catch (err) {
        console.error('AI Analysis Error:', err?.response?.data || err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Errore durante l\'analisi IA: ' + (err?.response?.data?.error?.message || err.message) });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Errore durante l\'analisi IA: ' + (err?.response?.data?.error?.message || err.message) })}\n\n`);
            res.end();
        }
    }
});

router.get('/assets/:ticker/ai-history', requireAuth, (req, res) => {
    try {
        const history = database.db.prepare(`
            SELECT id, action, reasoning, targetPrice, stopLoss, engine, created_at 
            FROM asset_ai_history 
            WHERE ticker = ? 
            ORDER BY created_at DESC
        `).all(req.params.ticker);
        res.json(history);
    } catch (err) {
        logger.error('Error fetching asset AI history', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/assets/ai-history/:id', requireAuth, (req, res) => {
    try {
        database.db.prepare('DELETE FROM asset_ai_history WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.error('Error deleting asset AI history', err);
        res.status(500).json({ error: err.message });
    }
});
    return router;
};
