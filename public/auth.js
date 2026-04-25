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
        const mobileUserName = document.getElementById('mobile-user-name');
        const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
        const mobileAdminLink = document.getElementById('mobile-admin-link');
        if (mobileUserName) mobileUserName.textContent = displayName;
        if (mobileLogoutBtn) mobileLogoutBtn.onclick = logout;
        if (mobileAdminLink) {
            mobileAdminLink.style.display = isAdmin ? '' : 'none';
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
