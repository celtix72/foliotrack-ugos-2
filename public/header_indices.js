/**
 * header_indices.js — Shared Market Indices Header Bar
 * Manages up to 3 configurable market index chips in the page header.
 * Config stored in localStorage under 'ft_header_indices'.
 * Fetches data from /api/indices every 60s.
 */

(function () {
    'use strict';

    // ─── Default indices ────────────────────────────────────────────────────────
    const DEFAULT_INDICES = [
        { ticker: '^FTSEMIB', label: 'FTSE MIB' },
        { ticker: '^GSPC',    label: 'S&P 500'  },
        { ticker: 'CL=F',    label: 'Crude Oil' },
    ];

    const STORAGE_KEY   = 'ft_header_indices';
    const CONTAINER_ID  = 'sidebar-indices';
    const MODAL_ID      = 'indices-config-modal';
    const REFRESH_MS    = 60_000;

    // ─── Config helpers ─────────────────────────────────────────────────────────
    function getConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const cfg = JSON.parse(raw);
                if (Array.isArray(cfg) && cfg.length > 0) return cfg.slice(0, 3);
            }
        } catch (_) {}
        return DEFAULT_INDICES;
    }

    function saveConfig(cfg) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg.slice(0, 3)));
    }

    // ─── Format helpers ─────────────────────────────────────────────────────────
    function fmtPrice(price, currency) {
        if (price === null || price === undefined) return '—';
        const opts = { minimumFractionDigits: 0, maximumFractionDigits: 2 };
        const locale = 'it-IT';
        if (['EUR','USD','GBP'].includes(currency)) {
            return new Intl.NumberFormat(locale, { ...opts, style: 'currency', currency, notation: 'compact', compactDisplay: 'short' }).format(price);
        }
        return new Intl.NumberFormat(locale, opts).format(price);
    }

    function fmtPct(pct) {
        if (pct === null || pct === undefined) return '';
        const sign = pct >= 0 ? '+' : '';
        return `${sign}${Math.abs(pct) < 10 ? pct.toFixed(2) : pct.toFixed(1)}%`;
    }

    // ─── Render ─────────────────────────────────────────────────────────────────
    function render(dataMap) {
        const container = document.getElementById(CONTAINER_ID);
        if (!container) return;

        const config = getConfig();
        container.innerHTML = `
            <div class="flex items-center justify-between px-1 mb-2">
                <p class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400/80">Market Indices</p>
                <button id="idx-gear-btn" title="Configura indici" class="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-primary transition-colors flex items-center justify-center">
                    <span class="material-symbols-outlined text-[14px]">settings</span>
                </button>
            </div>
        ` + config.map(({ ticker, label }) => {
            const d = dataMap[ticker];
            if (!d) {
                return `<div class="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-all border border-transparent">
                    <div class="flex flex-col overflow-hidden">
                        <span class="text-[11px] font-black leading-tight truncate text-slate-500">${label}</span>
                    </div>
                    <div class="text-right flex flex-col items-end">
                        <p class="text-[11px] font-black font-mono text-slate-400">—</p>
                    </div>
                </div>`;
            }
            const pos   = d.changePercent >= 0;
            const color = pos ? 'text-emerald-500' : 'text-rose-500';
            return `
            <div class="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800/60 group relative transition-all border border-transparent hover:border-slate-200 dark:hover:border-slate-800 shadow-sm hover:shadow-md cursor-default" title="${d.name}">
                <div class="flex flex-col overflow-hidden">
                    <span class="text-[11px] font-black leading-tight truncate max-w-[80px] text-slate-900 dark:text-white">${label}</span>
                    <span class="text-[9px] text-slate-500 truncate max-w-[80px] font-bold">${d.ticker}</span>
                </div>
                <div class="text-right flex flex-col items-end">
                    <p class="text-[11px] font-black font-mono leading-none mb-1">${fmtPrice(d.price, d.currency)}</p>
                    <p class="text-[10px] font-black font-mono ${color}">
                        ${fmtPct(d.changePercent)}
                    </p>
                </div>
            </div>`;
        }).join('');

        // Re-attach listener since we re-rendered the button
        document.getElementById('idx-gear-btn')?.addEventListener('click', buildModal);
    }

    // ─── Fetch ──────────────────────────────────────────────────────────────────
    async function fetchIndices() {
        const config = getConfig();
        if (config.length === 0) return;
        const tickerStr = config.map(c => c.ticker).join(',');
        try {
            const res  = await fetch(`/api/indices?tickers=${encodeURIComponent(tickerStr)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const map  = {};
            data.forEach(d => { map[d.ticker] = d; });
            render(map);
        } catch (err) {
            console.warn('header_indices: fetch failed', err);
        }
    }

    // ─── Config modal ───────────────────────────────────────────────────────────
    function buildModal() {
        if (document.getElementById(MODAL_ID)) return;
        const cfg = getConfig();

        const rows = [0, 1, 2].map(i => {
            const item = cfg[i] || { ticker: '', label: '' };
            return `
            <div class="flex items-center gap-3">
                <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest w-4">${i + 1}</span>
                <input id="idx-label-${i}" type="text" placeholder="Label (es. S&P)" maxlength="12"
                       value="${item.label || ''}"
                       class="w-28 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg py-1.5 px-2.5 text-xs font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all">
                <input id="idx-ticker-${i}" type="text" placeholder="Ticker Yahoo (es. ^GSPC)" maxlength="20"
                       value="${item.ticker || ''}"
                       class="flex-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg py-1.5 px-2.5 text-xs font-mono font-bold focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all">
            </div>`;
        }).join('');

        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4';
        modal.innerHTML = `
        <div class="bg-white dark:bg-surface-dark border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div class="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                    <h3 class="font-black text-base">Indici di Mercato</h3>
                    <p class="text-[10px] text-slate-400 mt-0.5">Configura fino a 3 indici nel header</p>
                </div>
                <button id="idx-modal-close" class="text-slate-400 hover:text-rose-500 transition-colors">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="p-6 space-y-4">
                <div class="flex items-center gap-3 text-[9px] font-black text-slate-400 uppercase tracking-widest px-7">
                    <span class="w-28">Label breve</span>
                    <span class="flex-1">Ticker Yahoo Finance</span>
                </div>
                <div class="space-y-3">
                    ${rows}
                </div>
                <p class="text-[10px] text-slate-400 italic leading-relaxed">
                    Esempi: <span class="font-mono font-bold">^FTSEMIB</span> · <span class="font-mono font-bold">^GSPC</span> · <span class="font-mono font-bold">^IXIC</span> · <span class="font-mono font-bold">CL=F</span> (Crude Oil) · <span class="font-mono font-bold">GC=F</span> (Gold) · <span class="font-mono font-bold">BTC-USD</span>
                </p>
            </div>
            <div class="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex gap-3">
                <button id="idx-modal-cancel" class="flex-1 py-2.5 rounded-xl font-bold text-slate-500 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all text-sm">Annulla</button>
                <button id="idx-modal-save" class="flex-1 py-2.5 rounded-xl font-bold bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all text-sm">Salva</button>
            </div>
        </div>`;

        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        document.getElementById('idx-modal-close').addEventListener('click', close);
        document.getElementById('idx-modal-cancel').addEventListener('click', close);
        document.getElementById('idx-modal-save').addEventListener('click', () => {
            const newCfg = [0, 1, 2].map(i => ({
                ticker: (document.getElementById(`idx-ticker-${i}`)?.value || '').trim(),
                label:  (document.getElementById(`idx-label-${i}`)?.value || '').trim(),
            })).filter(c => c.ticker);
            saveConfig(newCfg);
            close();
            render({});        // clear immediately
            fetchIndices();    // re-fetch with new config
        });
    }

    // ─── Inject gear button ─────────────────────────────────────────────────────
    // Removed because the button is now injected directly in render()

    // ─── Public API ─────────────────────────────────────────────────────────────
    window.openIndicesConfigModal = buildModal;

    // ─── Init ───────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        // Render loading state is handled by theme.js or first fetch
        fetchIndices();
        setInterval(fetchIndices, REFRESH_MS);
    });
})();
