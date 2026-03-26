(function() {
    console.log("[Theme] Script loading...");
    const defaultFont = "'JetBrains Mono', monospace";
    const defaultSize = "14";
    const defaultMobFont = "'Inter', sans-serif";
    const defaultMobSize = "14";
    const defaultTheme = "dark";
    
    // --- SPA-Like Fetch Caching (Stale-While-Revalidate) ---
    const originalFetch = window.fetch;
    window.fetch = async function(url, options = {}) {
        const isStringUrl = typeof url === 'string';
        const targetUrl = isStringUrl ? url : (url.url || '');
        
        if (targetUrl.startsWith('/api/')) {
            const method = options.method ? options.method.toUpperCase() : 'GET';
            
            if (method === 'GET') {
                const cacheKey = 'ft_cache_' + targetUrl;
                const cachedItemStr = sessionStorage.getItem(cacheKey);
                
                if (cachedItemStr) {
                    try {
                        const cachedItem = JSON.parse(cachedItemStr);
                        // 5 minutes TTL for instant SPA-like reactivity
                        if (Date.now() - cachedItem.timestamp < 300000) {
                            
                            // Background fetch for strict Stale-While-Revalidate
                            originalFetch(url, options).then(async res => {
                                if (res.ok) {
                                    const cloned = res.clone();
                                    const data = await cloned.json();
                                    sessionStorage.setItem(cacheKey, JSON.stringify({
                                        timestamp: Date.now(),
                                        data: data
                                    }));
                                }
                            }).catch(e => console.error('Background SWR fetch failed:', e));
                            
                            // Immediately resolve with cached data
                            return new Response(JSON.stringify(cachedItem.data), {
                                status: 200,
                                headers: { 'Content-Type': 'application/json' }
                            });
                        }
                    } catch(e) {}
                }
                
                // Normal fetch if cache miss or expired
                const res = await originalFetch(url, options);
                if (res.ok) {
                    const cloned = res.clone();
                    try {
                        const data = await cloned.json();
                        sessionStorage.setItem(cacheKey, JSON.stringify({
                            timestamp: Date.now(),
                            data: data
                        }));
                    } catch(e) {}
                }
                return res;
            } else {
                // Non-GET requests to /api/ (POST, PUT, DELETE) -> clear cache!
                const res = await originalFetch(url, options);
                if (res.ok) {
                    Object.keys(sessionStorage).forEach(key => {
                        if (key.startsWith('ft_cache_')) {
                            sessionStorage.removeItem(key);
                        }
                    });
                }
                return res;
            }
        }
        
        // Pass-through for anything else
        return originalFetch(url, options);
    };
    // -----------------------------------------------------
    window.showNotification = function(message, type = 'info') {
        console.log(`[Theme] Showing notification: ${message} (${type})`);
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
        }, 5000);
    };

    function applyTheme(font, size, theme = "dark", mobFont = defaultMobFont, mobSize = defaultMobSize) {
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
        
        let mobLink = document.getElementById('theme-font-mob');
        if (!mobLink) {
            mobLink = document.createElement('link');
            mobLink.id = 'theme-font-mob';
            mobLink.rel = 'stylesheet';
            document.head.appendChild(mobLink);
        }
        if (fonts[mobFont] && mobFont !== font) mobLink.href = fonts[mobFont];

        document.documentElement.style.setProperty('--app-font-family', font);
        document.documentElement.style.setProperty('font-size', size + 'px', 'important');
        
        let styleTag = document.getElementById('theme-style');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'theme-style';
            document.head.appendChild(styleTag);
        }
        
        // Scale factor for mobile absolute px classes
        const scale = mobSize / 14;
        document.documentElement.style.setProperty('--mob-scale', scale);
        
        styleTag.innerHTML = `
            html, body, body *:not(.material-symbols-outlined) { 
                font-family: ${font} !important; 
                transition: font-size 0.2s ease;
            }
            body.mobile-view-active #mobile-ui, 
            body.mobile-view-active #mobile-ui *:not(.material-symbols-outlined) {
                font-family: ${mobFont} !important;
            }
            body.mobile-view-active #mobile-ui {
                font-size: ${mobSize}px !important;
            }
            
            /* Scale absolute pixel classes in mobile view based on selected size, but EXCLUDE standard UI elements */
            body.mobile-view-active #mobile-ui .mob-scroll .text-\\[10px\\] { font-size: calc(10px * ${scale}) !important; }
            body.mobile-view-active #mobile-ui .mob-scroll .text-\\[11px\\] { font-size: calc(11px * ${scale}) !important; }
            body.mobile-view-active #mobile-ui .mob-scroll .text-\\[12px\\] { font-size: calc(12px * ${scale}) !important; }
            body.mobile-view-active #mobile-ui .mob-scroll .text-xs { font-size: calc(0.75rem * ${scale}) !important; }
            body.mobile-view-active #mobile-ui .mob-scroll .text-sm { font-size: calc(0.875rem * ${scale}) !important; }

            /* Ensure Material Icons in header and tab bar have fixed sizes and no scaling */
            #mobile-ui .mob-header .material-symbols-outlined,
            #mobile-ui .mob-tab-bar .material-symbols-outlined {
                font-family: 'Material Symbols Outlined' !important;
            }
        `;

        if (theme === 'light') {
            document.documentElement.classList.remove('dark');
        } else {
            document.documentElement.classList.add('dark');
        }

        // Update Header Icons if they exist
        const themeIcon = document.getElementById('header-theme-icon');
        if (themeIcon) {
            themeIcon.innerText = (theme === 'light') ? 'dark_mode' : 'light_mode';
        }

        // Update mobile icon as well
        const mobThemeIcon = document.getElementById('mob-theme-icon');
        if (mobThemeIcon) {
            mobThemeIcon.innerText = (theme === 'light') ? 'dark_mode' : 'light_mode';
        }

        // --- Sidebar Collapsed Style (Dynamic injection) ---
        let sideStyle = document.getElementById('sidebar-style');
        if (!sideStyle) {
            sideStyle = document.createElement('style');
            sideStyle.id = 'sidebar-style';
            document.head.appendChild(sideStyle);
        }
        sideStyle.innerHTML = `
            aside { transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); position: relative; }
            aside.collapsed { width: 80px !important; }
            aside.collapsed .px-6 h1, aside.collapsed .px-6 p, 
            aside.collapsed nav span:not(.material-symbols-outlined), 
            aside.collapsed #sidebar-portfolios,
            aside.collapsed .p-4 .flex-1,
            aside.collapsed .p-4 p,
            aside.collapsed .text-xs.text-slate-500 { display: none !important; }
            aside.collapsed .p-6, aside.collapsed .p-4 { padding: 1.25rem !important; justify-content: center; }
            aside.collapsed nav { padding-left: 0.75rem !important; padding-right: 0.75rem !important; }
            aside.collapsed a { justify-content: center; padding-left: 0 !important; padding-right: 0 !important; }
            aside.collapsed .material-symbols-outlined { margin: 0 !important; font-size: 24px !important; }
            aside.collapsed .w-10.h-10 { width: 40px; height: 40px; }
            
            .sidebar-toggle-tab {
                position: absolute; right: -12px; top: 100px; width: 24px; height: 24px;
                background: white; border: 1px solid #e2e8f0; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; z-index: 100; transition: all 0.2s;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05); color: #64748b;
            }
            .dark .sidebar-toggle-tab { background: #1e293b; border-color: #334155; color: #94a3b8; }
            .sidebar-toggle-tab:hover { transform: scale(1.1); color: #135bec; border-color: #135bec; }
            
            /* Mobile Var Day Header Style */
            .mob-header-var {
                display: flex; align-items: center; gap: 4px;
                font-size: 15px; font-weight: 900; letter-spacing: -0.5px;
                margin-right: 12px;
            }
        `;
    }

    const localFont = localStorage.getItem('app-font') || defaultFont;
    const localSize = localStorage.getItem('app-font-size') || defaultSize;
    const localMobFont = localStorage.getItem('app-mob-font') || defaultMobFont;
    const localMobSize = localStorage.getItem('app-mob-size') || defaultMobSize;
    const localTheme = localStorage.getItem('app-theme') || defaultTheme;
    applyTheme(localFont, localSize, localTheme, localMobFont, localMobSize);

    fetch(`/api/settings?t=${Date.now()}`)
        .then(res => res.json())
        .then(settings => {
            window.privacyState.enabled = settings.privacyMode === 'true';
            const privacyIcon = document.getElementById('header-privacy-icon');
            if (privacyIcon) {
                privacyIcon.innerText = window.privacyState.enabled ? 'visibility_off' : 'visibility';
            }
            if (settings.fontFamily !== localFont || settings.fontSize !== localSize || 
                settings.theme !== localTheme || settings.mobFont !== localMobFont || 
                settings.mobSize !== localMobSize) {
                
                localStorage.setItem('app-font', settings.fontFamily || defaultFont);
                localStorage.setItem('app-font-size', settings.fontSize || defaultSize);
                localStorage.setItem('app-theme', settings.theme || defaultTheme);
                localStorage.setItem('app-mob-font', settings.mobFont || defaultMobFont);
                localStorage.setItem('app-mob-size', settings.mobSize || defaultMobSize);
                
                applyTheme(
                    settings.fontFamily || defaultFont, 
                    settings.fontSize || defaultSize, 
                    settings.theme || defaultTheme,
                    settings.mobFont || defaultMobFont,
                    settings.mobSize || defaultMobSize
                );
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

    // ─── Sidebar Toggle ──────────────────────────────────────────────────────
    window.toggleSidebar = function() {
        const aside = document.querySelector('aside');
        if (!aside) return;
        const isCollapsed = aside.classList.toggle('collapsed');
        localStorage.setItem('sidebar-collapsed', isCollapsed);
        const tabIcon = document.querySelector('#sidebar-toggle-tab span');
        if (tabIcon) tabIcon.innerText = isCollapsed ? 'chevron_right' : 'chevron_left';
    };

    function injectSidebarToggle() {
        const aside = document.querySelector('aside');
        if (!aside || document.getElementById('sidebar-toggle-tab')) return;
        
        const tab = document.createElement('div');
        tab.id = 'sidebar-toggle-tab';
        tab.className = 'sidebar-toggle-tab';
        const isCollapsed = localStorage.getItem('sidebar-collapsed') === 'true';
        tab.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">${isCollapsed ? 'chevron_right' : 'chevron_left'}</span>`;
        tab.onclick = toggleSidebar;
        aside.appendChild(tab);
        
        if (isCollapsed) aside.classList.add('collapsed');
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

            // Check for new notifications to show toast
            const maxId = notifications.length ? Math.max(...notifications.map(n => n.id)) : 0;
            console.log(`[Theme] Notifications: count=${notifications.length}, unread=${unreadCount}, maxId=${maxId}, lastId=${window._lastNotifId}`);
            
            if (window._lastNotifId !== undefined && maxId > window._lastNotifId) {
                const newOnes = notifications.filter(n => n.id > window._lastNotifId);
                console.log(`[Theme] Found ${newOnes.length} new notifications`);
                newOnes.forEach(n => {
                    console.log(`[Theme] Processing new notify: ${n.id} type=${n.type}`);
                    if (n.type === 'TARGET' || n.type === 'STOP') {
                        window.showNotification(`${n.title}: ${n.message}`, n.type === 'TARGET' ? 'success' : 'error');
                    }
                });
            }
            window._lastNotifId = maxId;

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

            dropdown = document.getElementById('notification-dropdown');
            if (dropdown) {
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
            }

        } catch (err) { console.error("Notifications error:", err); }
    }

    // Mobile Notification Modal Logic (Available Globally)
    window.toggleMobileNotifications = (show = true) => {
        let modal = document.getElementById('mob-notification-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'mob-notification-modal';
            modal.className = 'fixed inset-0 z-[10000] hidden';
            modal.innerHTML = `
                <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onclick="toggleMobileNotifications(false)"></div>
                <div class="absolute bottom-0 left-0 right-0 bg-white dark:bg-[#111722] rounded-t-[32px] max-h-[80vh] flex flex-col overflow-hidden shadow-2xl border-t border-slate-200 dark:border-slate-800 focus:outline-none">
                    <div class="p-6 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                        <h3 class="text-xl font-black">Notifiche</h3>
                        <button onclick="toggleMobileNotifications(false)" class="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div id="mob-notification-list" class="flex-1 overflow-y-auto p-4 space-y-3"></div>
                    <div id="mob-notification-mark-all" class="p-4 bg-slate-50 dark:bg-slate-900/50 hidden">
                        <button onclick="markAllRead(); toggleMobileNotifications(false);" class="w-full py-4 bg-primary text-white font-black rounded-2xl">Segna tutte come lette</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }

        if (show) {
            // Initial/Empty list while fetch happens if needed, but usually we draw from global state
            modal.classList.remove('hidden');
        } else {
            modal.classList.add('hidden');
        }
    };

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
            injectSidebarToggle();
        });
    } else {
        updateSidebarContents();
        updateNotifications();
        updateMarketStatusUI();
        injectSidebarToggle();
    }

    setInterval(updateNotifications, 30000); // 30s notifications sync
    setInterval(updateMarketStatusUI, 60000); // 60s market status sync
    updateMarketStatusUI(); // Call immediately on load
    
    window.addEventListener('portfolios-updated', () => {
        console.log("[Theme] portfolios-updated event received, refreshing UI...");
        updateSidebarContents();
        updateMarketStatusUI();
    });

    window.refreshSidebarPortfolios = () => { _sidebarLoading = false; updateSidebarContents(); };

    window._lastMarketUpdate = 0;

    async function updateMarketStatusUI() {
        const liveIndicator = document.getElementById('header-live-indicator');
        const updateLabel   = document.getElementById('header-last-update');
        const marketStatus  = document.getElementById('header-market-status');
        const portfolioVar  = document.getElementById('header-portfolio-var');
        const mobDotEU = document.getElementById('mob-dot-eu');
        const mobDotUS = document.getElementById('mob-dot-us');
        const mobMarketStatus = document.getElementById('mob-market-status');
        
        if (!liveIndicator && !updateLabel && !marketStatus && !portfolioVar && !mobDotEU && !mobMarketStatus) return;

        try {
            // 1. Market Status
            const statusRes = await fetch('/api/market-status');
            if (!statusRes.ok) throw new Error("Connection Error");
            const data = await statusRes.json();

            // Auto-refresh logic: check if server has newer data
            if (data.lastUpdate && data.lastUpdate > window._lastMarketUpdate) {
                const isInitial = window._lastMarketUpdate === 0;
                window._lastMarketUpdate = data.lastUpdate;
                
                if (!isInitial) {
                    console.log("[Theme] Market data update detected, dispatching refresh event...");
                    // Clear SWR cache for portfolios and analytics to ensure fresh data
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const key = sessionStorage.key(i);
                        if (key && (key.startsWith('ft_cache_/api/portfolios') || key.startsWith('ft_cache_/api/analytics'))) {
                            sessionStorage.removeItem(key);
                            i--;
                        }
                    }
                    window.dispatchEvent(new CustomEvent('market-data-updated', { detail: { lastUpdate: data.lastUpdate } }));
                }
            }

            const status = data;
            
            if (liveIndicator) {
                const dot = liveIndicator.querySelector('.header-live-dot');
                const text = liveIndicator.querySelector('.header-live-text');
                if (status.anyOpen) {
                    dot?.classList.add('bg-emerald-500', 'animate-pulse');
                    dot?.classList.remove('bg-slate-400', 'bg-rose-500');
                    if (text) text.textContent = 'Live';
                } else {
                    dot?.classList.remove('bg-emerald-500', 'animate-pulse', 'bg-rose-500');
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

            // --- Mobile Market Dots & Pillars Injection ---
            if (mobDotEU && mobDotUS) {
                const euOpen = status.EU;
                const usOpen = status.US;
                mobDotEU.style.backgroundColor = euOpen ? 'var(--mob-emerald)' : 'var(--mob-text-caption)';
                mobDotUS.style.backgroundColor = usOpen ? 'var(--mob-emerald)' : 'var(--mob-text-caption)';
                if (euOpen) mobDotEU.classList.add('animate-pulse'); else mobDotEU.classList.remove('animate-pulse');
                if (usOpen) mobDotUS.classList.add('animate-pulse'); else mobDotUS.classList.remove('animate-pulse');
            }

            if (mobMarketStatus) {
                const euOpen = status.EU;
                const usOpen = status.US;
                mobMarketStatus.innerHTML = `
                    <span style="color:${euOpen ? 'var(--mob-emerald)' : 'var(--mob-text-muted)'}">EU</span> | 
                    <span style="color:${usOpen ? 'var(--mob-emerald)' : 'var(--mob-text-muted)'}">US</span>
                `;
            }

            // 2. Portfolio Variation
            const pRes = await fetch('/api/portfolios');
            const pData = await pRes.json();
            const change = pData.global.changeValue || 0;
            const isPos = change >= 0;
            const formatted = window.formatPrivacy(change, 'EUR', 'h-var', 0);
            const sign = (formatted !== '****' && isPos) ? '+' : '';

            if (portfolioVar) {
                portfolioVar.innerHTML = `
                    <span class="flex items-center gap-1.5 ${isPos ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'} font-bold px-3 py-1 rounded-full border ${isPos ? 'border-emerald-500/20' : 'border-rose-500/20'}">
                        <span class="material-symbols-outlined text-[16px]">${isPos ? 'trending_up' : 'trending_down'}</span>
                        ${sign}${formatted}
                    </span>
                 `;
            }

            // --- Mobile Var Pill Redesign ---
            let mobVar = document.getElementById('mob-header-var-day');
            if (mobVar) {
                const bg = isPos ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)';
                const color = isPos ? 'var(--mob-emerald)' : 'var(--mob-rose)';
                const border = isPos ? 'rgba(16,185,129,0.2)' : 'rgba(244,63,94,0.2)';
                mobVar.style.backgroundColor = bg;
                mobVar.style.color = color;
                mobVar.style.border = `1px solid ${border}`;
                mobVar.innerHTML = `<span>${sign}${formatted}</span>`;
            }

        } catch (err) { 
            console.error("Header update error:", err); 
            // Show Error State (Blinking Red)
            if (liveIndicator) {
                const dot = liveIndicator.querySelector('.header-live-dot');
                const text = liveIndicator.querySelector('.header-live-text');
                dot?.classList.remove('bg-emerald-500', 'bg-slate-400');
                dot?.classList.add('bg-rose-500', 'animate-pulse');
                if (text) text.textContent = 'Err';
            }
            if (marketStatus) {
                marketStatus.innerHTML = `
                    <div class="flex items-center gap-1.5 text-rose-500 animate-pulse">
                        <span class="w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"></span>
                        <span class="font-black">CONN ERR</span>
                    </div>
                `;
            }
            if (mobDotEU && mobDotUS) {
                mobDotEU.style.backgroundColor = 'var(--mob-rose)';
                mobDotUS.style.backgroundColor = 'var(--mob-rose)';
                mobDotEU.classList.add('animate-pulse');
                mobDotUS.classList.add('animate-pulse');
            }
            if (mobMarketStatus) {
                mobMarketStatus.innerHTML = `<span style="color:var(--mob-rose); font-weight:bold; white-space:nowrap;" class="animate-pulse">ERROR</span>`;
            }
        }
    }

    // ─── Global Formatting ────────────────────────────────────────────────────
    window.formatCurrency = function(val, currency = 'EUR', decimals = 0) {
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
        enabled: false
    };


    window.formatPrivacy = function(val, currency = 'EUR', id = null, decimals = 0) {
        // Privacy mode ONLY hides "total" fields
        const totalFields = [
            'networth', 'gross', 'gain', 'h-var', 'h-perf',       // Dashboard desktop
            'mob-net', 'mob-gross', 'mob-gain', 'mob-dayvar',      // Dashboard mobile
            'p-', 'mob-p-', 'mob-pg-', 'mob-pn-', 'mob-gnet',      // Portfolio lists & detail
            'tax-', 'mob-detail-total', 'mob-dt', 'mob-dg',        // Taxes & mobile details
            'p-detail-day-var'                                     // New hero variation pill
        ];

        const isTotal = id && totalFields.some(f => id === f || id.startsWith(f));

        if (window.privacyState.enabled && isTotal) {
            return '****';
        }
        return formatCurrency(val, currency, decimals);
    };


    window.updateAppSettings = async (payload) => {
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const settings = await res.json();
            
            // Store all settings in localStorage to prevent reset on navigation before fetch completes
            localStorage.setItem('app-font', settings.fontFamily || defaultFont);
            localStorage.setItem('app-font-size', settings.fontSize || defaultSize);
            localStorage.setItem('app-theme', settings.theme || 'dark');
            localStorage.setItem('app-mob-font', settings.mobFont || defaultMobFont);
            localStorage.setItem('app-mob-size', settings.mobSize || defaultMobSize);
            
            // Re-apply theme immediately with all arguments
            applyTheme(
                settings.fontFamily || defaultFont, 
                settings.fontSize || defaultSize, 
                settings.theme || 'dark',
                settings.mobFont || defaultMobFont,
                settings.mobSize || defaultMobSize
            );
            
            // Update Privacy Mode state
            window.privacyState.enabled = settings.privacyMode === 'true';
            
            const privacyIcon = document.getElementById('header-privacy-icon');
            if (privacyIcon) {
                privacyIcon.innerText = window.privacyState.enabled ? 'visibility_off' : 'visibility';
            }

            window.dispatchEvent(new CustomEvent('settings-updated', { detail: settings }));
        } catch (e) { console.error("Error updating settings:", e); }
    };

    window.toggleTheme = function() {
        const currentTheme = localStorage.getItem('app-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        window.updateAppSettings({ theme: newTheme });
    };

    window.togglePrivacy = function() {
        const newPrivacy = !window.privacyState.enabled;
        window.updateAppSettings({ privacyMode: String(newPrivacy) });
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

    // ─── Mobile View Management ───────────────────────────────────────────────
    window._mobileViewActive = false;

    window.isMobileDevice = function() {
        return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
            || window.innerWidth < 768;
    };

    window.activateMobileView = function() {
        window._mobileViewActive = true;
        document.body.classList.add('mobile-view-active');
        // Update all toggle buttons (use class for consistency)
        document.querySelectorAll('.layout-toggle-btn').forEach(btn => btn.classList.add('mob-active'));
        // Store preference
        localStorage.setItem('layout-preference', 'mobile');
        // Keep legacy for backward compatibility if needed, but clean it up eventually
        localStorage.removeItem('mobile-view-forced');
        
        // Reinit charts if they exist (chart canvases move between views)
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('mobile-view-activated'));
        }, 50);
    };

    window.deactivateMobileView = function() {
        window._mobileViewActive = false;
        document.body.classList.remove('mobile-view-active');
        // Update all toggle buttons
        document.querySelectorAll('.layout-toggle-btn').forEach(btn => btn.classList.remove('mob-active'));
        // Store preference
        localStorage.setItem('layout-preference', 'desktop');
        localStorage.removeItem('mobile-view-forced');
        
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('mobile-view-deactivated'));
        }, 50);
    };

    window.toggleMobileView = function() {
        if (window._mobileViewActive) {
            window.deactivateMobileView();
        } else {
            window.activateMobileView();
        }
    };

    // Auto-activate: manual preference takes absolute priority over auto-detection
    function _initMobileView() {
        const pref = localStorage.getItem('layout-preference');
        if (pref === 'mobile') {
            window.activateMobileView();
        } else if (pref === 'desktop') {
            window.deactivateMobileView();
        } else if (window.isMobileDevice()) {
            window.activateMobileView();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _initMobileView);
    } else {
        _initMobileView();
    }

    // Re-check on resize (only auto-activate if NO preference or preference is already mobile)
    let _resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            const pref = localStorage.getItem('layout-preference');
            if (!pref || pref === 'mobile') {
                const isNowMobile = window.isMobileDevice();
                if (isNowMobile && !window._mobileViewActive) {
                    window.activateMobileView();
                }
            }
        }, 200);
    });

    // ─── Universal Link Interceptor (PWA Fix for iOS) ────────────────────────
    document.addEventListener('click', (e) => {
        if (!window._mobileViewActive) return;
        const link = e.target.closest('a');
        if (link && link.getAttribute('href') && !link.getAttribute('target') && !link.getAttribute('download')) {
            const href = link.getAttribute('href');
            // Only intercept internal links
            if (href.startsWith('/') || href.startsWith(window.location.origin)) {
                e.preventDefault();
                window.location.href = href;
            }
        }
    }, true);

    // --- Mobile Tap Haptic Feedback ---
    document.addEventListener('touchstart', (e) => {
        const item = e.target.closest('.mob-tab-item, .mob-action-btn, .mob-card, .mob-icon-btn, .mob-fab, .mob-portfolio-card, .mob-holding-item');
        if (item && window.navigator && window.navigator.vibrate) {
            window.navigator.vibrate(8); // Short subtle "tick"
        }
    }, { passive: true });

    // --- Notification Badge Management ---
    window.updateNotificationBadge = async function() {
        try {
            const res = await fetch('/api/notifications');
            const notifications = await res.json();
            const unreadCount = notifications.filter(n => !n.isRead).length;
            
            // Desktop badge
            const desktopBadge = document.getElementById('header-notif-badge');
            if (desktopBadge) {
                desktopBadge.textContent = unreadCount;
                desktopBadge.style.display = unreadCount > 0 ? 'flex' : 'none';
            }
            
            // Mobile badge
            const mobBadge = document.getElementById('mob-notification-badge');
            if (mobBadge) {
                mobBadge.textContent = unreadCount;
                mobBadge.style.display = unreadCount > 0 ? 'flex' : 'none';
            }
        } catch (err) {
            console.error('Failed to update notification badge:', err);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', window.updateNotificationBadge);
    } else {
        window.updateNotificationBadge();
    }

    console.log('FolioTrack Theme Engine Initialized.');

})();

