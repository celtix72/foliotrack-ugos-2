(function() {
    const defaultFont = "'JetBrains Mono', monospace";
    const defaultSize = "14";
    
    function applyTheme(font, size) {
        const fonts = {
            "'JetBrains Mono', monospace": "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap",
            "'Fira Code', monospace": "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&display=swap",
            "'Roboto Mono', monospace": "https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500;600;700&display=swap",
            "'Inter', sans-serif": "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
        };

        let link = document.getElementById('theme-font');
        if (!link) {
            link = document.createElement('link');
            link.id = 'theme-font';
            link.rel = 'stylesheet';
            document.head.appendChild(link);
        }
        
        if (fonts[font]) link.href = fonts[font];

        document.documentElement.style.setProperty('--app-font-family', font);
        document.documentElement.style.setProperty('font-size', size + 'px', 'important');
        
        let styleTag = document.getElementById('theme-style');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'theme-style';
            document.head.appendChild(styleTag);
        }
        
        styleTag.innerHTML = `
            html, body, body *:not(.material-symbols-outlined) { 
                font-family: ${font} !important; 
                transition: font-size 0.2s ease;
            }
        `;
    }

    const localFont = localStorage.getItem('app-font') || defaultFont;
    const localSize = localStorage.getItem('app-font-size') || defaultSize;
    applyTheme(localFont, localSize);

    fetch(`/api/settings?t=${Date.now()}`)
        .then(res => res.json())
        .then(settings => {
            const fontChanged = settings.fontFamily !== localFont;
            const sizeChanged = settings.fontSize !== localSize;
            
            if (fontChanged || sizeChanged) {
                localStorage.setItem('app-font', settings.fontFamily);
                localStorage.setItem('app-font-size', settings.fontSize);
                applyTheme(settings.fontFamily, settings.fontSize);
            }
            
            window.dispatchEvent(new CustomEvent('settings-updated', { detail: settings }));
        })
        .catch(err => console.error("Error loading settings:", err));

    let _sidebarLoading = false;

    async function updateSidebarContents() {
        const container = document.getElementById('sidebar-portfolios');
        if (!container) return;

        if (_sidebarLoading) return;
        _sidebarLoading = true;

        try {
            // 1. Fetch Exchange Rate
            let exchangeHeader = '';
            try {
                const exRes = await fetch(`/api/market/exchange-rate?t=${Date.now()}`);
                const exData = await exRes.json();
                if (exData && exData.rate) {
                    exchangeHeader = `
                        <div class="px-3 py-2 mb-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800/60 flex items-center justify-between">
                            <div class="flex items-center gap-2">
                                <span class="material-symbols-outlined text-xs text-primary">currency_exchange</span>
                                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">EUR / USD</span>
                            </div>
                            <span class="text-[11px] font-bold font-mono text-primary">${parseFloat(exData.rate).toFixed(4)}</span>
                        </div>
                        <div class="h-[1px] bg-slate-100 dark:bg-slate-800 mx-3 mb-2"></div>
                    `;
                }
            } catch (e) {}

            // 2. Fetch Portfolios
            const pRes = await fetch(`/api/portfolios?t=${Date.now()}`);
            const portfolios = await pRes.json();

            // 3. Fetch Watchlist
            const wRes = await fetch(`/api/watchlist?t=${Date.now()}`);
            const watchlist = await wRes.json();

            let portfoliosHtml = portfolios.map(p => {
                const color = p.currency === 'EUR' ? 'emerald' : 'blue';
                return `
                <a href="/portfolio?id=${p.id}" class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer group transition-colors">
                    <div class="flex items-center gap-3">
                        <div class="w-1.5 h-1.5 rounded-full bg-${color}-500"></div>
                        <span class="text-sm font-medium text-slate-700 dark:text-slate-300 truncate max-w-[140px]">${p.name}</span>
                    </div>
                    <span class="text-[10px] text-slate-500 group-hover:text-slate-400 font-bold uppercase transition-colors shrink-0">${p.currency}</span>
                </a>
                `;
            }).join('');

            let watchlistHtml = '';
            if (watchlist && watchlist.length > 0) {
                watchlistHtml = `
                    <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
                        <p class="px-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Watchlist</p>
                        <div class="space-y-1">
                            ${watchlist.map(a => {
                                const perf = a.changePercent || 0;
                                const perfColor = perf >= 0 ? 'text-emerald-500' : 'text-rose-500';
                                return `
                                <div class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 group relative transition-colors">
                                    <div class="flex flex-col overflow-hidden">
                                        <span class="text-xs font-bold leading-tight truncate max-w-[100px]">${a.ticker}</span>
                                        <span class="text-[9px] text-slate-500 truncate max-w-[100px]">${a.name}</span>
                                    </div>
                                    <div class="text-right flex flex-col items-end">
                                        <p class="text-[11px] font-bold">${a.currentPrice.toLocaleString('en-US', { style: 'currency', currency: a.currency || 'USD'})}</p>
                                        <p class="text-[10px] font-bold ${perfColor}">${perf >= 0 ? '+' : ''}${perf.toFixed(2)}%</p>
                                    </div>
                                    <button onclick="removeFromWatchlist('${a.ticker}')" class="absolute -right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 transition-all">
                                        <span class="material-symbols-outlined text-xs">close</span>
                                    </button>
                                </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }

            container.innerHTML = exchangeHeader + portfoliosHtml + watchlistHtml;

            // Setup Add Button
            const addBtn = container.parentElement.querySelector('.material-symbols-outlined.cursor-pointer');
            if (addBtn && !addBtn.dataset.listenerInstalled) {
                addBtn.addEventListener('click', addToWatchlist);
                addBtn.dataset.listenerInstalled = 'true';
            }

        } catch (err) {
            console.error("Sidebar update error:", err);
        } finally {
            _sidebarLoading = false;
        }
    }

    async function addToWatchlist() {
        const ticker = prompt("Enter ticker to follow (e.g. BTC-USD, AAPL, ^GSPC):");
        if (!ticker) return;

        try {
            const res = await fetch('/api/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker })
            });
            if (res.ok) {
                updateSidebarContents();
            } else {
                const err = await res.text();
                alert("Error: " + err);
            }
        } catch (e) {
            alert("Failed to add ticker");
        }
    }

    window.removeFromWatchlist = async function(ticker) {
        if (!confirm(`Remove ${ticker} from watchlist?`)) return;
        try {
            const res = await fetch(`/api/watchlist/${ticker}`, { method: 'DELETE' });
            if (res.ok) updateSidebarContents();
        } catch (e) { console.error(e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateSidebarContents);
    } else {
        updateSidebarContents();
    }

    window.addEventListener('portfolios-updated', () => {
        _sidebarLoading = false;
        updateSidebarContents();
    });

    window.updateAppSettings = function(newSettings) {
        if (newSettings.fontFamily || newSettings.fontSize) {
            const font = newSettings.fontFamily || localStorage.getItem('app-font') || defaultFont;
            const size = newSettings.fontSize || localStorage.getItem('app-font-size') || defaultSize;
            localStorage.setItem('app-font', font);
            localStorage.setItem('app-font-size', size);
            applyTheme(font, size);
        }
        
        fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        })
        .then(res => res.json())
        .then(updated => {
             window.dispatchEvent(new CustomEvent('settings-updated', { detail: updated }));
        })
        .catch(err => console.error("Error saving settings:", err));
    };

    window.refreshSidebarPortfolios = function() {
        _sidebarLoading = false;
        updateSidebarContents();
    };
})();
