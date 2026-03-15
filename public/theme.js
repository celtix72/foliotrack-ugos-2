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
            if (settings.fontFamily !== localFont || settings.fontSize !== localSize) {
                localStorage.setItem('app-font', settings.fontFamily);
                localStorage.setItem('app-font-size', settings.fontSize);
                applyTheme(settings.fontFamily, settings.fontSize);
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

            let html = '';
            if (exData && exData.rate) {
                html += `<div class="px-3 py-2 mb-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800/60 flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-xs text-primary">currency_exchange</span>
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">EUR / USD</span>
                    </div>
                    <span class="text-[11px] font-bold font-mono text-primary">${parseFloat(exData.rate).toFixed(4)}</span>
                </div><div class="h-[1px] bg-slate-100 dark:bg-slate-800 mx-3 mb-2"></div>`;
            }
            html += portfolios.map(p => `
                <a href="/portfolio?id=${p.id}" class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group">
                    <div class="flex items-center gap-3">
                        <div class="w-1.5 h-1.5 rounded-full bg-${p.currency === 'EUR' ? 'emerald' : 'blue'}-500"></div>
                        <span class="text-sm font-medium text-slate-700 dark:text-slate-300 truncate max-w-[140px]">${p.name}</span>
                    </div>
                    <span class="text-[10px] text-slate-500 group-hover:text-slate-400 font-bold uppercase transition-colors shrink-0">${p.currency}</span>
                </a>`).join('');

            if (watchlist && watchlist.length > 0) {
                html += `<div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800"><p class="px-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Watchlist</p><div class="space-y-1">`
                + watchlist.map(a => `<div class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 group relative transition-colors">
                    <div class="flex flex-col overflow-hidden"><span class="text-xs font-bold leading-tight truncate max-w-[100px]">${a.ticker}</span><span class="text-[9px] text-slate-500 truncate max-w-[100px]">${a.name}</span></div>
                    <div class="text-right flex flex-col items-end"><p class="text-[11px] font-bold">${a.currentPrice.toLocaleString('en-US', { style: 'currency', currency: a.currency || 'USD'})}</p>
                    <p class="text-[10px] font-bold ${a.changePercent >= 0 ? 'text-emerald-500' : 'text-rose-500'}">${a.changePercent >= 0 ? '+' : ''}${a.changePercent.toFixed(2)}%</p></div>
                    <button onclick="removeFromWatchlist('${a.ticker}')" class="absolute -right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-500 transition-all"><span class="material-symbols-outlined text-xs">close</span></button>
                    </div>`).join('') + `</div></div>`;
            }
            container.innerHTML = html;
        } finally { _sidebarLoading = false; }
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
        const indicator = document.getElementById('market-status-indicator');
        if (!indicator) return;
        try {
            const res = await fetch('/api/market-status');
            const status = await res.json();
            
            let html = '';
            if (status.isWeekend) {
                html = '<span class="text-rose-500 font-black">Markets Closed (Weekend)</span>';
            } else {
                const mil = status.MIL ? '<span class="text-emerald-500">MIL: OPEN</span>' : '<span class="text-slate-500">MIL: CLOSED</span>';
                const ger = status.GER ? '<span class="text-emerald-500">GER: OPEN</span>' : '<span class="text-slate-500">GER: CLOSED</span>';
                const usa = status.USA ? '<span class="text-emerald-500">USA: OPEN</span>' : '<span class="text-slate-500">USA: CLOSED</span>';
                html = `${mil} • ${ger} • ${usa}`;
            }
            indicator.innerHTML = html;
        } catch (err) { console.error("Market status update error:", err); }
    }

    // ─── Global Formatting ────────────────────────────────────────────────────
    window.formatCurrency = function(val, currency = 'USD', decimals = 2) {
        if (val === null || val === undefined) return '—';
        const value = parseFloat(val);
        if (!currency || currency.length !== 3) {
            return formatNumber(val, decimals);
        }
        try {
            return new Intl.NumberFormat('de-DE', { 
                style: 'currency', 
                currency: currency,
                minimumFractionDigits: 0,
                maximumFractionDigits: decimals
            }).format(value).replace(',00', '');
        } catch (e) {
            return formatNumber(val, decimals) + ' ' + currency;
        }
    };

    window.formatNumber = function(val, decimals = 2) {
        if (val === null || val === undefined) return '—';
        const value = parseFloat(val);
        return new Intl.NumberFormat('de-DE', { 
            minimumFractionDigits: 0,
            maximumFractionDigits: decimals
        }).format(value).replace(',00', '');
    };
})();
