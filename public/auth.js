/**
 * auth.js — FolioTracker Authentication Helper
 * Include in every protected page to enforce login and populate user info.
 * Usage: <script src="/auth.js"></script>
 *        Then call: initAuthGuard() at DOMContentLoaded
 */

(function() {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────────────
    window.__ftUser = null;

    // ─── Core Auth Check ─────────────────────────────────────────────────────

    /**
     * Checks authentication status against the server.
     * If not logged in, redirects to /login immediately.
     * If logged in, populates user info in the page UI.
     * @returns {Promise<Object|null>} The user object or null (redirect happens before null).
     */
    async function checkAuth() {
        try {
            const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
            if (res.status === 401 || res.status === 403) {
                window.location.href = '/login';
                return null;
            }
            if (!res.ok) {
                window.location.href = '/login';
                return null;
            }
            const data = await res.json();
            window.__ftUser = data.user;
            _populateUserUI(data.user);
            
            try {
                const pRes = await fetch('/api/auth/permissions');
                if (pRes.ok) {
                    const pData = await pRes.json();
                    window.__ftPermissions = pData.permissions || {};
                    _enforcePermissions(window.__ftPermissions, window.__ftUser);
                }
            } catch(e) {}
            
            return data.user;
        } catch (e) {
            // Network error — redirect to login
            window.location.href = '/login';
            return null;
        }
    }

    /**
     * Logs the current user out and redirects to /login.
     */
    async function logout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (_) {}
        // Clear all cached API data to prevent leaks between users
        sessionStorage.clear();
        window.location.href = '/login';
    }

    // ─── UI Population ───────────────────────────────────────────────────────

    /**
     * Populates all user-info placeholders in the page.
     * Works for both desktop sidebar and mobile header.
     */
    function _populateUserUI(user) {
        if (!user) return;

        const displayName = user.display_name || user.username || 'User';
        const initials = displayName.slice(0, 2).toUpperCase();
        const isAdmin = user.role === 'admin';

        // ── Desktop sidebar user info ──────────────────────────────────────
        const sidebarInitialsEl = document.getElementById('sidebar-user-initials');
        const sidebarNameEl     = document.getElementById('sidebar-user-name');
        const sidebarRoleEl     = document.getElementById('sidebar-user-role');
        const sidebarLogoutBtn  = document.getElementById('sidebar-logout-btn');
        const sidebarAdminLink  = document.getElementById('sidebar-admin-link');

        if (sidebarInitialsEl) sidebarInitialsEl.textContent = initials;
        if (sidebarNameEl)     sidebarNameEl.textContent = displayName;
        if (sidebarRoleEl)     sidebarRoleEl.textContent = isAdmin ? 'Admin' : 'Utente';
        if (sidebarLogoutBtn)  sidebarLogoutBtn.onclick = logout;
        if (sidebarAdminLink) {
            sidebarAdminLink.style.display = isAdmin ? '' : 'none';
        }

        // ── Header user info (desktop) ─────────────────────────────────────
        const headerUserName = document.getElementById('header-user-name');
        const headerUserRole = document.getElementById('header-user-role');
        if (headerUserName) headerUserName.textContent = displayName;
        if (headerUserRole) headerUserRole.textContent = isAdmin ? 'Admin' : 'M2T';

        // ── Mobile header ─────────────────────────────────────────────────
        const mobileUserName = document.getElementById('mobile-user-name') || document.getElementById('mob-user-name');
        const mobileUserEmail = document.getElementById('mob-user-email');
        const mobileUserRole = document.getElementById('mob-user-role');
        const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
        if (mobileUserName) mobileUserName.textContent = displayName;
        if (mobileUserEmail) mobileUserEmail.textContent = user.email || '';
        if (mobileUserRole) mobileUserRole.textContent = isAdmin ? 'Admin' : (user.role || 'User');
        if (mobileLogoutBtn) mobileLogoutBtn.onclick = logout;

        // ── Admin Links Visibility ──────────────────────────────────────────
        const adminLinks = [
            document.getElementById('sidebar-admin-link'),
            document.getElementById('mobile-admin-link'),
            document.getElementById('mobile-admin-link-header')
        ];
        adminLinks.forEach(link => {
            if (link) link.style.display = isAdmin ? '' : 'none';
        });
        
        // Support for class-based toggling if used elsewhere
        document.querySelectorAll('.admin-only').forEach(el => {
            el.style.display = isAdmin ? '' : 'none';
        });
    }

    /**
     * Enforces permissions by hiding navigation links and blocking specific content areas.
     */
    function _enforcePermissions(perms, user) {
        if (!user || user.role === 'admin') return; // Admins bypass all UI restrictions natively

        const pageMap = {
            'dashboard': 'page_dashboard',
            'portfolio': 'page_portfolio',
            'market': 'page_market',
            'reports': 'page_reports',
            'history': 'page_history',
            'dividend': 'page_dividend',
            'watchlist': 'page_watchlist',
            'settings': 'page_settings',
            'notifications': 'page_notifications'
        };

        // 1. Hide links to disabled pages
        for (const [path, resName] of Object.entries(pageMap)) {
            if (perms[resName] === false) {
                document.querySelectorAll(`a[href^="/${path}"]`).forEach(el => {
                    // Try to hide the parent li or the element itself
                    const parentLi = el.closest('li');
                    if (parentLi) parentLi.style.display = 'none';
                    else el.style.display = 'none';
                });
            }
        }

        // 2. Check current page
        const currentPath = window.location.pathname.replace(/^\//, '').split('_')[0].split('/')[0];
        if (pageMap[currentPath] && perms[pageMap[currentPath]] === false) {
            window.location.href = '/dashboard';
        }

        // 3. Settings sub-sections (assuming target content divs with known IDs)
        const settingsMap = {
            'setting_account': ['account-settings-content', 'mob-account-settings-content'],
            'setting_appearance': ['appearance-settings-content', 'mob-appearance-settings-content'],
            'setting_portfolio': ['portfolio-settings-content', 'mob-portfolio-settings-content'],
            'setting_data_sources': ['datasource-settings-content', 'mob-datasource-settings-content'],
            'setting_telegram': ['telegram-settings-content', 'mob-telegram-settings-content'],
            'setting_volatility': ['volatility-settings-content', 'mob-volatility-settings-content'],
            'setting_backup': ['backup-settings-content', 'mob-backup-settings-content'],
            'setting_diagnostic': ['diagnostic-settings-content'],
            'setting_maintenance': ['maintenance-settings-content'],
            'setting_logs': ['logs-settings-content'],
            'setting_taxation': ['taxation-settings-content'],
            'setting_audit': ['audit-settings-content'],
            'setting_danger_zone': ['danger-zone-content']
        };

        for (const [resName, ids] of Object.entries(settingsMap)) {
            if (perms[resName] === false) {
                ids.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) {
                        const section = el.closest('section');
                        if (section) section.style.display = 'none';
                        else el.style.display = 'none';
                    }
                });
            }
        }
    }

    /**
     * Initializes the auth guard.
     * Checks authentication and populates UI. Should be called once per page.
     */
    async function initAuthGuard() {
        return await checkAuth();
    }

    // ─── Exports ─────────────────────────────────────────────────────────────
    window.ftAuth = {
        checkAuth,
        logout,
        initAuthGuard,
        getUser: () => window.__ftUser
    };

})();
