/**
 * Asset Chart Component for FolioTrack
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
        if (existing) existing.remove(); // Force re-injection for debug

        const modalHtml = `
        <div id="asset-chart-modal" 
             style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 9999; align-items: center; justify-content: center; background-color: rgba(0, 0, 0, 0.85); backdrop-filter: blur(8px); padding: 0.5rem; flex-direction: column;"
             class="flex">
            <div class="bg-white dark:bg-[#111722]" 
                 style="width: 100%; max-width: 900px; max-height: 92vh; position: relative; z-index: 10000; display: flex; flex-direction: column; border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); background-color: white; overflow: hidden;">
                
                <!-- Header -->
                <div style="padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border-top-left-radius: 16px; border-top-right-radius: 16px;">
                    <div>
                        <h3 class="font-black text-sm md:text-lg" id="chart-modal-title" style="margin: 0; color: #0f172a;">Asset History</h3>
                        <p class="text-[9px] text-slate-400 uppercase tracking-widest font-bold" id="chart-modal-subtitle" style="margin: 2px 0 0 0; font-size: 9px;"></p>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div id="chart-range-btns" style="display: flex; gap: 4px;">
                            <button onclick="loadAssetChart(null, '1m')" data-range="1m" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid #e2e8f0; background: white; cursor: pointer; font-size: 10px; font-weight: bold;">1M</button>
                            <button onclick="loadAssetChart(null, '1y')" data-range="1y" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid #e2e8f0; background: white; cursor: pointer; font-size: 10px; font-weight: bold;">1Y</button>
                            <button onclick="loadAssetChart(null, 'all')" data-range="all" class="chart-range-btn" style="padding: 4px 8px; border-radius: 6px; border: 1px solid #e2e8f0; background: white; cursor: pointer; font-size: 10px; font-weight: bold;">ALL</button>
                        </div>
                        <button onclick="closeAssetChartModal()" style="background: none; border: none; cursor: pointer; color: #94a3b8; padding: 4px;">
                            <span class="material-symbols-outlined" style="font-size: 20px;">close</span>
                        </button>
                    </div>
                </div>
                
                <!-- Chart Area -->
                <div style="padding: 12px; flex: 1; min-height: 200px; display: flex; flex-direction: column; background: white; overflow: hidden;">
                    <div id="chart-modal-loading" style="display: none; flex: 1; align-items: center; justify-content: center;">
                        <span class="material-symbols-outlined animate-spin" style="font-size: 32px; color: #135bec;">progress_activity</span>
                    </div>
                    <div id="chart-modal-empty" style="display: none; flex: 1; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8;">
                        <span class="material-symbols-outlined" style="font-size: 40px;">bar_chart_off</span>
                        <p style="font-weight: bold; margin-top: 8px; font-size: 12px;">No historical data.</p>
                    </div>
                    <div id="chart-modal-content" style="display: none; flex: 1; min-height: 180px; position: relative;">
                        <canvas id="asset-history-chart" style="width: 100% !important; height: 100% !important;"></canvas>
                    </div>
                </div>

                <!-- Price Alerts Section -->
                <div style="padding: 20px; border-top: 1px solid #eee; background: #fdfdfd;">
                    <div style="display: flex; flex-wrap: wrap; gap: 15px; align-items: flex-end;">
                        <div style="flex: 1; min-width: 250px; display: flex; gap: 15px;">
                            <div style="flex: 1;">
                                <label style="display: block; font-size: 9px; font-weight: 900; color: #64748b; text-transform: uppercase; margin-bottom: 5px;">Target Price</label>
                                <div style="position: relative;">
                                    <span style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-weight: bold; color: #94a3b8;" id="modal-tp-curr">€</span>
                                    <input type="number" id="modal-tp-input" step="any" style="width: 100%; padding: 10px 10px 10px 25px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 14px; font-weight: bold;" placeholder="0.00">
                                </div>
                            </div>
                            <div style="flex: 1;">
                                <label style="display: block; font-size: 9px; font-weight: 900; color: #64748b; text-transform: uppercase; margin-bottom: 5px;">Stop Loss</label>
                                <div style="position: relative;">
                                    <span style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-weight: bold; color: #94a3b8;" id="modal-sl-curr">€</span>
                                    <input type="number" id="modal-sl-input" step="any" style="width: 100%; padding: 10px 10px 10px 25px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 14px; font-weight: bold;" placeholder="0.00">
                                </div>
                            </div>
                        </div>
                        <button id="modal-save-alerts-btn" onclick="saveModalAlerts()" style="background: #135bec; color: white; padding: 12px 25px; border-radius: 10px; border: none; font-weight: 900; cursor: pointer; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;">
                            Save Alerts
                        </button>
                    </div>
                </div>

                <!-- Footer Info -->
                <div style="padding: 15px 20px; border-top: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #64748b; font-weight: bold;">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <span id="chart-modal-points">—</span>
                        <div style="display: flex; gap: 10px;">
                            <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #10b981;"></span> BUY</span>
                            <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444;"></span> SELL</span>
                        </div>
                    </div>
                    <span id="chart-modal-range-label" style="font-weight: 900; color: #0f172a;"></span>
                </div>
            </div>
        </div>`;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);

        // close on backdrop click
        document.getElementById('asset-chart-modal').addEventListener('click', function(e) {
            if (e.target === this) closeAssetChartModal();
        });
    }

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
        const sl = parseFloat(document.getElementById('modal-sl-input').value || 0);
        
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'SAVING...';

        try {
            const res = await fetch(`/api/assets/${encodeURIComponent(_chartTicker)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetPrice: tp, stopLoss: sl, isMonitored: 1 })
            });
            if (res.ok) {
                btn.textContent = 'SAVED!';
                const oldClass = 'bg-primary';
                const newClass = 'bg-emerald-500';
                btn.classList.remove(oldClass);
                btn.classList.add(newClass);
                
                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = originalText;
                    btn.classList.remove(newClass);
                    btn.classList.add(oldClass);
                }, 2000);
                
                if (typeof loadAssets === 'function') loadAssets();
                if (typeof mobLoadAssets === 'function') mobLoadAssets();
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
            b.classList.toggle('bg-primary', isMatch);
            b.classList.toggle('text-white', isMatch);
            if (!isMatch) b.classList.add('bg-slate-100', 'dark:bg-slate-800');
            else b.classList.remove('bg-slate-100', 'dark:bg-slate-800');
        });

        // Show loading
        document.getElementById('chart-modal-loading').style.display = 'flex';
        document.getElementById('chart-modal-empty').style.display = 'none';
        document.getElementById('chart-modal-content').style.display = 'none';
        document.getElementById('chart-modal-points').textContent = '—';

        try {
            // 1. Fetch asset info, historical quotes AND transactions in parallel
            const [quotesRes, txRes, assetRes] = await Promise.all([
                fetch(`/api/asset-quotes/${encodeURIComponent(_chartTicker)}`),
                fetch(`/api/transactions?assetTicker=${encodeURIComponent(_chartTicker)}`),
                fetch(`/api/assets`)
            ]);

            _allChartData = await quotesRes.json();
            const transactions = await txRes.json();
            const allAssets = await assetRes.json();
            const assetInfo = allAssets.find(a => a.ticker === _chartTicker);
            
            if (assetInfo) {
                _chartCurrency = assetInfo.currency || 'EUR';
                document.getElementById('chart-modal-subtitle').textContent = 
                    `${assetInfo.name} • ${assetInfo.exchange || 'Market'} (${_chartCurrency})`;

                // Pre-fill TP/SL inputs
                document.getElementById('modal-tp-input').value = assetInfo.targetPrice || '';
                document.getElementById('modal-sl-input').value = assetInfo.stopLoss || '';
                const currSym = _chartCurrency === 'EUR' ? '€' : (_chartCurrency === 'USD' ? '$' : _chartCurrency);
                document.getElementById('modal-tp-curr').textContent = currSym;
                document.getElementById('modal-sl-curr').textContent = currSym;
            }

            if (!_allChartData.length) {
                document.getElementById('chart-modal-loading').style.display = 'none';
                document.getElementById('chart-modal-empty').style.display = 'flex';
                return;
            }

            // 2. Filter by range
            const now = new Date();
            const fromDate = new Date(now);
            if (range === '1m') fromDate.setMonth(fromDate.getMonth() - 1);
            else if (range === '6m') fromDate.setMonth(fromDate.getMonth() - 6);
            else if (range === '1y') fromDate.setFullYear(fromDate.getFullYear() - 1);
            else if (range === '3y') fromDate.setFullYear(fromDate.getFullYear() - 3);
            else if (range === '5y') fromDate.setFullYear(fromDate.getFullYear() - 5);
            else fromDate.setFullYear(fromDate.getFullYear() - 20); // 'all'

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
                            ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 10 }, color: '#94a3b8' },
                            grid: { color: 'rgba(148,163,184,0.1)' }
                        },
                        y: {
                            ticks: {
                                callback: v => v.toFixed(2),
                                color: '#94a3b8',
                                font: { size: 10 }
                            },
                            grid: { color: 'rgba(148,163,184,0.1)' },
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
