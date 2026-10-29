/**
 * client_cache.js — Client-Side SWR (Stale-While-Revalidate) Cache Engine
 * Enables instant 0ms page rendering by decoupling frontend visualizations from backend network latency.
 */

(function () {
    'use strict';

    const PREFIX = 'ftc_';

    const ftCache = {
        /**
         * Get cached item by key
         * @param {string} key
         * @returns {any|null}
         */
        get(key) {
            try {
                const raw = localStorage.getItem(PREFIX + key);
                if (!raw) return null;
                const item = JSON.parse(raw);
                return (item && item.data !== undefined) ? item.data : null;
            } catch (e) {
                return null;
            }
        },

        /**
         * Get full cached envelope including timestamp
         * @param {string} key
         * @returns {{ data: any, ts: number }|null}
         */
        getEnvelope(key) {
            try {
                const raw = localStorage.getItem(PREFIX + key);
                if (!raw) return null;
                return JSON.parse(raw);
            } catch (e) {
                return null;
            }
        },

        /**
         * Set cached item with timestamp
         * @param {string} key
         * @param {any} data
         */
        set(key, data) {
            try {
                const payload = JSON.stringify({ data, ts: Date.now() });
                localStorage.setItem(PREFIX + key, payload);
            } catch (e) {
                // If quota exceeded, clean oldest ftc_ keys
                try {
                    const keys = [];
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && k.startsWith(PREFIX) && k !== PREFIX + key) keys.push(k);
                    }
                    keys.forEach(k => localStorage.removeItem(k));
                    localStorage.setItem(PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
                } catch (_) {}
            }
        },

        /**
         * Stale-While-Revalidate fetch helper
         * 1. Returns/invokes onData with cached data immediately (0ms delay)
         * 2. Asynchronously requests fresh data from the server in the background
         * 3. Invokes onUpdate / onData with fresh data when the server responds
         *
         * @param {string} key Unique cache key
         * @param {string} url Endpoint URL
         * @param {object} options
         * @param {function} [options.onData] Called with (data, isFromCache)
         * @param {function} [options.onUpdate] Called with (freshData) when server responds
         * @param {object} [options.fetchOptions] Options to pass to window.fetch
         * @returns {Promise<any>}
         */
        async fetchSWR(key, url, { onData, onUpdate, fetchOptions = {} } = {}) {
            const cached = this.get(key);
            let hasRenderedCache = false;

            if (cached !== null && typeof onData === 'function') {
                try {
                    onData(cached, true);
                    hasRenderedCache = true;
                } catch (err) {
                    console.warn(`[ftCache] Error rendering cached data for ${key}:`, err);
                }
            }

            try {
                const res = await fetch(url, fetchOptions);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const freshData = await res.json();
                
                this.set(key, freshData);

                if (hasRenderedCache && typeof onUpdate === 'function') {
                    onUpdate(freshData);
                } else if (typeof onData === 'function') {
                    onData(freshData, false);
                } else if (typeof onUpdate === 'function') {
                    onUpdate(freshData);
                }

                // If header update element exists, update it
                this.touchLastUpdate();

                return freshData;
            } catch (err) {
                console.warn(`[ftCache] Background fetch failed for [${url}]:`, err.message);
                return cached;
            }
        },

        /**
         * Updates the UI badge "Upd: HH:mm"
         */
        touchLastUpdate(date = new Date()) {
            const d = date instanceof Date ? date : new Date(date);
            const timeStr = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            
            const desktopEl = document.getElementById('header-last-update');
            if (desktopEl) {
                desktopEl.innerText = `Upd: ${timeStr}`;
            }

            const mobileEl = document.getElementById('mob-header-last-update');
            if (mobileEl) {
                mobileEl.innerText = timeStr;
            }
        },

        /**
         * Invalidate/remove keys matching prefix
         */
        clear(keyPrefix = '') {
            try {
                const toRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith(PREFIX + keyPrefix)) toRemove.push(k);
                }
                toRemove.forEach(k => localStorage.removeItem(k));
            } catch (_) {}
        }
    };

    // Auto-invalidate relevant cache keys on data modification events
    window.addEventListener('portfolios-updated', () => {
        ftCache.clear('dashboard_portfolios');
        ftCache.clear('portfolios_list');
        ftCache.clear('chart_');
        ftCache.clear('allocation_');
        ftCache.clear('daily_gains_');
        ftCache.clear('sparkline_');
    });

    window.addEventListener('transactions-updated', () => {
        ftCache.clear('portfolio_detail_');
        ftCache.clear('chart_perf_');
        ftCache.clear('dashboard_portfolios');
        ftCache.clear('daily_gains_');
        ftCache.clear('sparkline_');
    });

    window.ftCache = ftCache;
})();

