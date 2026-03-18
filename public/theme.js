(function() {
    const defaultFont = "'JetBrains Mono', monospace";
    const defaultSize = "14";
    const defaultTheme = "dark";
    
    function applyTheme(font, size, theme = "dark") {
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

        if (theme === 'light') {
            document.documentElement.classList.remove('dark');
        } else {
            document.documentElement.classList.add('dark');
        }
    }

    const localFont = localStorage.getItem('app-font') || defaultFont;
    const localSize = localStorage.getItem('app-font-size') || defaultSize;
    const localTheme = localStorage.getItem('app-theme') || defaultTheme;
    applyTheme(localFont, localSize, localTheme);

    fetch(`/api/settings?t=${Date.now()}`)
        .then(res => res.json())
        .then(settings => {
            if (settings.fontFamily !== localFont || settings.fontSize !== localSize || settings.theme !== localTheme) {
                localStorage.setItem('app-font', settings.fontFamily || defaultFont);
                localStorage.setItem('app-font-size', settings.fontSize || defaultSize);
                localStorage.setItem('app-theme', settings.theme || defaultTheme);
                applyTheme(settings.fontFamily || defaultFont, settings.fontSize || defaultSize, settings.theme || defaultTheme);
            }
            window.dispatchEvent(new CustomEvent('settings-updated', { detail: settings }));
        })
        .catch(err => console.error("Error loading settings:", err));

    // ─── Sidebar & Watchlist ──────────────────────────────────────────────────
    let _sidebarLoading = false;
    async function updateSidebarContents() {
        const container = document.getElementById('sidebar-portfolios');
        if (!container) return;
        if (_sidebarLoading) return;
        _sidebarLoading = true;
        try {
            const exRes = await fetch(`/api/market/exchange-rate?t=${Date.now()}`);
            const exData = await exRes.json();
            const pRes = await fetch(`/api/portfolios?t=${Date.now()}`);
            const pData = await pRes.json();
            const portfolios = pData.portfolios || [];
            const wRes = await fetch(`/api/watchlist?t=${Date.now()}`);
            const watchlist = await wRes.json();

            let html = '<div class="px-2 pt-2 pb-4 space-y-5">';

            // 1. Portfolio Icons Row (Dedicated Top Row)
            html += `
            <div class="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
                ${portfolios.map(p => {
                    const bgColor = p.color || (p.currency === 'EUR' ? '#10b981' : '#3b82f6');
                    return `
                    <a href="/portfolio?id=${p.id}" 
                       title="${p.name} (${p.currency})"
                       style="background-color: ${bgColor}"
                       class="w-8 h-8 rounded-lg flex items-center justify-center text-[12px] font-black text-white transition-all transform hover:scale-110 shadow-sm hover:shadow-lg shrink-0">
                        ${p.name.charAt(0).toUpperCase()}
                    </a>`;
                }).join('')}
                <button onclick="window.location.href='/portfolio'" 
                        title="Manage Portfolios"
                        class="w-8 h-8 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center text-slate-400 hover:border-primary hover:text-primary transition-all hover:bg-primary/5 shrink-0">
                    <span class="material-symbols-outlined text-sm">add</span>
                </button>
            </div>`;

            // 2. EUR/USD Row (Restored Standalone Style)
            if (exData && exData.rate) {
                html += `
                <div class="px-3 py-2 rounded-xl bg-slate-100/50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800/60 flex items-center justify-between shadow-sm">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-xs text-primary">currency_exchange</span>
                        <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">EUR / USD</span>
                    </div>
                    <span class="text-[11px] font-black font-mono text-primary">${parseFloat(exData.rate).toFixed(4)}</span>
                </div>`;
            }

            // 3. Watchlist Section
            if (watchlist && watchlist.length >= 0) {
                html += `
                <div class="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800/60">
                    <div class="flex items-center justify-between px-1">
                        <p class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400/80">Watchlist</p>
                        <button onclick="toggleWatchlistSearch()" class="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-primary transition-colors">
                            <span class="material-symbols-outlined text-sm">add</span>
                        </button>
                    </div>
                    
                    <!-- Search Container -->
                    <div id="watchlist-search-container" class="hidden space-y-2">
                        <div class="relative">
                            <input type="text" id="watchlist-search-input" 
                                   placeholder="Ticker or Name..." 
                                   class="w-full bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-[10px] focus:outline-none focus:ring-2 focus:ring-primary/20"
                                   onkeyup="searchAssetsWatchlist(this.value)">
                            <button onclick="toggleWatchlistSearch()" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-rose-500">
                                <span class="material-symbols-outlined text-xs">close</span>
                            </button>
                        </div>
                        <div id="watchlist-search-results" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden hidden shadow-2xl max-h-48 overflow-y-auto custom-scrollbar"></div>
                    </div>

                    <div class="space-y-1">`
                + (watchlist.length === 0 ? `<p class="px-1 text-[10px] text-slate-500 italic">No assets pinned.</p>` : watchlist.map(a => `
                    <div class="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800/60 group relative transition-all border border-transparent hover:border-slate-200 dark:hover:border-slate-800 shadow-sm hover:shadow-md">
                        <div class="flex flex-col overflow-hidden">
                            <span class="text-[11px] font-black leading-tight truncate max-w-[80px] text-slate-900 dark:text-white">${a.ticker}</span>
                            <span class="text-[9px] text-slate-500 truncate max-w-[80px] font-bold">${a.name}</span>
                        </div>
                        <div class="text-right flex flex-col items-end">
                            <p class="text-[11px] font-black font-mono leading-none mb-1">${formatCurrency(a.currentPrice, a.currency || 'USD', 2)}</p>
                            <p class="text-[10px] font-black font-mono ${a.changePercent >= 0 ? 'text-emerald-500' : 'text-rose-500'}">
                                ${a.changePercent >= 0 ? '+' : ''}${a.changePercent.toFixed(2)}%
                            </p>
                        </div>
                        <button onclick="removeFromWatchlist('${a.ticker}')" class="absolute -right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 transition-all">
                            <span class="material-symbols-outlined text-xs">close</span>
                        </button>
                    </div>`).join('')) + `</div></div>`;
            }
            html += '</div>';
            container.innerHTML = html;
        } finally { _sidebarLoading = false; }
    }

    window.toggleWatchlistSearch = function() {
        const container = document.getElementById('watchlist-search-container');
        if (!container) return;
        container.classList.toggle('hidden');
        if (!container.classList.contains('hidden')) {
            document.getElementById('watchlist-search-input')?.focus();
        }
    }

    let _searchDebounce = null;
    window.searchAssetsWatchlist = async function(q) {
        const resultsDiv = document.getElementById('watchlist-search-results');
        if (!resultsDiv) return;
        if (!q || q.length < 2) {
            resultsDiv.classList.add('hidden');
            return;
        }

        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(async () => {
            try {
                const res = await fetch(`/api/market/search?q=${encodeURIComponent(q)}`);
                const data = await res.json();
                if (data.length === 0) {
                    resultsDiv.innerHTML = '<p class="p-3 text-[10px] text-slate-500 italic">No matches found.</p>';
                } else {
                    resultsDiv.innerHTML = data.map(item => `
                        <div class="p-2 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer border-b border-slate-100 dark:border-slate-800 last:border-0" 
                             onclick="addToWatchlist('${item.ticker}')">
                            <p class="text-[11px] font-bold leading-none mb-1">${item.ticker}</p>
                            <p class="text-[9px] text-slate-500 truncate">${item.name}</p>
                        </div>
                    `).join('');
                }
                resultsDiv.classList.remove('hidden');
            } catch (err) { console.error("Search error:", err); }
        }, 300);
    }

    window.addToWatchlist = async function(ticker) {
        try {
            const res = await fetch('/api/watchlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker })
            });
            if (res.ok) {
                document.getElementById('watchlist-search-container')?.classList.add('hidden');
                document.getElementById('watchlist-search-input').value = '';
                updateSidebarContents();
            } else {
                const msg = await res.text();
                alert('Failed to add: ' + msg);
            }
        } catch (err) { alert('Error: ' + err.message); }
    }

    window.removeFromWatchlist = async function(ticker) {
        if (!confirm(`Remove ${ticker}?`)) return;
        const res = await fetch(`/api/watchlist/${ticker}`, { method: 'DELETE' });
        if (res.ok) updateSidebarContents();
    }

    // ─── Notifications System ──────────────────────────────────────────────────
    async function updateNotifications() {
        // Find the notification button (bell)
        const bellBtn = document.querySelector('.material-symbols-outlined[class*="notifications"]')?.parentElement;
        if (!bellBtn) return;
        const bellDot = bellBtn.parentElement.querySelector('span[class*="bg-primary"]');

        try {
            const res = await fetch('/api/notifications');
            const notifications = await res.json();
            const unreadCount = notifications.filter(n => !n.isRead).length;

            if (bellDot) {
                bellDot.classList.toggle('hidden', unreadCount === 0);
            }

            // Setup Dropdown if not exists
            let dropdown = document.getElementById('notification-dropdown');
            if (!dropdown) {
                dropdown = document.createElement('div');
                dropdown.id = 'notification-dropdown';
                dropdown.className = 'absolute right-0 mt-2 w-80 bg-white dark:bg-[#111722] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-[100] hidden overflow-hidden transform origin-top-right transition-all';
                bellBtn.parentElement.appendChild(dropdown);

                bellBtn.onclick = (e) => {
                    e.stopPropagation();
                    dropdown.classList.toggle('hidden');
                };
                document.addEventListener('click', () => dropdown.classList.add('hidden'));
                dropdown.onclick = (e) => e.stopPropagation();
            }

            const header = `<div class="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50">
                <span class="font-black text-sm uppercase tracking-widest">Notifications</span>
                ${unreadCount > 0 ? `<button onclick="markAllRead()" class="text-[10px] font-bold text-primary hover:underline">Mark all read</button>` : ''}
            </div>`;

            const list = `<div class="max-h-96 overflow-y-auto custom-scrollbar">` + 
                (notifications.length === 0 ? `<div class="p-8 text-center text-slate-400 italic text-sm">No notifications</div>` : 
                notifications.map(n => `
                <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors relative ${!n.isRead ? 'bg-primary/[0.03]' : ''}">
                    <div class="flex items-start gap-3">
                        <div class="w-8 h-8 rounded-lg ${n.type === 'TARGET' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} flex items-center justify-center shrink-0">
                            <span class="material-symbols-outlined text-sm font-bold">${n.type === 'TARGET' ? 'trending_up' : 'trending_down'}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="text-xs font-bold leading-none mb-1">${n.title}</p>
                            <p class="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-2">${n.message}</p>
                            <p class="text-[9px] text-slate-400 mt-2">${new Date(n.date).toLocaleString('it-IT', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' })}</p>
                        </div>
                        ${!n.isRead ? `<div class="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1"></div>` : ''}
                    </div>
                    ${!n.isRead ? `<button onclick="markRead(${n.id})" class="absolute inset-0 w-full h-full opacity-0"></button>` : ''}
                </div>`).join('')) + `</div>`;

            dropdown.innerHTML = header + list;

        } catch (err) { console.error("Notifications error:", err); }
    }

    window.markRead = async function(id) {
        await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
        updateNotifications();
    }
    window.markAllRead = async function() {
        await fetch('/api/notifications/read-all', { method: 'POST' });
        updateNotifications();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { 
            updateSidebarContents(); 
            updateNotifications(); 
            updateMarketStatusUI(); 
        });
    } else {
        updateSidebarContents();
        updateNotifications();
        updateMarketStatusUI();
    }

    setInterval(updateNotifications, 30000); // 30s notifications sync
    setInterval(updateMarketStatusUI, 60000); // 60s market status sync

    window.refreshSidebarPortfolios = () => { _sidebarLoading = false; updateSidebarContents(); };

    async function updateMarketStatusUI() {
        const liveIndicator = document.getElementById('header-live-indicator');
        const updateLabel   = document.getElementById('header-last-update');
        const marketStatus  = document.getElementById('header-market-status');
        const portfolioVar  = document.getElementById('header-portfolio-var');
        
        if (!liveIndicator && !updateLabel && !marketStatus && !portfolioVar) return;

        try {
            // 1. Market Status
            const statusRes = await fetch('/api/market-status');
            const status = await statusRes.json();
            
            if (liveIndicator) {
                const dot = liveIndicator.querySelector('.header-live-dot');
                const text = liveIndicator.querySelector('.header-live-text');
                if (status.anyOpen) {
                    dot?.classList.add('bg-emerald-500', 'animate-pulse');
                    dot?.classList.remove('bg-slate-400', 'bg-rose-500');
                    if (text) text.textContent = 'Live';
                } else {
                    dot?.classList.remove('bg-emerald-500', 'animate-pulse');
                    dot?.classList.add('bg-slate-400');
                    if (text) text.textContent = 'Closed';
                }
            }

            if (updateLabel) {
                const now = new Date();
                const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                updateLabel.textContent = `Upd: ${timeStr}`;
            }

            if (marketStatus) {
                const euOpen = status.EU;
                const usOpen = status.US;
                marketStatus.innerHTML = `
                    <div class="flex items-center gap-1.5 ${euOpen ? 'text-emerald-500' : 'text-slate-400'}">
                        <span class="w-2 h-2 rounded-full ${euOpen ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-500'}"></span>
                        <span class="font-black">EU</span>
                    </div>
                    <span class="text-slate-300 dark:text-slate-700 font-light mx-1">|</span>
                    <div class="flex items-center gap-1.5 ${usOpen ? 'text-emerald-500' : 'text-slate-400'}">
                        <span class="w-2 h-2 rounded-full ${usOpen ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-500'}"></span>
                        <span class="font-black">US</span>
                    </div>
                `;
            }

            // 2. Portfolio Variation
            if (portfolioVar) {
                const pRes = await fetch('/api/portfolios');
                const pData = await pRes.json();
                const change = pData.global.changeValue || 0;
                const isPos = change >= 0;
                portfolioVar.innerHTML = `
                    <span class="flex items-center gap-1.5 ${isPos ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} font-bold px-3 py-1 rounded-full border ${isPos ? 'border-emerald-500/20' : 'border-rose-500/20'}">
                        <span class="material-symbols-outlined text-[16px]">${isPos ? 'trending_up' : 'trending_down'}</span>
                        ${isPos ? '+' : ''}${formatCurrency(change, 'EUR', 0)}
                    </span>
                `;
            }

        } catch (err) { console.error("Header update error:", err); }
    }

    // ─── Global Formatting ────────────────────────────────────────────────────
    window.formatCurrency = function(val, currency = 'USD', decimals = 0) {
        if (val === null || val === undefined) return '—';
        const value = parseFloat(val);
        if (!currency || currency.length !== 3) {
            return formatNumber(val, decimals);
        }
        try {
            return new Intl.NumberFormat('de-DE', { 
                style: 'currency', 
                currency: currency,
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            }).format(value);
        } catch (e) {
            return formatNumber(val, decimals) + ' ' + currency;
        }
    };

    window.formatNumber = function(val, decimals = 0) {
        if (val === null || val === undefined) return '—';
        const value = parseFloat(val);
        return new Intl.NumberFormat('de-DE', { 
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        }).format(value);
    };

    // ─── Privacy Mode ────────────────────────────────────────────────────────
    window.privacyState = {
        enabled: false,
        overrides: new Set()
    };

    window.togglePrivacyOverlay = function(id) {
        if (window.privacyState.overrides.has(id)) {
            window.privacyState.overrides.delete(id);
        } else {
            window.privacyState.overrides.add(id);
        }
        // Trigger a re-render of the specific element if possible, or just refresh the page data
        // For simplicity, most pages will just call their load function again or we can trigger a custom event
        window.dispatchEvent(new CustomEvent('privacy-changed', { detail: { id } }));
    };

    window.formatPrivacy = function(val, currency = 'EUR', id = null, decimals = 0) {
        if (window.privacyState.enabled && (!id || !window.privacyState.overrides.has(id))) {
            return '****';
        }
        return formatCurrency(val, currency, decimals);
    };

    window.getPrivacyIcon = function(id) {
        const isHidden = window.privacyState.enabled && !window.privacyState.overrides.has(id);
        return `<span class="material-symbols-outlined text-[16px] cursor-pointer hover:text-primary transition-colors ml-2" 
                      onclick="event.stopPropagation(); togglePrivacyOverlay('${id}')">
                    ${isHidden ? 'visibility_off' : 'visibility'}
                </span>`;
    };

    window.updateAppSettings = async (payload) => {
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const settings = await res.json();
            localStorage.setItem('app-theme', settings.theme || 'dark');
            // Re-apply theme immediately
            const font = settings.fontFamily || localStorage.getItem('app-font');
            const size = settings.fontSize || localStorage.getItem('app-font-size');
            applyTheme(font, size, settings.theme);
            
            // Update Privacy Mode state
            window.privacyState.enabled = settings.privacyMode === 'true';
            
            window.dispatchEvent(new CustomEvent('settings-updated', { detail: settings }));
        } catch (e) { console.error("Error updating settings:", e); }
    };

    // ─── Borsa Italiana History Recovery ──────────────────────────────────────
    window.fetchBorsaItalianaHistory = async function(ticker, isin) {
        console.log(`[B_ITA] Fetching history: ${ticker} (${isin})`);
        try {
            // QuantHouse API (Borsa Italiana) - 5 Years
            const url = `https://grafici.borsaitaliana.it/api/instruments/${isin},XMIL,ISIN/history/period?period=5Y&adjustment=true&add-last-price=true`;
            
            const response = await fetch(url);
            if (!response.ok) throw new Error(`B_ITA API failed (${response.status})`);
            
            const data = await response.json();
            if (data && data.history && data.history.historyDt) {
                const history = data.history.historyDt;
                
                const importRes = await fetch('/api/assets/import-history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker, history })
                });
                
                if (importRes.ok) {
                    window.showNotification(`Successfully restored ${history.length} price points for ${ticker}`, 'success');
                    window.dispatchEvent(new CustomEvent('asset-history-updated', { detail: { ticker } }));
                    return true;
                }
            }
            return false;
        } catch (err) {
            console.error(`[B_ITA] Error:`, err);
            window.showNotification(`Failed to recover history for ${ticker}.`, 'error');
            return false;
        }
    };

    window.showNotification = function(message, type = 'info') {
        // Create a temporary toast if no container exists
        let toast = document.getElementById('global-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'global-toast';
            toast.className = 'fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] px-6 py-3 rounded-2xl shadow-2xl font-bold text-sm transition-all transform translate-y-20 opacity-0 border';
            document.body.appendChild(toast);
        }
        
        const colors = {
            success: 'bg-emerald-500 text-white border-emerald-400',
            error: 'bg-rose-500 text-white border-rose-400',
            info: 'bg-primary text-white border-primary-light',
            warn: 'bg-amber-500 text-white border-amber-400'
        };
        
        toast.className = `fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] px-6 py-3 rounded-2xl shadow-2xl font-bold text-sm transition-all transform translate-y-0 opacity-100 border ${colors[type] || colors.info}`;
        toast.textContent = message;
        
        setTimeout(() => {
            toast.classList.add('translate-y-20', 'opacity-0');
        }, 4000);
    };
})();
