(function() {
    console.log("[Theme] Script loading...");
    const defaultFont = "'JetBrains Mono', monospace";
    const defaultSize = "14";
    const defaultMobFont = "'Inter', sans-serif";
    const defaultMobSize = "14";
    const defaultTheme = "dark";
    
    // --- SPA-Like Fetch Caching (Stale-While-Revalidate) ---
    const originalFetch = window.fetch;
    
    // Global cache version to prevent SWR race conditions
    // Incremented on any POST/PUT/DELETE
    if (!sessionStorage.getItem('ft_cache_v')) sessionStorage.setItem('ft_cache_v', '0');

    window.fetch = async function(url, options = {}) {
        const isStringUrl = typeof url === 'string';
        const targetUrl = isStringUrl ? url : (url.url || '');
        
        if (targetUrl.startsWith('/api/')) {
            const method = options.method ? options.method.toUpperCase() : 'GET';
            
            if (method === 'GET') {
                const cacheKey = 'ft_cache_' + targetUrl;
                const cachedItemStr = sessionStorage.getItem(cacheKey);
                const currentVersion = sessionStorage.getItem('ft_cache_v');
                
                if (cachedItemStr) {
                    try {
                        const cachedItem = JSON.parse(cachedItemStr);
                        // 5 minutes TTL for instant SPA-like reactivity
                        // AND check if cache version matches
                        if (Date.now() - cachedItem.timestamp < 300000 && cachedItem.v === currentVersion) {
                            
                            // Background fetch for strict Stale-While-Revalidate
                            originalFetch(url, options).then(async res => {
                                if (res.ok) {
                                    // RE-CHECK VERSION: If a write happened while we were fetching, DISCARD.
                                    if (sessionStorage.getItem('ft_cache_v') !== currentVersion) return;

                                    const cloned = res.clone();
                                    const data = await cloned.json();
                                    try {
                                        sessionStorage.setItem(cacheKey, JSON.stringify({
                                            timestamp: Date.now(),
                                            data: data,
                                            v: currentVersion
                                        }));
                                    } catch(quotaErr) {
                                        // Response too large for sessionStorage — skip caching silently
                                        sessionStorage.removeItem(cacheKey);
                                    }
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
                
                // Normal fetch if cache miss, expired, or version mismatch
                const res = await originalFetch(url, options);
                if (res.ok) {
                    const cloned = res.clone();
                    try {
                        const data = await cloned.json();
                        const entry = JSON.stringify({
                            timestamp: Date.now(),
                            data: data,
                            v: sessionStorage.getItem('ft_cache_v')
                        });
                        // Skip caching if payload exceeds ~1MB to avoid QuotaExceededError
                        if (entry.length < 1_000_000) {
                            try {
                                sessionStorage.setItem(cacheKey, entry);
                            } catch(quotaErr) {
                                sessionStorage.removeItem(cacheKey);
                            }
                        }
                    } catch(e) {}
                }
                return res;
            } else {
                // Non-GET requests to /api/ (POST, PUT, DELETE) -> clear cache AND increment version!
                const res = await originalFetch(url, options);
                if (res.ok) {
                    // Increment version to invalidate all in-flight SWR background fetches
                    const newV = parseInt(sessionStorage.getItem('ft_cache_v') || '0') + 1;
                    sessionStorage.setItem('ft_cache_v', newV.toString());

                    Object.keys(sessionStorage).forEach(key => {
                        if (key.startsWith('ft_cache_') && key !== 'ft_cache_v') {
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

            /* Market Status Connected Microtags */
            .market-status-group {
                display: inline-flex !important;
                align-items: center !important;
                gap: 0 !important;
                padding: 0 !important;
                border-radius: 6px !important;
                line-height: 1 !important;
                vertical-align: middle !important;
                overflow: hidden !important;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
                flex-shrink: 0 !important;
                border: 1px solid rgba(0, 0, 0, 0.08);
            }
            .dark .market-status-group {
                border-color: rgba(255, 255, 255, 0.1);
            }

            .market-microtag {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                font-size: 9.5px !important;
                font-weight: 900 !important;
                letter-spacing: 0.4px !important;
                padding: 2.5px 7px !important;
                text-transform: uppercase !important;
                transition: background-color 0.25s ease, color 0.25s ease !important;
                user-select: none !important;
                line-height: 1 !important;
                cursor: default;
            }

            /* Extremities only: Left tag (EU) rounded on left only, Right tag (US) rounded on right only */
            .market-microtag-eu {
                border-radius: 5px 0 0 5px !important;
                border-right: 1px solid rgba(0, 0, 0, 0.12) !important;
            }
            .dark .market-microtag-eu {
                border-right: 1px solid rgba(255, 255, 255, 0.14) !important;
            }

            .market-microtag-us {
                border-radius: 0 5px 5px 0 !important;
            }

            /* States: Open (Green), Pre/Post-Market (Orange), Closed (Gray) */
            .market-microtag.status-open {
                background-color: #10b981 !important; /* emerald-500 */
                color: #ffffff !important;
            }

            .market-microtag.status-prepost {
                background-color: #f59e0b !important; /* amber-500 / orange */
                color: #ffffff !important;
            }

            .market-microtag.status-closed {
                background-color: #e2e8f0 !important; /* slate-200 */
                color: #64748b !important; /* slate-500 */
            }
            .dark .market-microtag.status-closed {
                background-color: #334155 !important; /* slate-700 */
                color: #94a3b8 !important; /* slate-400 */
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
                background: var(--mob-surface, white); border: 1px solid var(--mob-border, #e2e8f0); border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; z-index: 100; transition: all 0.2s;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05); color: var(--mob-text-muted, #64748b);
            }
            .dark .sidebar-toggle-tab { background: var(--mob-surface, #111722); border-color: var(--mob-border, #334155); color: var(--mob-text-muted, #94a3b8); }
            .sidebar-toggle-tab:hover { transform: scale(1.1); color: var(--mob-primary, #135bec); border-color: var(--mob-primary, #135bec); }
            
            /* Mobile Var Day Header Style */
            .mob-header-var {
                display: flex; align-items: center; gap: 4px;
                font-size: 15px; font-weight: 900; letter-spacing: -0.5px;
                margin-right: 12px;
                background: rgba(0,0,0,0.22);
            }
            /* Variation Pill */
            .mob-header-var-pill {
              padding: 4px 8px;
              border-radius: 12px;
              font-size: 11px;
              font-weight: 900;
              letter-spacing: -0.2px;
              min-width: 50px;
              text-align: center;
              background: rgba(255,255,255,0.06);
              border: 1px solid rgba(255,255,255,0.10);
              white-space: nowrap;
            }
        `;
    }

    const localFont = localStorage.getItem('app-font') || defaultFont;
    const localSize = localStorage.getItem('app-font-size') || defaultSize;
    const localMobFont = localStorage.getItem('app-mob-font') || defaultMobFont;
    const localMobSize = localStorage.getItem('app-mob-size') || defaultMobSize;
    const localTheme = localStorage.getItem('app-theme') || defaultTheme;
    applyTheme(localFont, localSize, localTheme, localMobFont, localMobSize);

    window.privacyState = {
        enabled: localStorage.getItem('privacy-enabled') === 'true'
    };

    fetch(`/api/settings?t=${Date.now()}`)
        .then(async res => {
            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                return res.json();
            } else {
                const text = await res.text();
                throw new Error(`Expected JSON but got ${contentType}. Preview: ${text.substring(0, 50)}`);
            }
        })
        .then(settings => {
            if (settings && settings.error) {
                console.warn("Settings API returned error (likely unauthenticated):", settings.error);
                return; // Do not apply or overwrite local settings
            }
            const serverPrivacy = settings.privacyMode === 'true';
            if (window.privacyState.enabled !== serverPrivacy) {
                window.privacyState.enabled = serverPrivacy;
                localStorage.setItem('privacy-enabled', String(serverPrivacy));
                window.dispatchEvent(new CustomEvent('privacy-changed'));
            }
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
        let container = document.getElementById('sidebar-widgets');
        if (!container) {
            const pCont = document.getElementById('sidebar-portfolios');
            if (pCont) {
                container = document.createElement('div');
                container.id = 'sidebar-widgets';
                container.className = 'pt-2 mt-2 border-t border-slate-200/80 dark:border-slate-800/60';
                pCont.parentNode.insertBefore(container, pCont.nextSibling);
            }
        }
        if (!container) return;
        if (_sidebarLoading) return;
        _sidebarLoading = true;
        try {
            const exRes = await fetch(`/api/market/exchange-rate?t=${Date.now()}`);
            const exData = await exRes.json();
            const wRes = await fetch(`/api/watchlist?t=${Date.now()}`);
            const watchlist = await wRes.json();

            let html = '<div class="space-y-2">';

            // 2. EUR/USD Row
            if (exData && exData.rate) {
                html += `
                <div class="px-2.5 py-1.5 rounded-lg bg-slate-100/60 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between shadow-sm">
                    <div class="flex items-center gap-1.5">
                        <span class="material-symbols-outlined text-[13px] text-primary">currency_exchange</span>
                        <span class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">EUR / USD</span>
                    </div>
                    <span class="text-[10px] font-black font-mono text-primary">${parseFloat(exData.rate).toFixed(4)}</span>
                </div>`;
            }

            // 3. Market Indices Section
            html += `
            <div id="sidebar-indices" class="space-y-1 pt-2 border-t border-slate-100 dark:border-slate-800/40">
                <!-- Injected by header_indices.js -->
            </div>
            `;

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

    window.removeFromWatchlist = async function(ticker, hasPosition = false) {
        if (!confirm(`Rimuovere ${ticker} dalla watchlist?`)) return;
        
        try {
            const res = await fetch(`/api/watchlist/${ticker}`, { method: 'DELETE' });
            if (res.ok) {
                // Trigger global update
                updateSidebarContents();
                window.dispatchEvent(new CustomEvent('market-data-updated'));
            } else {
                const err = await res.json();
                alert('Errore: ' + (err.error || 'Impossibile rimuovere asset'));
            }
        } catch (err) {
            alert('Errore di connessione: ' + err.message);
        }
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
                    if (n.type.startsWith('TARGET') || n.type === 'TARGET_PROFIT') {
                        window.showNotification(`${n.title}: ${n.message}`, 'success');
                    } else if (n.type.startsWith('STOP') || n.type === 'STOP_LOSS') {
                        window.showNotification(`${n.title}: ${n.message}`, 'error');
                    } else if (n.type === 'VOLATILITY') {
                        window.showNotification(`${n.title}: ${n.message}`, 'warning');
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
                dropdown.className = 'absolute right-0 mt-2 w-80 bg-white dark:bg-surface-dark border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-[100] hidden overflow-hidden transform origin-top-right transition-all';
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
                <div class="absolute bottom-0 left-0 right-0 bg-white dark:bg-surface-dark rounded-t-[32px] max-h-[80vh] flex flex-col overflow-hidden shadow-2xl border-t border-slate-200 dark:border-slate-800 focus:outline-none">
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
            const dEl = document.getElementById('header-date');
            if (dEl) dEl.innerText = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
            updateSidebarContents(); 
            updateNotifications(); 
            updateMarketStatusUI();
            injectSidebarToggle();
        });
    } else {
        const dEl = document.getElementById('header-date');
        if (dEl) dEl.innerText = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
        updateSidebarContents();
        updateNotifications();
        updateMarketStatusUI();
        injectSidebarToggle();
    }

    setInterval(updateNotifications, 30000); // 30s notifications sync
    setInterval(updateMarketStatusUI, 60000); // 60s market status sync
    updateMarketStatusUI(); // Call immediately on load
    
    window.addEventListener('portfolios-updated', (e) => {
        console.log("[Theme] portfolios-updated event received, refreshing UI...");
        updateSidebarContents();
        if (e && e.detail && e.detail.global && window.updateHeaderPortfolioVar) {
            window.updateHeaderPortfolioVar(e.detail);
        }
    });

    window.refreshSidebarPortfolios = () => { _sidebarLoading = false; updateSidebarContents(); };

    window._lastMarketUpdate = 0;
    window._lastKnownMarketStatus = null;

    function applyMarketMicrotag(el, isOpen, isPrePost, marketName) {
        if (!el) return;
        el.classList.remove('status-open', 'status-prepost', 'status-closed');
        if (isOpen) {
            el.classList.add('status-open');
            el.setAttribute('title', `${marketName}: Aperto`);
        } else if (isPrePost) {
            el.classList.add('status-prepost');
            el.setAttribute('title', `${marketName}: Pre/Post-Market`);
        } else {
            el.classList.add('status-closed');
            el.setAttribute('title', `${marketName}: Chiuso`);
        }
    }

    window.updateMarketTagsUI = function(customStatus) {
        const s = customStatus || window._lastKnownMarketStatus;
        if (!s) return;
        window._lastKnownMarketStatus = s;
        const eO = !!s.EU;
        const eP = !eO && (!!s.EU_preMarketActive || !!s.EU_afterHoursActive);
        const uO = !!s.US;
        const uP = !uO && (!!s.US_preMarketActive || !!s.US_afterHoursActive);
        document.querySelectorAll('.market-microtag-eu, #market-tag-eu, #mob-tag-eu').forEach(el => applyMarketMicrotag(el, eO, eP, 'Borsa Italiana / XETRA'));
        document.querySelectorAll('.market-microtag-us, #market-tag-us, #mob-tag-us').forEach(el => applyMarketMicrotag(el, uO, uP, 'NYSE / NASDAQ'));
    };

    window.updateHeaderPortfolioVar = function(pData) {
        if (!pData || !pData.global) return;
        const changeReg = pData.global.changeValue || 0;
        const changePP = pData.global.changeValuePrePost || 0;
        const totalMove = changeReg + changePP;
        const isPos = totalMove >= 0;

        const formatSafe = (val, dec = 0) => {
            if (typeof window.formatCurrency === 'function') {
                return window.formatCurrency(val, 'EUR', dec);
            }
            const num = Math.round(val);
            return `${num.toLocaleString('de-DE')} €`;
        };

        const formatGainPart = (num, includeCurrency = true) => {
            const rounded = Math.round(Number(num) || 0);
            const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '');
            if (includeCurrency) {
                const valStr = formatSafe(Math.abs(rounded), 0);
                return `${sign}${valStr}`;
            } else {
                const valStr = (typeof window.formatNumber === 'function')
                    ? window.formatNumber(Math.abs(rounded), 0)
                    : Math.abs(rounded).toLocaleString('de-DE');
                return `${sign}${valStr}`;
            }
        };

        // Currency symbol only on total gain
        const strTot = formatGainPart(totalMove, true);
        const strReg = formatGainPart(changeReg, false);
        const strPP  = formatGainPart(changePP, false);

        const isRegPos = changeReg >= 0;
        const isPPPos = changePP >= 0;

        // Desktop
        const portfolioVar = document.getElementById('header-portfolio-var');
        if (portfolioVar) {
            const pillClass = isPos
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25'
                : 'bg-rose-500/10 text-rose-500 border-rose-500/25';

            // Totale GAIN: verde / rosso chiaro in BOLD
            const totColorClass = isPos
                ? 'text-emerald-400 dark:text-emerald-300 font-black'
                : 'text-rose-400 dark:text-rose-300 font-black';

            // Mercati aperti: verde / rosso chiaro
            const regColorClass = isRegPos
                ? 'text-emerald-500 dark:text-emerald-300 font-bold'
                : 'text-rose-500 dark:text-rose-300 font-bold';

            // Mercati chiusi (pre/post-market): verde / rosso scuro
            const ppColorClass = isPPPos
                ? 'text-emerald-700 dark:text-emerald-500 font-bold'
                : 'text-rose-700 dark:text-rose-500 font-bold';

            portfolioVar.innerHTML = `
                <span class="flex items-center gap-1 ${pillClass} font-bold px-2.5 py-1 rounded-full border shadow-sm select-none" title="Variazione Giornaliera - Totale: ${strTot} | Mercati Aperti: ${strReg} | Mercati Chiusi: ${strPP}">
                    <span class="material-symbols-outlined text-[15px] ${isPos ? 'text-emerald-400 dark:text-emerald-300' : 'text-rose-400 dark:text-rose-300'}">${isPos ? 'trending_up' : 'trending_down'}</span>
                    <span class="text-[12px] tracking-tight ${totColorClass}">${strTot}</span>
                    <span class="text-[11px] opacity-40 font-bold mx-0.5">:</span>
                    <span class="text-[11px] ${regColorClass}">${strReg}</span>
                    <span class="text-[11px] opacity-40 font-bold mx-0.5">/</span>
                    <span class="text-[11px] ${ppColorClass}">${strPP}</span>
                </span>
            `;
        }

        // Mobile
        const mobVar = document.getElementById('mob-header-var-day');
        if (mobVar) {
            const bg = isPos ? 'rgba(16,185,129,0.18)' : 'rgba(244,63,94,0.18)';
            const border = isPos ? 'rgba(16,185,129,0.40)' : 'rgba(244,63,94,0.40)';
            
            const isDark = document.documentElement.classList.contains('dark');
            // Totale GAIN: verde / rosso chiaro in BOLD
            const totCol = isPos ? (isDark ? '#4ade80' : '#10b981') : (isDark ? '#f87171' : '#ef4444');
            // Mercati aperti: verde / rosso chiaro
            const regCol = isRegPos ? (isDark ? '#34d399' : '#059669') : (isDark ? '#fb7185' : '#e11d48');
            // Mercati chiusi (pre/post-market): verde / rosso scuro
            const ppCol  = isPPPos  ? (isDark ? '#059669' : '#047857') : (isDark ? '#be123c' : '#b91c1c');

            mobVar.style.backgroundColor = bg;
            mobVar.style.color = totCol;
            mobVar.style.border = `1px solid ${border}`;
            mobVar.setAttribute('title', `Totale: ${strTot} | Mercati aperti: ${strReg} | Mercati chiusi: ${strPP}`);
            mobVar.innerHTML = `<span style="font-size:11px; letter-spacing:-0.2px; white-space:nowrap;"><span style="color:${totCol}; font-weight:900;">${strTot}</span><span style="opacity:0.4; margin:0 1px;">:</span><span style="color:${regCol}; font-weight:700;">${strReg}</span><span style="opacity:0.4; margin:0 1px;">/</span><span style="color:${ppCol}; font-weight:800;">${strPP}</span></span>`;
        }
    };

    async function updateMarketStatusUI() {
        const liveIndicator   = document.getElementById('header-live-indicator');
        const updateLabel     = document.getElementById('header-last-update');
        const marketStatus    = document.getElementById('header-market-status');
        const portfolioVar    = document.getElementById('header-portfolio-var');
        const headerTagEU     = document.getElementById('market-tag-eu');
        const headerTagUS     = document.getElementById('market-tag-us');

        const mobVar          = document.getElementById('mob-header-var-day');
        const mobTagEU        = document.getElementById('mob-tag-eu');
        const mobTagUS        = document.getElementById('mob-tag-us');
        const anyMicrotag     = document.querySelector('.market-microtag');
        const mobMarketPill   = document.querySelector('.mob-header-market-pill');

        const mobDotEU        = document.getElementById('mob-dot-eu');
        const mobDotUS        = document.getElementById('mob-dot-us');
        const mobMarketStatus = document.getElementById('mob-market-status');
        const headerDotEU     = document.getElementById('market-dot-eu');
        const headerDotUS     = document.getElementById('market-dot-us');

        const hasHeaderElements = liveIndicator || updateLabel || marketStatus || portfolioVar || headerTagEU || headerTagUS
                               || mobVar || mobTagEU || mobTagUS || anyMicrotag || mobMarketPill
                               || mobDotEU || mobDotUS || mobMarketStatus || headerDotEU || headerDotUS;

        if (!hasHeaderElements) return;

        // 1. Market Status Fetch & Update
        try {
            const statusRes = await fetch('/api/market-status');
            if (statusRes.ok) {
                const status = await statusRes.json();
                window._lastKnownMarketStatus = status;

                // Auto-refresh logic: check if server has newer data
                if (status.lastUpdate && status.lastUpdate > window._lastMarketUpdate) {
                    const isInitial = window._lastMarketUpdate === 0;
                    window._lastMarketUpdate = status.lastUpdate;
                    
                    if (!isInitial) {
                        console.log("[Theme] Market data update detected, dispatching refresh event...");
                        for (let i = 0; i < sessionStorage.length; i++) {
                            const key = sessionStorage.key(i);
                            if (key && (key.startsWith('ft_cache_/api/portfolios') || key.startsWith('ft_cache_/api/analytics'))) {
                                sessionStorage.removeItem(key);
                                i--;
                            }
                        }
                        window.dispatchEvent(new CustomEvent('market-data-updated', { detail: { lastUpdate: status.lastUpdate } }));
                    }
                }

                // Set global mobile market open flag for page-level components
                window._mobMarketOpen = status.anyOpen;

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

                window.updateMarketTagsUI(status);

                const euOpen = !!status.EU;
                const euPrePost = !euOpen && (!!status.EU_preMarketActive || !!status.EU_afterHoursActive);
                const usOpen = !!status.US;
                const usPrePost = !usOpen && (!!status.US_preMarketActive || !!status.US_afterHoursActive);

                // Legacy dot fallbacks
                if (headerDotEU && headerDotUS) {
                    headerDotEU.className = `w-1.5 h-1.5 rounded-full ${euOpen ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : (euPrePost ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]' : 'bg-slate-300 dark:bg-slate-700')}`;
                    headerDotUS.className = `w-1.5 h-1.5 rounded-full ${usOpen ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : (usPrePost ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]' : 'bg-slate-300 dark:bg-slate-700')}`;
                }

                if (mobDotEU && mobDotUS) {
                    mobDotEU.style.backgroundColor = euOpen ? 'var(--mob-emerald)' : (euPrePost ? '#f59e0b' : 'var(--mob-text-caption)');
                    mobDotUS.style.backgroundColor = usOpen ? 'var(--mob-emerald)' : (usPrePost ? '#f59e0b' : 'var(--mob-text-caption)');
                    if (euOpen) mobDotEU.classList.add('animate-pulse'); else mobDotEU.classList.remove('animate-pulse');
                    if (usOpen) mobDotUS.classList.add('animate-pulse'); else mobDotUS.classList.remove('animate-pulse');
                }
            }
        } catch (statusErr) {
            console.error("[Theme] Market status fetch error:", statusErr);
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

        // 2. Portfolio Variation Fetch & Update
        try {
            const pRes = await fetch('/api/portfolios');
            if (pRes.ok) {
                const pData = await pRes.json();
                window.updateHeaderPortfolioVar(pData);
                // Emit event so dashboard.html can refresh its hero section
                window.dispatchEvent(new CustomEvent('portfolios-updated', { detail: pData }));
            }
        } catch (pErr) {
            console.error("[Theme] Portfolio header update error:", pErr);
        }
    }

    // ─── Global Formatting ────────────────────────────────────────────────────
    window.formatAiFv = function(val, currency = 'EUR', promptType = '') {
        if (val === null || val === undefined) return '—';
        const num = parseFloat(val);
        if (isNaN(num)) return val;
        let decimals = 2;
        if (num > 30) decimals = 0;
        else if (num > 10) decimals = 1;
        
        let formatted = window.formatCurrency(num, currency, decimals);
        if (promptType === 'garp') formatted += ' (Gro)';
        else if (promptType === 'graham') formatted += ' (Val)';
        else if (promptType === 'disruptive') formatted += ' (Dis)';
        else if (promptType === 'tech') formatted += ' (Tec)';
        else if (promptType === 'fin') formatted += ' (Fin)';
        else if (promptType === 'capital') formatted += ' (Cap)';
        return formatted;
    };

    window.formatCurrency = function(val, currency = 'EUR', decimals = 2) {
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

    window.formatNumber = function(val, decimals = 2) {
        if (val === null || val === undefined) return '—';
        const value = parseFloat(val);
        return new Intl.NumberFormat('de-DE', { 
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        }).format(value);
    };

    // ─── Privacy Mode ────────────────────────────────────────────────────────
    // Initialized at top of scope from localStorage


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

    // --- Specialized Equity Metrics Formatters ---
    window.ftFormatPE = function(val) {
        if (val === null || val === undefined || isNaN(val) || val === 0) return '—';
        return parseFloat(val).toFixed(2);
    };

    window.ftFormatYield = function(val) {
        if (val === null || val === undefined || isNaN(val) || val === 0) return '—';
        return (parseFloat(val) * 100).toFixed(2) + '%';
    };

    window.ftFormatBeta = function(val) {
        if (val === null || val === undefined || isNaN(val) || val === 0) return '—';
        return parseFloat(val).toFixed(2);
    };

    window.ftFormatEPS = function(val, curr = 'EUR') {
        if (val === null || val === undefined || isNaN(val) || val === 0) return '—';
        return formatCurrency(val, curr, 2);
    };

    window.ftFormatDate = function(val) {
        if (!val || val === '—' || val === 'N/A') return '—';
        try {
            const d = new Date(val);
            if (isNaN(d.getTime())) return '—';
            return d.toLocaleDateString('it-IT');
        } catch(e) { return '—'; }
    };

    /**
     * Renders a tiny badge next to asset quotes indicating real-time (⚡RT) or delayed (⏱15m) status.
     * Hovering or tapping shows an instant floating tooltip with the source and timestamp of the last quote update.
     * @param {number|boolean} isRealtime - 1 / true for real-time, 0 / false for delayed
     * @param {string} [realtimeSource=''] - 'GF', 'YF', 'B_ITA', 'MANUAL'
     * @param {string|Date|number} [updatedAt=null] - last update timestamp/date string
     * @param {string} [extraClass=''] - optional extra CSS classes
     * @returns {string} HTML markup
     */
    window.renderQuoteBadge = function(isRealtime, realtimeSource = '', updatedAt = null, extraClass = '') {
        // If 3rd argument was passed as a CSS class instead of timestamp (backward compatibility)
        if (typeof updatedAt === 'string' && (updatedAt.includes(' ') || updatedAt.includes('cursor') || updatedAt.includes('ml-') || updatedAt.includes('mr-')) && !updatedAt.includes('-') && !updatedAt.includes(':')) {
            extraClass = updatedAt;
            updatedAt = null;
        }

        const src = (realtimeSource || '').toUpperCase();
        
        let timeStr = '';
        if (updatedAt) {
            try {
                let d;
                if (typeof updatedAt === 'number') {
                    d = new Date(updatedAt);
                } else if (typeof updatedAt === 'string') {
                    const clean = updatedAt.includes('T') ? updatedAt : updatedAt.replace(' ', 'T') + (updatedAt.endsWith('Z') ? '' : 'Z');
                    d = new Date(clean);
                    if (isNaN(d.getTime())) d = new Date(updatedAt);
                } else if (updatedAt instanceof Date) {
                    d = updatedAt;
                }
                if (d && !isNaN(d.getTime())) {
                    const pad = n => String(n).padStart(2, '0');
                    const hours = pad(d.getHours());
                    const minutes = pad(d.getMinutes());
                    const seconds = pad(d.getSeconds());
                    const now = new Date();
                    const isToday = d.toDateString() === now.toDateString();
                    if (isToday) {
                        timeStr = `alle ${hours}:${minutes}:${seconds}`;
                    } else {
                        const day = pad(d.getDate());
                        const month = pad(d.getMonth() + 1);
                        timeStr = `il ${day}/${month} alle ${hours}:${minutes}`;
                    }
                }
            } catch (e) {}
        }

        const isRT = Boolean(isRealtime === 1 || isRealtime === true || isRealtime === '1');
        
        let badgeContent = '';
        let badgeClasses = '';
        let tooltipData = {};

        if (src === 'MANUAL') {
            badgeClasses = 'bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20';
            badgeContent = 'MAN';
            tooltipData = {
                title: '✏️ Prezzo Manuale',
                source: 'Inserimento manuale utente',
                time: timeStr ? `Aggiornato ${timeStr}` : 'Nessuna data registrata',
                accentColor: '#94a3b8',
                dotColor: '#94a3b8',
                borderColor: 'rgba(100, 116, 139, 0.4)'
            };
        } else if (isRT) {
            const srcLabel = src === 'GF' ? 'Google Finance' : (src === 'B_ITA' ? 'Borsa Italiana' : 'Yahoo Finance');
            badgeClasses = 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
            badgeContent = '<span class="w-1 h-1 rounded-full bg-emerald-500 animate-pulse inline-block"></span>⚡RT';
            tooltipData = {
                title: '⚡ Tempo Reale',
                source: `${srcLabel} (real-time)`,
                time: timeStr ? `Aggiornato ${timeStr}` : 'Dati in linea',
                accentColor: '#34d399',
                dotColor: '#10b981',
                borderColor: 'rgba(16, 185, 129, 0.4)'
            };
        } else {
            const srcLabel = src.includes('GF') ? 'Google Finance' : 'Yahoo Finance';
            badgeClasses = 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
            badgeContent = '⏱15m';
            tooltipData = {
                title: '⏱ Differita (~15-20 min)',
                source: `${srcLabel} (delay)`,
                time: timeStr ? `Aggiornato ${timeStr}` : 'In attesa di scambio',
                accentColor: '#fbbf24',
                dotColor: '#f59e0b',
                borderColor: 'rgba(245, 158, 11, 0.4)'
            };
        }

        const encodedData = encodeURIComponent(JSON.stringify(tooltipData));
        const ariaText = `${tooltipData.title} - ${tooltipData.source} - ${tooltipData.time}`;

        return `<span class="ft-quote-badge inline-flex items-center gap-0.5 px-1 py-px rounded text-[8px] font-black font-mono tracking-tighter border leading-none select-none cursor-pointer transition-transform hover:scale-105 active:scale-95 ${badgeClasses} ${extraClass}" data-ft-quote="${encodedData}" aria-label="${ariaText}">${badgeContent}</span>`;
    };

    // ─── Instant Floating Tooltip for Quote Badges ────────────────────────────
    let _quoteTooltipEl = null;
    let _quoteTooltipTimeout = null;

    function getQuoteTooltipEl() {
        if (!_quoteTooltipEl) {
            _quoteTooltipEl = document.createElement('div');
            _quoteTooltipEl.id = 'ft-quote-tooltip';
            _quoteTooltipEl.style.cssText = 'position:fixed; z-index:999999; pointer-events:none; opacity:0; transform:scale(0.96); transition:opacity 0.12s ease-out, transform 0.12s ease-out; display:none;';
            document.body.appendChild(_quoteTooltipEl);
        }
        return _quoteTooltipEl;
    }

    function showQuoteTooltip(target) {
        clearTimeout(_quoteTooltipTimeout);
        const raw = target.getAttribute('data-ft-quote');
        if (!raw) return;
        let data;
        try {
            data = JSON.parse(decodeURIComponent(raw));
        } catch(e) {
            return;
        }

        const tooltip = getQuoteTooltipEl();
        tooltip.innerHTML = `
            <div style="background:rgba(15,23,42,0.96); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); color:#f8fafc; padding:7px 11px; border-radius:8px; box-shadow:0 12px 28px -4px rgba(0,0,0,0.65), 0 4px 10px -2px rgba(0,0,0,0.35); border:1px solid ${data.borderColor || 'rgba(51,65,85,0.6)'}; font-family:system-ui,-apple-system,sans-serif; font-size:11px; line-height:1.35; min-width:175px; max-width:270px;">
                <div style="font-weight:800; display:flex; align-items:center; gap:5px; color:${data.accentColor}; font-size:11px; margin-bottom:3px;">
                    <span>${data.title}</span>
                </div>
                <div style="color:#94a3b8; font-size:10px; font-weight:500;">
                    Fonte: <strong style="color:#f1f5f9; font-weight:600;">${data.source}</strong>
                </div>
                <div style="color:#cbd5e1; font-size:10px; margin-top:4px; padding-top:4px; border-top:1px solid rgba(51,65,85,0.5); display:flex; align-items:center; gap:5px;">
                    <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${data.dotColor}; flex-shrink:0;"></span>
                    <span style="color:#cbd5e1; font-weight:500;">${data.time}</span>
                </div>
            </div>
        `;

        tooltip.style.display = 'block';

        const rect = target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        if (left < 10) left = 10;
        if (left + tooltipRect.width > window.innerWidth - 10) {
            left = window.innerWidth - tooltipRect.width - 10;
        }

        let top = rect.top - tooltipRect.height - 6;
        if (top < 10) {
            // Flip below badge if not enough space at top
            top = rect.bottom + 6;
        }

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;

        requestAnimationFrame(() => {
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'scale(1)';
        });
    }

    function hideQuoteTooltip() {
        clearTimeout(_quoteTooltipTimeout);
        _quoteTooltipTimeout = setTimeout(() => {
            if (_quoteTooltipEl) {
                _quoteTooltipEl.style.opacity = '0';
                _quoteTooltipEl.style.transform = 'scale(0.96)';
                setTimeout(() => {
                    if (_quoteTooltipEl && _quoteTooltipEl.style.opacity === '0') {
                        _quoteTooltipEl.style.display = 'none';
                    }
                }, 130);
            }
        }, 40);
    }

    // Attach delegated events once DOM is loaded or inline
    document.addEventListener('mouseover', (e) => {
        const badge = e.target.closest('.ft-quote-badge');
        if (badge) showQuoteTooltip(badge);
    });

    document.addEventListener('mouseout', (e) => {
        const badge = e.target.closest('.ft-quote-badge');
        if (badge) hideQuoteTooltip();
    });

    document.addEventListener('touchstart', (e) => {
        const badge = e.target.closest('.ft-quote-badge');
        if (badge) {
            showQuoteTooltip(badge);
            clearTimeout(_quoteTooltipTimeout);
            _quoteTooltipTimeout = setTimeout(hideQuoteTooltip, 3500);
        } else {
            hideQuoteTooltip();
        }
    }, { passive: true });




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
            const serverPrivacy = settings.privacyMode === 'true';
            if (window.privacyState.enabled !== serverPrivacy) {
                window.privacyState.enabled = serverPrivacy;
                localStorage.setItem('privacy-enabled', String(serverPrivacy));
                window.dispatchEvent(new CustomEvent('privacy-changed'));
            }
            
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
        window.privacyState.enabled = newPrivacy;
        localStorage.setItem('privacy-enabled', String(newPrivacy));
        window.dispatchEvent(new CustomEvent('privacy-changed'));
        window.updateAppSettings({ privacyMode: String(newPrivacy) });
    };

    // ─── Borsa Italiana History Recovery ──────────────────────────────────────
    window.fetchBorsaItalianaHistory = async function(ticker, isin) {
        console.log(`[B_ITA] Fetching history: ${ticker} (${isin})`);
        try {
            // Priority 1: Use server-side endpoint with Bearer token authentication and resilient suffix fallback
            const srvRes = await fetch(`/api/assets/${encodeURIComponent(ticker)}/restore-bita-history`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isin })
            }).catch(() => null);

            if (srvRes && srvRes.ok) {
                const data = await srvRes.json();
                if (data.success) {
                    window.showNotification(`Storico Borsa Italiana ripristinato con successo per ${ticker} (${data.count} punti)`, 'success');
                    window.dispatchEvent(new CustomEvent('asset-history-updated', { detail: { ticker } }));
                    if (typeof loadAssetChart === 'function' && document.getElementById('asset-chart-modal')?.style.display !== 'none') {
                        loadAssetChart(ticker);
                    }
                    return true;
                }
            }

            // Priority 2: Direct browser fallback if backend endpoint was unreachable
            const url = `https://grafici.borsaitaliana.it/api/instruments/${isin},XMIL,ISIN/history/period?period=5Y&adjustment=true&add-last-price=true`;
            
            const response = await fetch(url);
            if (!response.ok) throw new Error(`B_ITA API failed (${response.status})`);
            
            const data = await response.json();
            if (data && data.history && data.history.historyDt) {
                const isBond = (ticker && ticker.toUpperCase().startsWith('BTP')) || (isin && isin.toUpperCase().startsWith('IT'));
                const history = data.history.historyDt.filter(h => {
                    const px = parseFloat(h.closePx || h.price || 0);
                    if (px <= 0.0001) return false;
                    if (isBond && (px < 20.0 || px > 200.0)) return false;
                    return true;
                });
                
                const importRes = await fetch('/api/assets/import-history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker, history })
                });
                
                if (importRes.ok) {
                    window.showNotification(`Successfully restored ${history.length} price points for ${ticker}`, 'success');
                    window.dispatchEvent(new CustomEvent('asset-history-updated', { detail: { ticker } }));
                    if (typeof loadAssetChart === 'function' && document.getElementById('asset-chart-modal')?.style.display !== 'none') {
                        loadAssetChart(ticker);
                    }
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
        if (!document.getElementById('mobile-ui')) {
            console.warn('[Theme] Mobile UI container (#mobile-ui) not found. Staying in desktop view.');
            window._mobileViewActive = false;
            document.body.classList.remove('mobile-view-active');
            return;
        }
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

    console.log('M2T Theme Engine Initialized.');

})();

window.ftConfirm = function(message) {
    return new Promise((resolve) => {
        let modal = document.getElementById('ft-global-confirm-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'ft-global-confirm-modal';
            modal.className = 'fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[99999] hidden flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white dark:bg-surface-dark w-full max-w-sm rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 transform transition-all scale-95 opacity-0 duration-200" id="ft-global-confirm-content">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                            <span class="material-symbols-outlined font-bold">warning</span>
                        </div>
                        <h3 class="text-lg font-black text-slate-800 dark:text-slate-100">Conferma Azione</h3>
                    </div>
                    <p id="ft-global-confirm-msg" class="text-sm text-slate-600 dark:text-slate-400 mb-6 whitespace-pre-wrap"></p>
                    <div class="flex items-center gap-3">
                        <button id="ft-global-confirm-cancel" class="flex-1 py-2.5 rounded-xl font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/50 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">Annulla</button>
                        <button id="ft-global-confirm-ok" class="flex-1 py-2.5 rounded-xl font-bold text-white bg-rose-500 hover:bg-rose-600 shadow-lg shadow-rose-500/20 transition-all">Conferma</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        document.getElementById('ft-global-confirm-msg').textContent = message;
        modal.classList.remove('hidden');
        
        // Animate in
        requestAnimationFrame(() => {
            const content = document.getElementById('ft-global-confirm-content');
            content.classList.remove('scale-95', 'opacity-0');
            content.classList.add('scale-100', 'opacity-100');
        });

        const btnOk = document.getElementById('ft-global-confirm-ok');
        const btnCancel = document.getElementById('ft-global-confirm-cancel');

        const cleanup = (result) => {
            const content = document.getElementById('ft-global-confirm-content');
            content.classList.remove('scale-100', 'opacity-100');
            content.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                modal.classList.add('hidden');
                btnOk.onclick = null;
                btnCancel.onclick = null;
                resolve(result);
            }, 200);
        };

        btnOk.onclick = () => cleanup(true);
        btnCancel.onclick = () => cleanup(false);
    });
};

// ─── Global Sidebar Management ────────────────────────────────────────────
window.renderSidebarPortfolios = function(portfolios) {
    const sidebar = document.getElementById('sidebar-portfolios');
    if (!sidebar) return;
    if (!portfolios || portfolios.length === 0) {
        sidebar.innerHTML = '<div class="px-2.5 py-1 text-[10px] text-slate-400 italic">Nessun portafoglio</div>';
        return;
    }
    window._cachedPortfolios = portfolios;
    const selectedPortfolioIds = JSON.parse(localStorage.getItem('selectedPortfolioIds') || '[]');
    const isPrivate = window.privacyState && window.privacyState.enabled;

    sidebar.innerHTML = portfolios.map(p => {
        const val = p.totalValueEUR !== undefined ? p.totalValueEUR : (p.totalValue !== undefined ? p.totalValue : 0);
        const displayVal = isPrivate ? '****' : formatCurrency(val, p.currency || 'EUR', 0);
        const isSelected = selectedPortfolioIds.includes(p.id);
        const bgColor = isSelected ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-100/70 dark:hover:bg-slate-800/50';
        
        return `
            <div class="flex items-center justify-between px-2 py-1 rounded-md text-slate-600 dark:text-slate-400 transition-all group cursor-pointer ${bgColor}" onclick="window.togglePortfolioFilter(${p.id})">
                <div class="flex items-center gap-2 overflow-hidden min-w-0">
                    <div class="flex items-center justify-center w-3 h-3 rounded-sm border shrink-0 ${isSelected ? 'border-transparent' : 'border-slate-300 dark:border-slate-600'}" style="${isSelected ? 'background-color:' + (p.color || '#6366f1') : ''}">
                        <span class="material-symbols-outlined text-[9px] text-white ${isSelected ? '' : 'hidden'}">check</span>
                    </div>
                    <div class="flex flex-col min-w-0">
                        <span class="text-[11px] font-medium truncate ${isSelected ? 'text-slate-900 dark:text-white font-bold' : ''}">${p.name}</span>
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <span class="text-[9px] font-bold opacity-0 group-hover:opacity-100 transition-opacity font-mono text-slate-400">${displayVal}</span>
                    <a href="/portfolio?id=${p.id}" onclick="event.stopPropagation()" class="text-slate-400 hover:text-primary transition-colors flex items-center" title="Dettagli Portafoglio">
                        <span class="material-symbols-outlined text-[13px]">open_in_new</span>
                    </a>
                </div>
            </div>
        `;
    }).join('');
};

window.togglePortfolioFilter = function(pId) {
    let selectedPortfolioIds = JSON.parse(localStorage.getItem('selectedPortfolioIds') || '[]');
    const idx = selectedPortfolioIds.indexOf(pId);
    if (idx > -1) {
        selectedPortfolioIds.splice(idx, 1);
    } else {
        selectedPortfolioIds.push(pId);
    }
    localStorage.setItem('selectedPortfolioIds', JSON.stringify(selectedPortfolioIds));
    
    if (window._cachedPortfolios) {
        window.renderSidebarPortfolios(window._cachedPortfolios);
    }
    
    if (typeof window.onPortfolioFilterChanged === 'function') {
        window.onPortfolioFilterChanged(selectedPortfolioIds);
    }
};

window.loadGlobalSidebarPortfolios = async function() {
    const sidebar = document.getElementById('sidebar-portfolios');
    if (!sidebar) return;
    try {
        const res = await fetch('/api/portfolios?t=' + Date.now());
        const data = await res.json();
        const portfolios = data.portfolios || [];
        window.renderSidebarPortfolios(portfolios);
    } catch (e) {
        console.error("Error loading sidebar portfolios:", e);
    }
};

window.addEventListener('privacy-changed', () => {
    if (window._cachedPortfolios) {
        window.renderSidebarPortfolios(window._cachedPortfolios);
    }
});

window.addEventListener('portfolios-updated', () => {
    window.loadGlobalSidebarPortfolios();
});

// ─── Active Menu Link Highlighting & Sidebar Init ─────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('#sidebar-nav-links .nav-link');
    
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href && (currentPath === href || (href !== '/' && currentPath.startsWith(href)))) {
            link.classList.remove('text-slate-600', 'dark:text-slate-400', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
            link.classList.add('bg-primary/10', 'text-primary', 'font-medium');
        }
    });

    window.loadGlobalSidebarPortfolios();
});
