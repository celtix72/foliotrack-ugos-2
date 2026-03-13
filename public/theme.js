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

    // 1. Apply from local cache immediately (prevent flash)
    const localFont = localStorage.getItem('app-font') || defaultFont;
    const localSize = localStorage.getItem('app-font-size') || defaultSize;
    applyTheme(localFont, localSize);

    // 2. Sync with backend API
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

    // 3. Dynamic Sidebar Quick Access
    // FIX: uses a flag to avoid duplicate calls and always runs after DOM is ready
    let _sidebarLoading = false;

    function updateSidebarPortfolios() {
        // The sidebar element might not exist yet if called during <head> parse.
        // We schedule it to run after DOM is ready.
        const container = document.getElementById('sidebar-portfolios');
        if (!container) return; // Will be retried via DOMContentLoaded below

        if (_sidebarLoading) return;
        _sidebarLoading = true;

        fetch(`/api/portfolios?t=${Date.now()}`)
            .then(res => res.json())
            .then(portfolios => {
                _sidebarLoading = false;
                if (!portfolios || portfolios.length === 0) {
                    container.innerHTML = `<div class="px-3 py-2 text-xs text-slate-400 italic">No portfolios yet.</div>`;
                    return;
                }
                container.innerHTML = portfolios.map(p => {
                    const color = p.currency === 'EUR' ? 'emerald' : 'blue';
                    return `
                    <a href="/portfolio?id=${p.id}" class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer group transition-colors">
                        <div class="flex items-center gap-3">
                            <div class="w-2 h-2 rounded-full bg-${color}-500"></div>
                            <span class="text-sm font-medium text-slate-700 dark:text-slate-300 truncate max-w-[140px]">${p.name}</span>
                        </div>
                        <span class="text-[10px] text-slate-500 group-hover:text-slate-400 font-bold uppercase transition-colors shrink-0">${p.currency}</span>
                    </a>
                    `;
                }).join('');
            })
            .catch(err => {
                _sidebarLoading = false;
                console.error("Error loading sidebar portfolios:", err);
                const c = document.getElementById('sidebar-portfolios');
                if (c) c.innerHTML = `<div class="px-3 py-2 text-xs text-red-400 italic">Failed to load.</div>`;
            });
    }

    // Run after DOM is ready (handles both early and late script execution)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateSidebarPortfolios);
    } else {
        // DOM already ready
        updateSidebarPortfolios();
    }

    // Also re-run whenever portfolios change (create/edit/delete)
    window.addEventListener('portfolios-updated', () => {
        _sidebarLoading = false; // Reset lock so fresh fetch is allowed
        updateSidebarPortfolios();
    });

    // Global setter for the UI
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

    window.updateThemeSettings = function(font, size) {
        window.updateAppSettings({ fontFamily: font, fontSize: size });
    };

    // Expose sidebar refresh as a global so any page can call it
    window.refreshSidebarPortfolios = function() {
        _sidebarLoading = false;
        updateSidebarPortfolios();
    };
})();
