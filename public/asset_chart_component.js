/**
 * Asset Chart Component for M2T
 * Centralizes historical chart modal and BUY/SELL visualization.
 */

(function () {
    let _assetChartInstance = null;
    let _allChartData = [];
    let _chartTicker = null;
    let _chartCurrency = 'EUR';

    // Inject Modal HTML if not present
    function ensureModalExists() {
        const existing = document.getElementById('asset-chart-modal');
        if (existing) existing.remove();

        const isDark = document.documentElement.classList.contains('dark');
        const backdropColor = isDark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.7)';

        // Inject fallback CSS variables for desktop / views where mobile.css is not fully active
        let styleTag = document.getElementById('asset-chart-modal-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'asset-chart-modal-styles';
            styleTag.innerHTML = `
                #asset-chart-modal {
                    --mob-bg: #0b0f1a;
                    --mob-surface: #111722;
                    --mob-surface-2: #1a2235;
                    --mob-border: rgba(255, 255, 255, 0.07);
                    --mob-text: #f1f5f9;
                    --mob-text-muted: #94a3b8;
                    --mob-emerald: #10b981;
                    --mob-rose: #f43f5e;
                    --mob-primary: #135bec;
                }
                html:not(.dark) #asset-chart-modal {
                    --mob-bg: #f0f4f8;
                    --mob-surface: #ffffff;
                    --mob-surface-2: #f1f5f9;
                    --mob-border: rgba(0, 0, 0, 0.07);
                    --mob-text: #0f172a;
                    --mob-text-muted: #4b5563;
                }
            `;
            document.head.appendChild(styleTag);
        }

        const modalHtml = `
        <div id="asset-chart-modal" 
             style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 9999; align-items: center; justify-content: center; background-color: ${backdropColor}; backdrop-filter: blur(12px); padding: 0.5rem; flex-direction: column;"
             class="flex">
            <div style="width: 100%; max-width: 900px; max-height: 94vh; position: relative; z-index: 10000; display: flex; flex-direction: column; border-radius: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden; background: var(--mob-surface); color: var(--mob-text); border: 1px solid var(--mob-border);">
                
                <!-- Header -->
                <div style="padding: 16px 20px; border-bottom: 1px solid rgba(148,163,184,0.1); display: flex; justify-content: space-between; align-items: center; background: var(--mob-surface); ">
                    <div>
                        <h3 class="font-black text-sm md:text-lg dark:text-white" id="chart-modal-title" style="margin: 0;">Asset History</h3>
                        <p class="text-[9px] text-slate-400 uppercase tracking-widest font-bold" id="chart-modal-subtitle" style="margin: 2px 0 0 0;"></p>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div id="chart-range-btns" style="display: flex; gap: 4px;">
                            <button onclick="loadAssetChart(null, '1w')" data-range="1w" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1W</button>
                            <button onclick="loadAssetChart(null, '1m')" data-range="1m" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1M</button>
                            <button onclick="loadAssetChart(null, '6m')" data-range="6m" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">6M</button>
                            <button onclick="loadAssetChart(null, '1y')" data-range="1y" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1Y</button>
                            <button onclick="loadAssetChart(null, '2y')" data-range="2y" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">2Y</button>
                            <button onclick="loadAssetChart(null, 'all')" data-range="all" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">ALL</button>
                        </div>
                        <button onclick="closeAssetChartModal()" style="background: rgba(148,163,184,0.1); border: none; border-radius: 50%; cursor: pointer; color: #94a3b8; padding: 6px; display: flex;">
                            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
                        </button>
                    </div>
                </div>

                <!-- Stats Row -->
                <div id="chart-modal-stats-row" style="display: none; padding: 12px 20px; border-bottom: 1px solid rgba(148,163,184,0.1); background: var(--mob-surface); display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center;">
                </div>
                
                <!-- Chart Area (Compact) -->
                <div style="padding: 10px 0px; flex: 1; min-height: 300px; display: flex; flex-direction: column; background: var(--mob-bg); overflow: hidden;">
                    <div id="chart-modal-loading" style="display: none; flex: 1; align-items: center; justify-content: center;">
                        <span class="material-symbols-outlined animate-spin" style="font-size: 24px; color: var(--mob-primary);">progress_activity</span>
                    </div>
                    <div id="chart-modal-empty" style="display: none; flex: 1; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8;">
                        <span class="material-symbols-outlined" style="font-size: 32px;">bar_chart_off</span>
                        <p style="font-weight: bold; margin-top: 8px; font-size: 11px;">No historical data.</p>
                    </div>
                    <div id="chart-modal-content" style="display: none; flex: 1; min-height: 280px; position: relative;">
                        <canvas id="asset-history-chart" style="width: 100% !important; height: 100% !important;"></canvas>
                    </div>
                </div>

                <!-- Unified Data Grid (Indicators + Targets) -->
                <div id="chart-modal-data-area" style="display: none; padding: 16px; border-top: 1px solid rgba(148,163,184,0.1); background: var(--mob-surface);">
                    <div id="chart-modal-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px 14px; margin-bottom: 16px;">
                        <!-- Content injected by loadAssetChart -->
                    </div>

                    <div style="display: flex; gap: 8px;">
                        <button id="modal-save-alerts-btn" onclick="saveModalAlerts()" style="flex: 2; background: var(--mob-primary); color: white; padding: 10px; border-radius: 10px; border: none; font-weight: 900; cursor: pointer; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; box-shadow: 0 4px 12px rgba(19,91,236,0.2);">
                            Save Notifications
                        </button>
                        <button id="modal-remove-watchlist-btn" style="flex: 1; background: rgba(244,63,94,0.1); color: var(--mob-rose); padding: 10px; border-radius: 10px; border: 1px solid rgba(244,63,94,0.2); font-weight: 900; cursor: pointer; text-transform: uppercase; font-size: 10px; display: none;">
                            Remove
                        </button>
                    </div>
                </div>

                <!-- Footer Info -->
                <div style="padding: 12px 20px; border-top: 1px solid rgba(148,163,184,0.1); display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: var(--mob-text-muted); font-weight: bold; background: var(--mob-surface);">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span id="chart-modal-points">—</span>
                        <div style="display: flex; gap: 8px;">
                            <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 6px; height: 6px; border-radius: 50%; background: var(--mob-emerald);"></span> BUY</span>
                            <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 6px; height: 6px; border-radius: 50%; background: var(--mob-rose);"></span> SELL</span>
                        </div>
                    </div>
                    <span id="chart-modal-range-label" style="font-weight: 900;"></span>
                </div>
            </div>
        </div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        const target = document.getElementById('mobile-ui') || document.body;
        target.appendChild(div.firstElementChild);

        // close on backdrop click
        document.getElementById('asset-chart-modal').addEventListener('click', function (e) {
            if (e.target === this) closeAssetChartModal();
        });
    }

    window.stepVol = function (val) {
        const input = document.getElementById('modal-vol-input');
        if (!input) return;
        let v = parseInt(input.value || 0) + val;
        if (v < 0) v = 0;
        if (v > 20) v = 20;
        input.value = v;
    };

    window.closeAssetChartModal = function () {
        const modal = document.getElementById('asset-chart-modal');
        if (modal) modal.style.display = 'none';
        if (_assetChartInstance) {
            _assetChartInstance.destroy();
            _assetChartInstance = null;
        }
    };

    window.saveModalAlerts = async function () {
        if (!_chartTicker) return;
        const btn = document.getElementById('modal-save-alerts-btn');
        const tp = parseFloat(document.getElementById('modal-tp-input').value || 0);
        const tp2 = parseFloat(document.getElementById('modal-tp2-input').value || 0);
        const sl = parseFloat(document.getElementById('modal-sl-input').value || 0);
        const vol = parseInt(document.getElementById('modal-vol-input').value || 0);

        const originalText = btn.textContent;
        const originalBg = btn.style.backgroundColor;
        btn.disabled = true;
        btn.textContent = 'SAVING...';

        try {
            const res = await fetch(`/api/assets/${encodeURIComponent(_chartTicker)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetPrice: tp,
                    targetPrice2: tp2,
                    stopLoss: sl,
                    volatilityAlert: vol,
                    isMonitored: 1
                })
            });
            if (res.ok) {
                btn.textContent = 'SAVED!';
                btn.style.backgroundColor = 'var(--mob-emerald)';

                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = originalText;
                    btn.style.backgroundColor = originalBg;
                }, 2000);

                if (typeof loadAssets === 'function') loadAssets();
                if (typeof mobLoadAssets === 'function') mobLoadAssets();
                if (typeof loadWatchlist === 'function') loadWatchlist();
            } else {
                alert('Error saving alerts');
                btn.disabled = false;
                btn.textContent = originalText;
            }
        } catch (e) {
            console.error('Save alerts error:', e);
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    window.openAssetChartModal = function (ticker, name, currency) {
        window.loadAssetChart(ticker, '1y');
    };

    window.loadAssetChart = async function (ticker, range = '1y') {
        ensureModalExists();
        if (ticker) _chartTicker = ticker;
        if (!_chartTicker) return;

        const modal = document.getElementById('asset-chart-modal');
        modal.style.display = 'flex';

        document.getElementById('chart-modal-title').textContent = `History: ${_chartTicker}`;

        // Update active range button
        document.querySelectorAll('.chart-range-btn').forEach(b => {
            const isMatch = b.dataset.range === range;
            b.style.backgroundColor = isMatch ? 'var(--mob-primary)' : 'transparent';
            b.style.color = isMatch ? 'white' : 'var(--mob-text-muted)';
            b.style.borderColor = isMatch ? 'var(--mob-primary)' : 'rgba(148,163,184,0.2)';
        });

        // Show loading
        document.getElementById('chart-modal-loading').style.display = 'flex';
        document.getElementById('chart-modal-empty').style.display = 'none';
        document.getElementById('chart-modal-content').style.display = 'none';
        document.getElementById('chart-modal-points').textContent = '—';

        try {
            // 1. Fetch asset info, historical quotes, transactions AND details in parallel
            const [quotesRes, txRes, assetRes, detailsRes] = await Promise.all([
                fetch(`/api/asset-quotes/${encodeURIComponent(_chartTicker)}`),
                fetch(`/api/transactions?assetTicker=${encodeURIComponent(_chartTicker)}`),
                fetch(`/api/assets`),
                fetch(`/api/assets/${encodeURIComponent(_chartTicker)}/details`).catch(() => null)
            ]);

            _allChartData = await quotesRes.json();
            const transactions = await txRes.json();

            // Normalize transaction dates to YYYY-MM-DD
            if (transactions && Array.isArray(transactions)) {
                transactions.forEach(t => {
                    if (t.date && typeof t.date === 'string') {
                        t.date = t.date.split('T')[0].split(' ')[0];
                    }
                });
            }

            const allAssets = await assetRes.json();
            let detailsData = {};
            if (detailsRes && detailsRes.ok) {
                try { detailsData = await detailsRes.json(); } catch (e) { }
            }

            const assetInfo = allAssets.find(a => a.ticker === _chartTicker);

            // Append latest live price if valid and not already the last point
            if (assetInfo && assetInfo.currentPrice > 0) {
                const todayStr = new Date().toISOString().split('T')[0];
                const lastPoint = _allChartData[_allChartData.length - 1];
                if (lastPoint && lastPoint.date === todayStr) {
                    lastPoint.price = assetInfo.currentPrice;
                } else if (!lastPoint || lastPoint.date < todayStr) {
                    _allChartData.push({ date: todayStr, price: assetInfo.currentPrice });
                }
            }

            if (assetInfo) {
                _chartCurrency = assetInfo.currency || 'EUR';
                document.getElementById('chart-modal-subtitle').textContent =
                    `${assetInfo.name} • ${assetInfo.exchange || 'Market'}`;

                const currSym = _chartCurrency === 'EUR' ? '€' : (_chartCurrency === 'USD' ? '$' : _chartCurrency);
                // We'll use these later in the unified grid
                window._assetTargets = [
                    { label: 'TG1', type: 'input', id: 'modal-tp-input', val: assetInfo.targetPrice, symbol: currSym },
                    { label: 'TG2', type: 'input', id: 'modal-tp2-input', val: assetInfo.targetPrice2, symbol: currSym },
                    { label: 'SL', type: 'input', id: 'modal-sl-input', val: assetInfo.stopLoss, symbol: currSym },
                    { label: 'VOL %', type: 'vol', id: 'modal-vol-input', val: assetInfo.volatilityAlert }
                ];

                // Handle Watchlist logic for Delete button Visibility
                const delBtn = document.getElementById('modal-remove-watchlist-btn');
                if (delBtn) {
                    delBtn.style.display = assetInfo.isMonitored ? 'block' : 'none';
                    delBtn.onclick = () => {
                        const hasPos = transactions && transactions.length > 0;
                        if (hasPos) {
                            alert(`L'asset ${assetInfo.ticker} ha posizioni aperte.\n\nPer rimuoverlo completamente, devi prima eliminare tutte le singole transazioni associate.`);
                            return;
                        }

                        // Otherwise use the global/standard removeFromWatchlist
                        window.removeFromWatchlist(assetInfo.ticker, false);
                        closeAssetChartModal();
                    };
                }

                // Populate Unified Grid
                const grid = document.getElementById('chart-modal-grid');
                const dataArea = document.getElementById('chart-modal-data-area');

                const sd = detailsData?.summaryDetail || {};
                const ks = detailsData?.defaultKeyStatistics || {};
                const ce = detailsData?.calendarEvents || {};
                const nextDiv = ce.dividendDate || ce.exDividendDate;
                const tType = (assetInfo && assetInfo.type ? assetInfo.type.toUpperCase() : '');
                const isEquity = tType === 'AZIONI' || tType === 'EQUITY' || tType === 'STOCK' || tType === 'COMMON STOCK' || sd.trailingPE;

                const formatNum = n => n ? parseFloat(n).toFixed(2) : '—';
                const formatPct = n => n ? (parseFloat(n) * 100).toFixed(1) + '%' : '—';

                let indicatorFields = [];
                if (isEquity && Object.keys(detailsData).length > 0) {
                    indicatorFields = [
                        { label: 'ISIN', val: detailsData.dbIsin || '—' },
                        { label: 'P/E Ratio', val: formatNum(sd.trailingPE) },
                        { label: 'Forward P/E', val: formatNum(sd.forwardPE) },
                        { label: 'Div. Yield', val: formatPct(sd.dividendYield) },
                        { label: 'EPS (Tra.)', val: formatNum(ks.trailingEps) },
                        { label: 'Beta (5Y)', val: formatNum(sd.beta) },
                        { label: 'Ex-Date', val: nextDiv ? new Date(nextDiv).toLocaleDateString('it-IT') : '—' }
                    ];
                } else if (Object.keys(detailsData).length > 0) {
                    indicatorFields = [
                        { label: 'ISIN', val: detailsData.dbIsin || '—' },
                        { label: 'Prev Close', val: formatNum(sd.previousClose) },
                        { label: 'Open', val: formatNum(sd.open) },
                        { label: 'Day Low', val: formatNum(sd.dayLow) },
                        { label: 'Day High', val: formatNum(sd.dayHigh) },
                        { label: 'Daily Var', val: (assetInfo.changePercent ? `${assetInfo.changePercent > 0 ? '+' : ''}${assetInfo.changePercent.toFixed(2)}%` : '—'), type: 'var', isPos: assetInfo.changePercent >= 0 },
                        { label: 'Yield', val: formatPct(sd.trailingAnnualDividendYield || sd.dividendYield) }
                    ];
                }

                // Ensure targets always start on a new row (4 columns)
                while (indicatorFields.length % 4 !== 0) {
                    indicatorFields.push({ label: '', val: '', type: 'spacer' });
                }

                const allFields = [...indicatorFields, ...(window._assetTargets || [])];

                grid.innerHTML = allFields.map(f => {
                    if (f.type === 'input') {
                        return `
                            <div style="display: flex; flex-direction: column; gap: 3px;">
                                <span style="font-size: 8px; font-weight: 900; color: var(--mob-text-muted); text-transform: uppercase;">${f.label}</span>
                                <div style="position: relative;">
                                    <span style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-weight: 900; color: #94a3b8; font-size: 10px;">${f.symbol}</span>
                                    <input type="number" id="${f.id}" value="${f.val || ''}" step="any" style="width: 100%; padding: 6px 6px 6px 18px; border: 1px solid rgba(148,163,184,0.2); background: rgba(148,163,184,0.05); color: var(--mob-text); border-radius: 8px; font-size: 12px; font-weight: 900;" placeholder="0.00">
                                </div>
                            </div>
                        `;
                    }
                    if (f.type === 'vol') {
                        return `
                            <div style="display: flex; flex-direction: column; gap: 3px;">
                                <span style="font-size: 8px; font-weight: 900; color: var(--mob-text-muted); text-transform: uppercase;">${f.label}</span>
                                <div style="display: flex; align-items: center; gap: 4px; border: 1px solid rgba(148,163,184,0.2); background: rgba(148,163,184,0.05); padding: 3px; border-radius: 8px;">
                                    <button onclick="window.stepVol(-1)" style="width: 20px; height: 20px; border-radius: 5px; border: none; background: rgba(148,163,184,0.1); color: var(--mob-text); font-weight: bold; font-size: 10px;">-</button>
                                    <input type="number" id="${f.id}" value="${f.val || 0}" min="0" max="20" style="flex: 1; text-align: center; background: transparent; border: none; color: var(--mob-text); font-weight: 900; font-size: 11px;">
                                    <button onclick="window.stepVol(1)" style="width: 20px; height: 20px; border-radius: 5px; border: none; background: rgba(148,163,184,0.1); color: var(--mob-text); font-weight: bold; font-size: 10px;">+</button>
                                </div>
                            </div>
                        `;
                    }
                    if (f.type === 'spacer') {
                        return '<div></div>';
                    }
                    return `
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            <span style="font-size: 8px; font-weight: 900; color: var(--mob-text-muted); text-transform: uppercase; letter-spacing: 0.05em;">${f.label}</span>
                            <span style="font-size: 12px; font-weight: 900; color: ${f.type === 'var' ? (f.isPos ? 'var(--mob-emerald)' : 'var(--mob-rose)') : 'var(--mob-text)'};" class="${f.type === 'var' ? '' : 'dark:text-white'}">${f.val}</span>
                        </div>
                    `;
                }).join('');

                dataArea.style.display = 'block';
            }

            if (!_allChartData.length) {
                document.getElementById('chart-modal-loading').style.display = 'none';
                document.getElementById('chart-modal-empty').style.display = 'flex';
                return;
            }

            // 2. Filter by range
            const now = new Date();
            const fromDate = new Date(now);
            if (range === '1w') {
                fromDate.setDate(fromDate.getDate() - 7);
            } else if (range === '1m') {
                fromDate.setMonth(fromDate.getMonth() - 1);
            } else if (range === '6m') {
                fromDate.setMonth(fromDate.getMonth() - 6);
            } else if (range === '1y') {
                fromDate.setFullYear(fromDate.getFullYear() - 1);
            } else if (range === '2y') {
                fromDate.setFullYear(fromDate.getFullYear() - 2);
            } else {
                fromDate.setFullYear(fromDate.getFullYear() - 20); // 'all'
            }

            const data = _allChartData.filter(d => d.date && new Date(d.date) >= fromDate);
            const displayData = data.length > 0 ? data : _allChartData;

            const labels = displayData.map(d => d.date);
            const formatDynamicPrice = (val) => {
                const absVal = Math.abs(val);
                if (absVal >= 1000) return val.toFixed(0);
                if (absVal >= 10) return val.toFixed(1);
                if (absVal >= 1) return val.toFixed(2);
                return val.toFixed(3);
            };

            const getCurrencySymbol = (curr) => {
                if (curr === 'EUR') return '€';
                if (curr === 'USD') return '$';
                if (curr === 'GBP') return '£';
                if (curr === 'CHF') return 'CHF';
                return curr || '';
            };

            const prices = displayData.map(d => d.price);

            // Calculate daily variations
            const dailyVars = displayData.map((d, i) => {
                const fullIdx = _allChartData.findIndex(ad => ad.date === d.date);
                if (fullIdx > 0) {
                    const prev = _allChartData[fullIdx - 1];
                    const diff = d.price - prev.price;
                    return {
                        pct: (diff / prev.price) * 100,
                        val: diff
                    };
                }
                return { pct: 0, val: 0 };
            });

            // --- Calculate accurate QTY and PMC from JS transactions ---
            const sortedTxAll = [...transactions].sort((a, b) => new Date(a.date) - new Date(b.date));
            let accurateQty = 0;
            let accurateTotalCost = 0;

            for (const t of sortedTxAll) {
                const q = Math.abs(parseFloat(String(t.quantity).replace(',', '.'))) || 0;
                const p = parseFloat(String(t.price).replace(',', '.')) || 0;

                if (t.type === 'BUY') {
                    accurateTotalCost += q * p;
                    accurateQty += q;
                } else if (t.type === 'SELL' && accurateQty > 0) {
                    const avgPrice = accurateTotalCost / accurateQty;
                    accurateTotalCost -= q * avgPrice;
                    accurateQty -= q;
                }
                // NOTE: SPLIT is an audit marker — DB already retroactively adjusts
                // historical BUY/SELL quantities and prices, so do NOT re-apply here.

                if (Math.abs(accurateQty) < 0.00001) {
                    accurateQty = 0;
                    accurateTotalCost = 0;
                }
            }
            const accuratePMC = accurateQty > 0.0001 ? accurateTotalCost / accurateQty : 0;

            // Update Stats Bar
            if (dailyVars.length > 0) {
                const latestVar = dailyVars[dailyVars.length - 1];
                const vColor = latestVar.pct >= 0 ? 'var(--mob-emerald)' : 'var(--mob-rose)';
                const vSign = latestVar.pct >= 0 ? '+' : '';
                
                let qtyStr = '0';
                let gainStr = '—';
                let gainColor = 'var(--mob-text-muted)';
                let pmcStr = '—';
                let currentPriceStr = '—';
                const currSymbol = getCurrencySymbol(_chartCurrency);
                const currentPriceVal = (assetInfo && assetInfo.currentPrice > 0) ? assetInfo.currentPrice : (prices.length > 0 ? prices[prices.length - 1] : 0);
                if (currentPriceVal > 0) {
                    currentPriceStr = formatDynamicPrice(currentPriceVal);
                }

                // Use JS accurate computation over backend's potentially flawed SQL calculation
                if (accurateQty > 0.0001) {
                    const qty = accurateQty;
                    qtyStr = Number(qty.toFixed(4)).toString();
                    const gainEUR = assetInfo ? (assetInfo.totalGainEUR || 0) : 0;
                    const gainSign = gainEUR >= 0 ? '+' : '';
                    gainColor = gainEUR >= 0 ? 'var(--mob-emerald)' : 'var(--mob-rose)';

                    let pctGainStr = '';
                    const costAsset = accurateTotalCost;

                    if (accuratePMC > 0) {
                        pmcStr = formatDynamicPrice(accuratePMC);
                    }

                    if (costAsset > 0) {
                        const valAsset = qty * currentPriceVal;
                        const pctGain = ((valAsset - costAsset) / costAsset) * 100;
                        const pctSign = pctGain >= 0 ? '+' : '';
                        pctGainStr = ` (${pctSign}${pctGain.toFixed(1)}%)`;
                    }

                    const formattedGainVal = new Intl.NumberFormat('it-IT', {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0
                    }).format(Math.round(Math.abs(gainEUR)));
                    gainStr = `${gainSign}${formattedGainVal} €${pctGainStr}`;
                }

                const statsRow = document.getElementById('chart-modal-stats-row');
                if (statsRow) {
                    statsRow.style.display = 'flex';
                    statsRow.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 2px;">
                            <span style="font-size: 8px; text-transform: uppercase; color: var(--mob-text-muted); font-weight: 900; letter-spacing: 0.05em;">QTA</span>
                            <span style="font-size: 13px; font-weight: 900; color: var(--mob-text);" class="dark:text-white">${qtyStr}</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 2px;">
                            <span style="font-size: 8px; text-transform: uppercase; color: var(--mob-text-muted); font-weight: 900; letter-spacing: 0.05em;">PMC</span>
                            <span style="font-size: 13px; font-weight: 900; color: var(--mob-text);" class="dark:text-white">${pmcStr !== '—' ? pmcStr + ' ' + currSymbol : pmcStr}</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 2px;">
                            <span style="font-size: 8px; text-transform: uppercase; color: var(--mob-text-muted); font-weight: 900; letter-spacing: 0.05em;">Prezzo</span>
                            <span style="font-size: 13px; font-weight: 900; color: #3b82f6;" class="text-blue-500">${currentPriceStr !== '—' ? currentPriceStr + ' ' + currSymbol : currentPriceStr}</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 2px;">
                            <span style="font-size: 8px; text-transform: uppercase; color: var(--mob-text-muted); font-weight: 900; letter-spacing: 0.05em;">GAIN Assoluto</span>
                            <span style="font-size: 13px; font-weight: 900; color: ${gainColor};">${gainStr}</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 2px;">
                            <span style="font-size: 8px; text-transform: uppercase; color: var(--mob-text-muted); font-weight: 900; letter-spacing: 0.05em;">GAIN DAY</span>
                            <span style="font-size: 13px; font-weight: 900; color: ${vColor};">${vSign}${latestVar.pct.toFixed(1)}%</span>
                        </div>
                    `;
                }

                const headerTitle = document.getElementById('chart-modal-title');
                if (headerTitle) {
                    headerTitle.textContent = `History: ${_chartTicker}`;
                    if (headerTitle.parentElement) {
                        headerTitle.parentElement.style.flex = "";
                    }
                    headerTitle.style.display = "";
                    headerTitle.style.alignItems = "";
                    headerTitle.style.justifyContent = "";
                }
            } else {
                const statsRow = document.getElementById('chart-modal-stats-row');
                if (statsRow) statsRow.style.display = 'none';
            }
            // We'll create a dictionary of transactions by date for easy lookup
            const tradesByDate = {};
            transactions.forEach(t => {
                if (t.type !== 'BUY' && t.type !== 'SELL') return;
                const dt = t.date;
                if (!tradesByDate[dt]) tradesByDate[dt] = [];
                tradesByDate[dt].push(t);
            });

            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            const lastP = prices[prices.length - 1];
            const firstP = prices[0];
            const isUp = lastP >= firstP;
            const lineColor = isUp ? 'rgb(16,185,129)' : 'rgb(239,68,68)';
            const fillColor = isUp ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)';

            // Prepare TP/SL Annotations
            const annotations = {};
            let adjustedMin = minP;
            let adjustedMax = maxP;

            if (assetInfo && assetInfo.targetPrice) {
                const tp = parseFloat(assetInfo.targetPrice);
                annotations.tpLine = {
                    type: 'line',
                    yMin: tp,
                    yMax: tp,
                    borderColor: 'rgb(16, 185, 129)',
                    borderWidth: 2,
                    borderDash: [6, 6],
                    label: {
                        display: true,
                        content: `TP: ${tp.toFixed(2)}`,
                        position: 'end',
                        backgroundColor: 'rgba(16, 185, 129, 0.8)',
                        color: 'white',
                        font: { size: 10, weight: 'bold' }
                    }
                };
                adjustedMax = Math.max(adjustedMax, tp);
                adjustedMin = Math.min(adjustedMin, tp);
            }

            if (assetInfo && assetInfo.stopLoss) {
                const sl = parseFloat(assetInfo.stopLoss);
                annotations.slLine = {
                    type: 'line',
                    yMin: sl,
                    yMax: sl,
                    borderColor: 'rgb(239, 68, 68)',
                    borderWidth: 2,
                    borderDash: [6, 6],
                    label: {
                        display: true,
                        content: `SL: ${sl.toFixed(2)}`,
                        position: 'end',
                        backgroundColor: 'rgba(239, 68, 68, 0.8)',
                        color: 'white',
                        font: { size: 10, weight: 'bold' }
                    }
                };
                adjustedMax = Math.max(adjustedMax, sl);
                adjustedMin = Math.min(adjustedMin, sl);
            }

            // Current Price Annotation
            if (prices.length > 0) {
                const lastPrice = prices[prices.length - 1];
                annotations.lastPriceLine = {
                    type: 'line',
                    yMin: lastPrice,
                    yMax: lastPrice,
                    borderColor: 'rgba(59, 130, 246, 0.6)',
                    borderWidth: 1,
                    borderDash: [4, 4],
                    label: {
                        display: true,
                        content: `NOW: ${lastPrice.toFixed(2)}`,
                        position: 'start',
                        backgroundColor: 'rgba(59, 130, 246, 0.8)',
                        color: 'white',
                        font: { size: 9, weight: 'bold' }
                    }
                };
                // Ensure Y-axis also includes current price if it's an outlier
                adjustedMax = Math.max(adjustedMax, lastPrice);
                adjustedMin = Math.min(adjustedMin, lastPrice);
            }

            document.getElementById('chart-modal-loading').style.display = 'none';
            document.getElementById('chart-modal-content').style.display = 'block';
            document.getElementById('chart-modal-points').textContent = `${displayData.length} data points`;
            document.getElementById('chart-modal-range-label').textContent =
                `${displayData[0]?.date} → ${displayData[displayData.length - 1]?.date}`;
            document.getElementById('chart-modal-range-label').style.color = isUp ? 'rgb(16,185,129)' : 'rgb(239,68,68)';

            if (_assetChartInstance) _assetChartInstance.destroy();
            const ctx = document.getElementById('asset-history-chart').getContext('2d');

            // Filter trades that fall within the current display range
            const buyPoints = [];
            const sellPoints = [];

            // We use a scatter dataset approach or point style override. 
            // Better to use separate datasets for markers to avoid cluttering the main line
            const tradeDatasets = [];

            // Snap transaction dates to the closest available label to handle weekend/holiday transactions
            const snapToLabel = (txDate) => {
                if (labels.includes(txDate)) return txDate;
                const txD = new Date(txDate);
                let closest = null;
                let minDiff = Infinity;
                labels.forEach(l => {
                    const diff = Math.abs(new Date(l) - txD);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = l;
                    }
                });
                return closest || txDate;
            };

            transactions.forEach(t => {
                t.snappedDate = snapToLabel(t.date);
            });

            const buys = transactions.filter(t => t.type === 'BUY' && t.snappedDate);
            const sells = transactions.filter(t => t.type === 'SELL' && t.snappedDate);
            const divs = transactions.filter(t => t.type === 'DIVIDEND' && t.snappedDate);

            if (buys.length > 0) {
                tradeDatasets.push({
                    label: 'BUY',
                    data: buys.map(t => ({ x: t.snappedDate, y: t.price })),
                    borderColor: 'rgb(16,185,129)',
                    backgroundColor: 'rgb(16,185,129)',
                    pointStyle: 'triangle',
                    pointRadius: 7,
                    pointHoverRadius: 10,
                    showLine: false,
                    yAxisID: 'y'
                });
            }

            if (sells.length > 0) {
                tradeDatasets.push({
                    label: 'SELL',
                    data: sells.map(t => ({ x: t.snappedDate, y: t.price })),
                    borderColor: 'rgb(239,68,68)',
                    backgroundColor: 'rgb(239,68,68)',
                    pointStyle: 'circle',
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    showLine: false,
                    yAxisID: 'y'
                });
            }

            if (divs.length > 0) {
                tradeDatasets.push({
                    label: 'DIVIDEND',
                    data: divs.map(t => ({ x: t.snappedDate, y: t.price })),
                    borderColor: 'rgb(245,158,11)',
                    backgroundColor: 'rgb(245,158,11)',
                    pointStyle: 'rectRot',
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    showLine: false,
                    yAxisID: 'y'
                });
            }

            // Calculate Performance Visualization (PMC Basis + Gain/Loss Area)
            const sortedTx = [...transactions].sort((a, b) => new Date(a.date) - new Date(b.date));
            let currentQty = 0;
            let currentTotalCost = 0;
            let txIndex = 0;
            let lastValidPMC = null;

            const basisPrices = []; // PMC line
            const heldPrices = [];  // Current price line for filling

            labels.forEach((date, idx) => {
                const dayBeforeQty = currentQty;

                // Process all transactions chronologically up to and including 'date'
                while (txIndex < sortedTx.length && sortedTx[txIndex].date <= date) {
                    const t = sortedTx[txIndex];
                    const q = Math.abs(parseFloat(String(t.quantity).replace(',', '.'))) || 0;
                    const p = parseFloat(String(t.price).replace(',', '.')) || 0;

                    if (t.type === 'BUY') {
                        currentTotalCost += q * p;
                        currentQty += q;
                    } else if (t.type === 'SELL' && currentQty > 0) {
                        const avgPrice = currentTotalCost / currentQty;
                        currentTotalCost -= q * avgPrice;
                        currentQty -= q;
                    }
                    // NOTE: SPLIT is an audit marker — DB already retroactively adjusts
                    // historical BUY/SELL quantities and prices, so do NOT re-apply here.


                    // Prevent floating point residue from causing ghost positions
                    if (Math.abs(currentQty) < 0.00001) {
                        currentQty = 0;
                        currentTotalCost = 0;
                    }
                    txIndex++;
                }

                if (currentQty > 0.0001) {
                    lastValidPMC = currentTotalCost / currentQty;
                }

                const isHolding = dayBeforeQty > 0.0001 || currentQty > 0.0001;
                if (isHolding) {
                    basisPrices.push(lastValidPMC);
                    heldPrices.push(prices[idx]);
                } else {
                    basisPrices.push(null);
                    heldPrices.push(null);
                }
            });

            const isDark = document.documentElement.classList.contains('dark');
            let tickColor = isDark ? '#ffffff' : '#000000';
            let gridColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';

            try {
                const chartWrapper = document.getElementById('chart-modal-content')?.parentElement;
                if (chartWrapper) {
                    chartWrapper.style.backgroundColor = isDark ? '#0b0f1a' : '#f0f4f8';
                    const bg = window.getComputedStyle(chartWrapper).backgroundColor;
                    const rgb = bg?.match(/\d+/g);
                    if (rgb && rgb.length >= 3) {
                        const r = parseInt(rgb[0]);
                        const g = parseInt(rgb[1]);
                        const b = parseInt(rgb[2]);
                        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
                        if (brightness < 128) {
                            tickColor = '#ffffff';
                            gridColor = 'rgba(255, 255, 255, 0.1)';
                        } else {
                            tickColor = '#000000';
                            gridColor = 'rgba(0, 0, 0, 0.1)';
                        }
                    }
                }
            } catch (e) {
                console.error("Error computing chart wrapper style:", e);
            }

            // Clean up old tradeDatasets to add our new ones at the bottom (z-layer)
            // But we want markers on top, area at bottom
            const perfAreaSet = {
                label: 'Performance',
                data: heldPrices,
                borderColor: 'transparent',
                backgroundColor: 'transparent', // controlled by fill above/below
                fill: {
                    target: '+1', // Fill towards Basis set (which we'll unshift after this)
                    above: isDark ? 'rgba(16, 185, 129, 0.25)' : 'rgba(16, 185, 129, 0.15)',
                    below: isDark ? 'rgba(239, 68, 68, 0.25)' : 'rgba(239, 68, 68, 0.15)'
                },
                pointRadius: 0,
                tension: 0.1,
                yAxisID: 'y'
            };

            const basisSet = {
                label: 'Avg Cost Basis',
                data: basisPrices,
                borderColor: isDark ? 'rgba(250, 204, 21, 0.8)' : 'rgba(234, 179, 8, 0.8)', // Yellow dashed line for PMC
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                fill: false,
                tension: 0,
                yAxisID: 'y'
            };

            // unshift ensures these are at the start of datasets array (behind others)
            tradeDatasets.unshift(perfAreaSet, basisSet);

            _assetChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: _chartTicker,
                            data: prices,
                            borderColor: lineColor,
                            borderWidth: 2,
                            pointRadius: displayData.length > 100 ? 0 : 2,
                            pointHoverRadius: 4,
                            fill: false,
                            tension: 0.1,
                            yAxisID: 'y'
                        },
                        ...tradeDatasets
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    layout: {
                        padding: {
                            left: 0,
                            right: 0,
                            top: 8,
                            bottom: 0
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    const datasetLabel = context.dataset.label || '';
                                    if (datasetLabel === 'BUY' || datasetLabel === 'SELL' || datasetLabel === 'DIVIDEND') {
                                        const dt = context.label;
                                        const trades = tradesByDate[dt] || [];
                                        const trade = trades.find(tr => tr.type === datasetLabel);
                                        if (trade) {
                                            return ` ${trade.type}: ${_chartTicker} (${trade.quantity} @ ${formatDynamicPrice(trade.price)})`;
                                        }
                                    }
                                    // Default price & variation
                                    if (context.dataset.label === _chartTicker) {
                                        const idx = context.dataIndex;
                                        const v = dailyVars[idx];
                                        const sign = v.pct >= 0 ? '+' : '';
                                        const price = formatDynamicPrice(context.parsed.y);
                                        return ` Price: ${price} ${_chartCurrency} (${sign}${v.pct.toFixed(1)}%)`;
                                    }
                                    return null;
                                },
                                title: function (tooltipItems) {
                                    const datasetLabel = tooltipItems[0].dataset.label || '';
                                    if (datasetLabel === 'BUY' || datasetLabel === 'SELL' || datasetLabel === 'DIVIDEND') {
                                        return tooltipItems[0].label;
                                    }
                                    return null;
                                }
                            }
                        },
                        annotation: {
                            annotations: annotations
                        }
                    },
                    scales: {
                        x: {
                            offset: false,
                            ticks: {
                                maxTicksLimit: 8,
                                maxRotation: 45,
                                minRotation: 45,
                                font: { size: 9 },
                                color: tickColor,
                                callback: function (value) {
                                    const dateStr = this.getLabelForValue(value);
                                    if (!dateStr) return '';
                                    const parts = dateStr.split('-');
                                    if (parts.length !== 3) return dateStr;
                                    const [yyyy, mm, dd] = parts;
                                    const yy = yyyy.substring(2);

                                    if (range === '1d' || range === '1w' || range === '1m') {
                                        return `${dd}/${mm}`;
                                    } else if (range === '6m' || range === '1y') {
                                        return `${dd}/${mm}/${yy}`;
                                    } else {
                                        return `${mm}/${yy}`;
                                    }
                                }
                            },
                            grid: { color: gridColor }
                        },
                        y: {
                            ticks: {
                                mirror: true,
                                callback: v => formatDynamicPrice(v),
                                color: tickColor,
                                font: { size: 10 }
                            },
                            grid: { color: gridColor },
                            // SCALE strictly on the min/max of the period, including TP/SL
                            min: adjustedMin * 0.99,
                            max: adjustedMax * 1.01
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Chart load error:', err);
            document.getElementById('chart-modal-loading').style.display = 'none';
            document.getElementById('chart-modal-empty').style.display = 'flex';
        }
    };

    // ─── AI Analysis Logic for Standalone Modal ────────────────────────────────────────────────────────

    let _aiModalTicker = null;
    let _aiModalName = null;

    window.openAssetAiHistoryModal = function (ticker, name, currency) {
        _aiModalTicker = ticker;
        _aiModalName = name;

        let modal = document.getElementById('asset-ai-history-modal');
        if (!modal) {
            const isDark = document.documentElement.classList.contains('dark');
            const backdropColor = isDark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.7)';

            modal = document.createElement('div');
            modal.id = 'asset-ai-history-modal';
            modal.style.cssText = `display: none; position: fixed; inset: 0; z-index: 10000; align-items: center; justify-content: center; background-color: ${backdropColor}; backdrop-filter: blur(12px); padding: 16px; flex-direction: column;`;

            modal.innerHTML = `
                <div class="bg-white dark:bg-surface-dark border border-slate-200 dark:border-slate-800" style="width: 100%; max-width: 500px; max-height: 85vh; border-radius: 20px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); display: flex; flex-direction: column; overflow: hidden;">
                    <!-- Header -->
                    <div class="bg-slate-50 dark:bg-slate-900/50" style="padding: 16px 20px; border-bottom: 1px solid rgba(148,163,184,0.1); display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <h3 class="font-black text-sm md:text-lg dark:text-white" style="margin: 0; display: flex; align-items: center; gap: 8px;">
                                <span class="material-symbols-outlined" style="background: linear-gradient(135deg, var(--mob-primary), #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">smart_toy</span> 
                                <span id="ai-modal-title"></span>
                            </h3>
                            <p class="text-[9px] text-slate-400 uppercase tracking-widest font-bold" id="ai-modal-subtitle" style="margin: 2px 0 0 0;"></p>
                        </div>
                        <button onclick="document.getElementById('asset-ai-history-modal').style.display='none'" class="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700" style="background: rgba(148,163,184,0.1); border: none; border-radius: 50%; cursor: pointer; padding: 6px; display: flex; transition: all 0.2s;">
                            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
                        </button>
                    </div>
                    
                    <!-- Content Area -->
                    <div class="bg-white dark:bg-slate-900" style="padding: 20px; flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                            <h4 class="text-slate-900 dark:text-white" style="font-size: 13px; font-weight: 900; display: flex; align-items: center; gap: 4px; margin: 0;">
                                Storico Analisi
                            </h4>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <select id="ai-modal-engine-select" style="font-size: 11px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.3); background: transparent; cursor: pointer; outline: none; font-weight: 600;" class="text-slate-700 dark:text-slate-300">
                                    <option value="">Default (Caricamento...)</option>
                                </select>
                                <button id="ai-modal-run-btn" onclick="window.runAssetAi()" style="background: var(--mob-primary); color: white; padding: 8px 16px; border-radius: 10px; border: none; font-weight: bold; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(19,91,236,0.2);">
                                    <span class="material-symbols-outlined" style="font-size: 16px;">add</span> Nuova Analisi
                                </button>
                            </div>
                        </div>
                        
                        <div id="ai-modal-list" style="overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; -webkit-overflow-scrolling: touch;">
                            <!-- AI items injected here -->
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            // Close on backdrop click
            modal.addEventListener('click', function (e) {
                if (e.target === this) this.style.display = 'none';
            });
        }

        document.getElementById('ai-modal-title').textContent = `AI: ${ticker}`;
        document.getElementById('ai-modal-subtitle').textContent = name || '';
        modal.style.display = 'flex';

        window.loadAssetAiHistory(ticker);

        // Fetch available engines
        fetch('/api/ai/available-engines').then(r => r.json()).then(data => {
            const select = document.getElementById('ai-modal-engine-select');
            if (select && data.engines) {
                select.innerHTML = data.engines.map(e => {
                    let label = e;
                    if (e === 'Both') label = 'Gemini + Qwen';
                    else label = e.replace(/_(Free|Pay)/, ' ($1)');
                    return `<option value="${e}" ${e === data.default ? 'selected' : ''}>${label}</option>`;
                }).join('');
            }
        }).catch(e => console.error("Error loading engines", e));
    };

    window.loadAssetAiHistory = async function (ticker) {
        const listEl = document.getElementById('ai-modal-list');
        if (!listEl) return;
        listEl.innerHTML = '<div style="display:flex; justify-content:center; align-items:center; height: 100px;"><span class="material-symbols-outlined animate-spin" style="font-size: 28px; color: var(--mob-primary);">sync</span></div>';

        try {
            const res = await fetch('/api/assets/' + encodeURIComponent(ticker) + '/ai-history?t=' + Date.now());
            const history = await res.json();

            if (!history || history.length === 0) {
                listEl.innerHTML = `
                    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height: 150px; text-align:center; color: #94a3b8;">
                        <span class="material-symbols-outlined" style="font-size: 32px; margin-bottom: 8px; opacity: 0.5;">history</span>
                        <div style="font-size: 12px; font-weight: bold;">Nessuna analisi IA presente</div>
                        <div style="font-size: 10px;">Clicca su "Nuova Analisi" per iniziare</div>
                    </div>`;
                return;
            }

            const isDark = document.documentElement.classList.contains('dark');
            const itemBg = isDark ? 'rgba(30,41,59,0.5)' : '#ffffff';

            listEl.innerHTML = history.map(item => {
                const dObj = new Date(item.created_at);
                const date = dObj.toLocaleDateString() + ' ' + dObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                let actionColor = 'rgba(148,163,184,0.1)';

                const engine = item.engine || 'X';
                let engineIcon = 'smart_toy';
                if (engine === 'Gemini') engineIcon = 'auto_awesome';
                else if (engine === 'Qwen') engineIcon = 'chat_spark';
                else if (engine === 'Agnes') engineIcon = 'psychiatry';
                else if (engine === 'OpenAI') engineIcon = 'data_exploration';
                else if (engine === 'X') engineIcon = 'close';

                let actionTextColor = '#64748b';
                if (item.action === 'BUY' || item.action === 'INCREASE') {
                    actionColor = 'rgba(16,185,129,0.1)';
                    actionTextColor = 'rgb(16,185,129)';
                } else if (item.action === 'SELL' || item.action === 'DECREASE') {
                    actionColor = 'rgba(239,68,68,0.1)';
                    actionTextColor = 'rgb(239,68,68)';
                }

                return `
                    <div style="border: 1px solid rgba(148,163,184,0.2); border-radius: 14px; padding: 14px; background: ${itemBg}; position: relative; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="font-size: 10px; font-weight: 900; color: #94a3b8; display: flex; align-items: center; gap: 4px;">
                                    <span class="material-symbols-outlined" style="font-size: 14px;">calendar_today</span> ${date}
                                </span>
                                <span style="font-size: 10px; font-weight: 900; color: #64748b; background: rgba(148,163,184,0.1); padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 3px;" title="Motore IA: ${engine}">
                                    <span class="material-symbols-outlined" style="font-size: 12px;">${engineIcon}</span> ${engine}
                                </span>
                                ${item.targetPrice ? `<span style="font-size: 10px; font-weight: 900; color: #64748b; background: rgba(148,163,184,0.1); padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 3px;" title="Fair Value">
                                    <span class="material-symbols-outlined" style="font-size: 12px;">monetization_on</span> FV: ${window.formatAiFv ? window.formatAiFv(item.targetPrice, '') : item.targetPrice}
                                </span>` : ''}
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <span style="padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 900; background: ${actionColor}; color: ${actionTextColor}; border: 1px solid ${actionTextColor}; box-shadow: 0 2px 8px ${actionColor};">${item.action}</span>
                                <button onclick="window.deleteAssetAiHistory(${item.id}, '${ticker}')" style="background: rgba(239,68,68,0.1); border: none; border-radius: 6px; color: rgb(239,68,68); padding: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;" class="hover:bg-red-500/20">
                                    <span class="material-symbols-outlined" style="font-size: 14px;">delete</span>
                                </button>
                            </div>
                        </div>
                        <div class="text-slate-700 dark:text-slate-300" style="font-size: 12px; opacity: 0.9; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 12px; line-height: 1.5;">
                            ${item.reasoning.replace(/\\n/g, ' ').replace(/[*#]/g, '')}
                        </div>
                        <button onclick="window.openAssetAiDetail('${ticker}', '${item.action}', \`${(item.reasoning || '').replace(/`/g, '\\`').replace(/'/g, "\\'").replace(/"/g, '&quot;')}\`, '${date}')" style="width: 100%; padding: 8px; border-radius: 8px; border: 1px solid rgba(148,163,184,0.3); background: rgba(148,163,184,0.05); font-size: 11px; font-weight: 900; cursor: pointer; transition: all 0.2s;" class="text-indigo-600 dark:text-indigo-400 hover:bg-slate-200 dark:hover:bg-slate-700">Espandi Dettaglio</button>
                    </div>
                `;
            }).join('');
        } catch (e) {
            listEl.innerHTML = '<div style="text-align:center; padding: 20px; color: rgb(239,68,68); font-weight: bold; font-size: 12px;">Errore di caricamento</div>';
        }
    };

    window.runAssetAi = async function () {
        if (!_aiModalTicker) return;
        const btn = document.getElementById('ai-modal-run-btn');
        const listEl = document.getElementById('ai-modal-list');

        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined animate-spin" style="font-size: 16px;">sync</span> Attendere...';
        listEl.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height: 180px; text-align:center; color: var(--mob-primary);">
                <span class="material-symbols-outlined animate-spin" style="font-size: 48px; margin-bottom: 12px; background: linear-gradient(135deg, var(--mob-primary), #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">smart_toy</span>
                <div style="font-size: 14px; font-weight: 900;">Generazione Analisi IA in corso...</div>
                <div style="font-size: 11px; opacity: 0.7; margin-top: 8px;" id="ai-modal-progress-text">Inizializzazione</div>
            </div>`;

        const engineSelect = document.getElementById('ai-modal-engine-select');
        const engine = engineSelect && engineSelect.value ? '?engine=' + encodeURIComponent(engineSelect.value) : '';
        const source = new EventSource('/api/assets/' + encodeURIComponent(_aiModalTicker) + '/ai-analysis' + engine);

        source.addEventListener('progress', function (e) {
            const data = JSON.parse(e.data);
            const pt = document.getElementById('ai-modal-progress-text');
            if (pt) pt.textContent = data.message;
        });

        source.addEventListener('complete', function (e) {
            source.close();
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">add</span> Nuova Analisi';
            window.loadAssetAiHistory(_aiModalTicker);
            if (typeof window.loadAssets === 'function') window.loadAssets();
            if (typeof window.loadWatchlist === 'function') window.loadWatchlist();
            if (typeof window.loadPortfolioDetails === 'function') window.loadPortfolioDetails();
        });

        source.addEventListener('error', function (e) {
            source.close();
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">refresh</span> Riprova';

            let errorData = {};
            try { errorData = JSON.parse(e.data || '{}'); } catch (err) { }
            const errorMsg = errorData.error || "Errore sconosciuto durante l'analisi IA";

            listEl.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 24px; text-align:center; color: rgb(239,68,68); background: rgba(239,68,68,0.1); border-radius: 12px; margin-bottom: 16px; border: 1px solid rgba(239,68,68,0.3);">
                    <span class="material-symbols-outlined" style="font-size: 40px; margin-bottom: 8px;">error</span>
                    <div style="font-size: 14px; font-weight: 900;">Analisi IA Fallita</div>
                    <div style="font-size: 11px; margin-top: 8px; font-family: monospace; word-break: break-word;">${errorMsg}</div>
                </div>
            `;
        });
    };

    window.deleteAssetAiHistory = async function (id, ticker) {
        if (!confirm('Eliminare analisi?')) return;
        try {
            const res = await fetch('/api/assets/ai-history/' + id, { method: 'DELETE' });
            if ((await res.json()).success) {
                window.loadAssetAiHistory(ticker);
                if (typeof window.loadAssets === 'function') window.loadAssets();
                if (typeof window.loadWatchlist === 'function') window.loadWatchlist();
                if (typeof window.loadPortfolioDetails === 'function') window.loadPortfolioDetails();
            }
        } catch (e) { }
    };

    window.openAssetAiDetail = function (ticker, action, reasoning, date) {
        let detailModal = document.getElementById('chart-ai-detail-modal');
        if (!detailModal) {
            const isDark = document.documentElement.classList.contains('dark');
            const backdropColor = isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)';
            detailModal = document.createElement('div');
            detailModal.id = 'chart-ai-detail-modal';
            detailModal.style.cssText = `display: none; position: fixed; inset: 0; z-index: 20000; align-items: center; justify-content: center; background-color: ${backdropColor}; backdrop-filter: blur(8px); padding: 16px;`;

            const target = document.body;
            target.appendChild(detailModal);

            // Close on backdrop click
            detailModal.addEventListener('click', function (e) {
                if (e.target === this) this.style.display = 'none';
            });
        }

        let actionColor = 'rgba(148,163,184,0.1)';
        let actionTextColor = '#64748b';
        if (action === 'BUY' || action === 'INCREASE') {
            actionColor = 'rgba(16,185,129,0.1)';
            actionTextColor = 'rgb(16,185,129)';
        } else if (action === 'SELL' || action === 'DECREASE') {
            actionColor = 'rgba(239,68,68,0.1)';
            actionTextColor = 'rgb(239,68,68)';
        }

        // Formatta markdown basico per una UI accattivante
        let formattedReasoning = reasoning.replace(/\\n/g, '\n');

        // Headings
        formattedReasoning = formattedReasoning.replace(/^### (.*$)/gim, '<h4 class="text-indigo-600 dark:text-indigo-400" style="font-size: 13px; font-weight: 900; margin-top: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;"><span class="material-symbols-outlined" style="font-size: 14px;">psychiatry</span> $1</h4>');
        formattedReasoning = formattedReasoning.replace(/^## (.*$)/gim, '<h3 class="text-indigo-600 dark:text-indigo-400" style="font-size: 14px; font-weight: 900; margin-top: 16px; margin-bottom: 8px; border-bottom: 1px solid rgba(148,163,184,0.1); padding-bottom: 4px;">$1</h3>');
        formattedReasoning = formattedReasoning.replace(/^# (.*$)/gim, '<h2 class="text-indigo-600 dark:text-indigo-400" style="font-size: 15px; font-weight: 900; margin-top: 18px; margin-bottom: 10px;">$1</h2>');

        // Bold
        formattedReasoning = formattedReasoning.replace(/\*\*(.*?)\*\*/g, '<strong class="text-indigo-600 dark:text-indigo-400" style="font-weight: 900; background: rgba(148,163,184,0.1); padding: 0 4px; border-radius: 4px;">$1</strong>');

        // Italics
        formattedReasoning = formattedReasoning.replace(/\*(.*?)\*/g, '<em class="text-slate-500 dark:text-slate-400">$1</em>');

        // Lists
        formattedReasoning = formattedReasoning.replace(/^\s*[-*]\s+(.*)$/gim, '<div style="display: flex; gap: 8px; margin-bottom: 6px; padding-left: 4px;"><span class="text-indigo-600 dark:text-indigo-400" style="font-size: 14px; font-weight: 900;">&bull;</span><span style="flex: 1;">$1</span></div>');
        formattedReasoning = formattedReasoning.replace(/^\s*\d+\.\s+(.*)$/gim, '<div style="display: flex; gap: 8px; margin-bottom: 6px; padding-left: 4px;"><span class="text-indigo-600 dark:text-indigo-400" style="font-size: 14px; font-weight: 900;">&bull;</span><span style="flex: 1;">$1</span></div>');

        // Newlines to BR
        formattedReasoning = formattedReasoning.replace(/\n\n/g, '<div style="height: 12px;"></div>');
        formattedReasoning = formattedReasoning.replace(/\n/g, '<br>');

        detailModal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800" style="border-radius: 20px; width: 95%; max-width: 600px; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3);">
                <div class="bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800" style="padding: 16px; display: flex; justify-content: space-between; align-items: center;">
                    <h3 class="text-indigo-600 dark:text-indigo-400" style="font-size: 14px; font-weight: 900; display: flex; align-items: center; gap: 8px; margin: 0;"><span class="material-symbols-outlined" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">smart_toy</span> IA: ${ticker}</h3>
                    <button onclick="document.getElementById('chart-ai-detail-modal').style.display='none'" class="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700" style="background:rgba(148,163,184,0.1); border-radius:50%; border:none; cursor:pointer; display: flex; padding: 6px; transition: all 0.2s;"><span class="material-symbols-outlined" style="font-size: 18px;">close</span></button>
                </div>
                <div style="padding: 20px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; -webkit-overflow-scrolling: touch;">
                    <div style="text-align: center;"><span style="padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 900; background: ${actionColor}; color: ${actionTextColor}; border: 1px solid ${actionTextColor}; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px ${actionColor};"><span class="material-symbols-outlined" style="font-size: 14px;">${action === 'BUY' || action === 'INCREASE' ? 'trending_up' : (action === 'SELL' || action === 'DECREASE' ? 'trending_down' : 'horizontal_rule')}</span> ${action}</span></div>
                    <div class="text-slate-800 dark:text-slate-200" style="font-size: 12px; line-height: 1.6; margin-top: 8px;">${formattedReasoning}</div>
                    <div style="font-size: 10px; font-weight: bold; color: #94a3b8; text-align: right; margin-top: 12px; border-top: 1px dashed rgba(148,163,184,0.2); padding-top: 12px; display: flex; justify-content: flex-end; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 12px;">update</span> Aggiornato il: ${date}
                    </div>
                </div>
            </div>
        `;
        detailModal.style.display = 'flex';
    };

    // Ensure we expose necessary functions globally
    document.addEventListener('DOMContentLoaded', () => {
        ensureModalExists();
    });
})();
