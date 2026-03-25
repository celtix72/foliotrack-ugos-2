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
        if (document.getElementById('asset-chart-modal')) return;

        const modalHtml = `
        <div id="asset-chart-modal" class="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[150] flex items-center justify-center hidden p-4">
            <div class="bg-white dark:bg-[#111722] w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col" style="max-height:90vh">
                <div class="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50 shrink-0">
                    <div>
                        <h3 class="font-black text-lg" id="chart-modal-title">Asset History</h3>
                        <p class="text-[10px] text-slate-400 uppercase tracking-widest font-bold" id="chart-modal-subtitle"></p>
                    </div>
                    <div class="flex items-center gap-2">
                        <div class="flex gap-1 text-[10px] font-black" id="chart-range-btns">
                            <button onclick="loadAssetChart(null, '1m')" data-range="1m" class="chart-range-btn px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-primary hover:text-white transition-colors">1M</button>
                            <button onclick="loadAssetChart(null, '6m')" data-range="6m" class="chart-range-btn px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-primary hover:text-white transition-colors">6M</button>
                            <button onclick="loadAssetChart(null, '1y')" data-range="1y" class="chart-range-btn px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-primary hover:text-white transition-colors">1Y</button>
                            <button onclick="loadAssetChart(null, '3y')" data-range="3y" class="chart-range-btn px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-primary hover:text-white transition-colors">3Y</button>
                            <button onclick="loadAssetChart(null, '5y')" data-range="5y" class="chart-range-btn px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-primary hover:text-white transition-colors">5Y</button>
                            <button onclick="loadAssetChart(null, 'all')" data-range="all" class="chart-range-btn px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-primary hover:text-white transition-colors">All</button>
                        </div>
                        <button onclick="closeAssetChartModal()" class="text-slate-400 hover:text-rose-500 transition-colors ml-2">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                </div>
                <div class="p-4 flex-1 overflow-hidden flex flex-col" style="min-height:300px">
                    <div id="chart-modal-loading" class="flex-1 flex items-center justify-center hidden">
                        <span class="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
                    </div>
                    <div id="chart-modal-empty" class="flex-1 flex flex-col items-center justify-center hidden text-slate-400 gap-2">
                        <span class="material-symbols-outlined text-4xl">bar_chart_off</span>
                        <p class="text-sm font-bold">No historical data available for this asset.</p>
                        <p class="text-xs">Trigger a history rebuild from the Dashboard to populate data.</p>
                    </div>
                    <div id="chart-modal-content" class="flex-1 hidden">
                        <canvas id="asset-history-chart" class="w-full h-full"></canvas>
                    </div>
                </div>

                <!-- Price Alerts Section -->
                <div class="px-6 py-4 border-t border-slate-100 dark:border-slate-800/60 bg-slate-50/50 dark:bg-slate-900/30">
                    <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div class="flex-1 grid grid-cols-2 gap-4 w-full">
                            <div class="space-y-1">
                                <label class="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                                    <span class="material-symbols-outlined text-[12px] text-emerald-500">trending_up</span> Target Price
                                </label>
                                <div class="relative">
                                    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold" id="modal-tp-curr">€</span>
                                    <input type="number" id="modal-tp-input" step="any" class="w-full bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 rounded-xl py-2 pl-6 pr-3 text-sm font-black focus:ring-2 focus:ring-primary/20" placeholder="0.00">
                                </div>
                            </div>
                            <div class="space-y-1">
                                <label class="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                                    <span class="material-symbols-outlined text-[12px] text-rose-500">trending_down</span> Stop Loss
                                </label>
                                <div class="relative">
                                    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold" id="modal-sl-curr">€</span>
                                    <input type="number" id="modal-sl-input" step="any" class="w-full bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 rounded-xl py-2 pl-6 pr-3 text-sm font-black focus:ring-2 focus:ring-primary/20" placeholder="0.00">
                                </div>
                            </div>
                        </div>
                        <button id="modal-save-alerts-btn" onclick="saveModalAlerts()" class="w-full sm:w-auto px-8 py-2.5 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/95 transition-all self-end">
                            Save Alerts
                        </button>
                    </div>
                </div>

                <div class="px-6 py-3 border-t border-slate-100 dark:border-slate-800/60 flex items-center justify-between shrink-0 bg-white dark:bg-[#111722]">
                    <div class="flex items-center gap-4">
                        <p class="text-[10px] text-slate-400 font-bold" id="chart-modal-points">—</p>
                        <div class="flex items-center gap-3 text-[9px] font-bold">
                            <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> BUY</div>
                            <div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-rose-500"></span> SELL</div>
                        </div>
                    </div>
                    <p class="text-[11px] font-black" id="chart-modal-range-label"></p>
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
        if (modal) modal.classList.add('hidden');
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
        modal.classList.remove('hidden');

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
        document.getElementById('chart-modal-loading').classList.remove('hidden');
        document.getElementById('chart-modal-empty').classList.add('hidden');
        document.getElementById('chart-modal-content').classList.add('hidden');
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
                document.getElementById('chart-modal-loading').classList.add('hidden');
                document.getElementById('chart-modal-empty').classList.remove('hidden');
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

            document.getElementById('chart-modal-loading').classList.add('hidden');
            document.getElementById('chart-modal-content').classList.remove('hidden');
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
                            // SCALE strictly on the min/max of the period
                            min: minP * 0.99,
                            max: maxP * 1.01
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Chart load error:', err);
            document.getElementById('chart-modal-loading').classList.add('hidden');
            document.getElementById('chart-modal-empty').classList.remove('hidden');
        }
    };

    // Ensure we expose necessary functions globally
    document.addEventListener('DOMContentLoaded', () => {
        ensureModalExists();
    });
})();
