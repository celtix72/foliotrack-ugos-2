/**
 * Asset Chart Component for M2T
 * Centralizes historical chart modal and BUY/SELL visualization.
 */

(function() {
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

        const modalHtml = `
        <div id="asset-chart-modal" 
             style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 9999; align-items: center; justify-content: center; background-color: ${backdropColor}; backdrop-filter: blur(12px); padding: 0.5rem; flex-direction: column;"
             class="flex">
            <div class="bg-white dark:bg-[#111722] border border-slate-200 dark:border-slate-800" 
                 style="width: 100%; max-width: 900px; max-height: 94vh; position: relative; z-index: 10000; display: flex; flex-direction: column; border-radius: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden;">
                
                <!-- Header -->
                <div style="padding: 16px 20px; border-bottom: 1px solid rgba(148,163,184,0.1); display: flex; justify-content: space-between; align-items: center; background: var(--mob-surface); ">
                    <div>
                        <h3 class="font-black text-sm md:text-lg dark:text-white" id="chart-modal-title" style="margin: 0;">Asset History</h3>
                        <p class="text-[9px] text-slate-400 uppercase tracking-widest font-bold" id="chart-modal-subtitle" style="margin: 2px 0 0 0;"></p>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div id="chart-range-btns" style="display: flex; gap: 4px;">
                            <button onclick="loadAssetChart(null, '1d')" data-range="1d" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1D</button>
                            <button onclick="loadAssetChart(null, '1w')" data-range="1w" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1W</button>
                            <button onclick="loadAssetChart(null, '1m')" data-range="1m" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1M</button>
                            <button onclick="loadAssetChart(null, '6m')" data-range="6m" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">6M</button>
                            <button onclick="loadAssetChart(null, '1y')" data-range="1y" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">1Y</button>
                            <button onclick="loadAssetChart(null, 'all')" data-range="all" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(148,163,184,0.2); background: transparent; color: var(--mob-text-muted); cursor: pointer; font-size: 10px; font-weight: bold;">ALL</button>
                        </div>
                        <button onclick="closeAssetChartModal()" style="background: rgba(148,163,184,0.1); border: none; border-radius: 50%; cursor: pointer; color: #94a3b8; padding: 6px; display: flex;">
                            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
                        </button>
                    </div>
                </div>
                
                <!-- Chart Area (Compact) -->
                <div style="padding: 10px 16px; flex: 1; min-height: 180px; display: flex; flex-direction: column; background: var(--mob-bg); overflow: hidden;">
                    <div id="chart-modal-loading" style="display: none; flex: 1; align-items: center; justify-content: center;">
                        <span class="material-symbols-outlined animate-spin" style="font-size: 24px; color: var(--mob-primary);">progress_activity</span>
                    </div>
                    <div id="chart-modal-empty" style="display: none; flex: 1; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8;">
                        <span class="material-symbols-outlined" style="font-size: 32px;">bar_chart_off</span>
                        <p style="font-weight: bold; margin-top: 8px; font-size: 11px;">No historical data.</p>
                    </div>
                    <div id="chart-modal-content" style="display: none; flex: 1; min-height: 160px; position: relative;">
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
        document.getElementById('asset-chart-modal').addEventListener('click', function(e) {
            if (e.target === this) closeAssetChartModal();
        });
    }

    window.stepVol = function(val) {
        const input = document.getElementById('modal-vol-input');
        if (!input) return;
        let v = parseInt(input.value || 0) + val;
        if (v < 0) v = 0;
        if (v > 20) v = 20;
        input.value = v;
    };

    window.closeAssetChartModal = function() {
        const modal = document.getElementById('asset-chart-modal');
        if (modal) modal.style.display = 'none';
        if (_assetChartInstance) { 
            _assetChartInstance.destroy(); 
            _assetChartInstance = null; 
        }
    };

    window.saveModalAlerts = async function() {
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

    window.openAssetChartModal = function(ticker, name, currency) {
        window.loadAssetChart(ticker, '1y');
    };

    window.loadAssetChart = async function(ticker, range = '1y') {
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
            const allAssets = await assetRes.json();
            let detailsData = {};
            if (detailsRes && detailsRes.ok) {
                try { detailsData = await detailsRes.json(); } catch(e) {}
            }

            const assetInfo = allAssets.find(a => a.ticker === _chartTicker);
            
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
                            <span style="font-size: 12px; font-weight: 900; color: var(--mob-text);" class="dark:text-white">${f.val}</span>
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
            if (range === '1d') {
                fromDate.setHours(0,0,0,0);
            } else if (range === '1w') {
                fromDate.setDate(fromDate.getDate() - 7);
            } else if (range === '1m') {
                fromDate.setMonth(fromDate.getMonth() - 1);
            } else if (range === '6m') {
                fromDate.setMonth(fromDate.getMonth() - 6);
            } else if (range === '1y') {
                fromDate.setFullYear(fromDate.getFullYear() - 1);
            } else {
                fromDate.setFullYear(fromDate.getFullYear() - 20); // 'all'
            }

            const data = _allChartData.filter(d => d.date && new Date(d.date) >= fromDate);
            const displayData = data.length > 0 ? data : _allChartData;

            const labels = displayData.map(d => d.date);
            const prices = displayData.map(d => d.price);
            
            // Map BUY/SELL points
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
                `${displayData[0]?.date} → ${displayData[displayData.length-1]?.date}`;
            document.getElementById('chart-modal-range-label').style.color = isUp ? 'rgb(16,185,129)' : 'rgb(239,68,68)';

            if (_assetChartInstance) _assetChartInstance.destroy();
            const ctx = document.getElementById('asset-history-chart').getContext('2d');
            
            // Filter trades that fall within the current display range
            const buyPoints = [];
            const sellPoints = [];
            
            // We use a scatter dataset approach or point style override. 
            // Better to use separate datasets for markers to avoid cluttering the main line
            const tradeDatasets = [];
            
            const buys = transactions.filter(t => t.type === 'BUY' && labels.includes(t.date));
            const sells = transactions.filter(t => t.type === 'SELL' && labels.includes(t.date));
            const divs = transactions.filter(t => t.type === 'DIVIDEND' && labels.includes(t.date));

            if (buys.length > 0) {
                tradeDatasets.push({
                    label: 'BUY',
                    data: buys.map(t => ({ x: t.date, y: t.price })),
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
                    data: sells.map(t => ({ x: t.date, y: t.price })),
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
                    data: divs.map(t => ({ x: t.date, y: t.price })),
                    borderColor: 'rgb(245,158,11)',
                    backgroundColor: 'rgb(245,158,11)',
                    pointStyle: 'rectRot',
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    showLine: false,
                    yAxisID: 'y'
                });
            }

            // Calculate Holding Periods (dotted line and shaded area)
            const firstDate = labels[0];
            let currentQty = transactions
                .filter(t => t.date < firstDate)
                .reduce((acc, t) => {
                    if (t.type === 'BUY') return acc + (parseFloat(t.quantity) || 0);
                    if (t.type === 'SELL') return acc - (parseFloat(t.quantity) || 0);
                    return acc;
                }, 0);

            const holdingPrices = labels.map((date, idx) => {
                let heldDuringDay = currentQty > 0.0001;
                const dayTx = transactions.filter(t => t.date === date);
                dayTx.forEach(t => {
                    if (t.type === 'BUY') currentQty += (parseFloat(t.quantity) || 0);
                    if (t.type === 'SELL') currentQty -= (parseFloat(t.quantity) || 0);
                });
                // We show holding indicator if any quantity was held at start or end of day
                // Use a small epsilon for floating point safety
                return (heldDuringDay || currentQty > 0.0001) ? prices[idx] : null;
            });

            const isDark = document.documentElement.classList.contains('dark');
            const tickColor = isDark ? '#94a3b8' : '#64748b';
            const gridColor = isDark ? 'rgba(148,163,184,0.1)' : 'rgba(148,163,184,0.15)';

            // Add holding dataset at the beginning so it's behind markers but can be highlighted
            tradeDatasets.unshift({
                label: 'Holding',
                data: holdingPrices,
                borderColor: 'rgba(59, 130, 246, 0.4)',
                backgroundColor: isDark ? 'rgba(59, 130, 246, 0.08)' : 'rgba(59, 130, 246, 0.05)',
                borderWidth: 1.5,
                borderDash: [4, 4],
                fill: 'origin',
                pointRadius: 0,
                tension: 0.1,
                yAxisID: 'y'
            });

            _assetChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: _chartTicker,
                            data: prices,
                            borderColor: lineColor,
                            backgroundColor: fillColor,
                            borderWidth: 2,
                            pointRadius: displayData.length > 100 ? 0 : 2,
                            pointHoverRadius: 4,
                            fill: true,
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
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                const datasetLabel = context.dataset.label || '';
                                if (datasetLabel === 'BUY' || datasetLabel === 'SELL' || datasetLabel === 'DIVIDEND') {
                                    const dt = context.label;
                                    const trades = tradesByDate[dt] || [];
                                    const trade = trades.find(tr => tr.type === datasetLabel);
                                    if (trade) {
                                        return ` ${trade.type}: ${_chartTicker} (${trade.quantity} @ ${trade.price.toFixed(2)})`;
                                    }
                                }
                                return null;
                            },
                            title: function(tooltipItems) {
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
                            ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 10 }, color: tickColor },
                            grid: { color: gridColor }
                        },
                        y: {
                            ticks: {
                                callback: v => v.toFixed(2),
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

    // Ensure we expose necessary functions globally
    document.addEventListener('DOMContentLoaded', () => {
        ensureModalExists();
    });
})();
