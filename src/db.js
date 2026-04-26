'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Store DB file next to src/, in the project root, or via ENV
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'foliotrack.db');

let dbConnection;

function initDb() {
    if (dbConnection) {
        try { dbConnection.close(); } catch (e) {}
    }
    
    dbConnection = new Database(DB_PATH);
    
    // Enable WAL mode for better performance
    dbConnection.pragma('journal_mode = WAL');
    dbConnection.pragma('foreign_keys = ON');

    // ─── Schema initialization ───────────────────────────────────────────────────
    dbConnection.exec(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        type        TEXT    NOT NULL DEFAULT 'Investimento',
        currency    TEXT    NOT NULL DEFAULT 'EUR',
        startDate   TEXT    NOT NULL,
        initialCash REAL    NOT NULL DEFAULT 0,
        currentCash REAL    NOT NULL DEFAULT 0,
        totalValue  REAL    NOT NULL DEFAULT 0,
        performance1D REAL  NOT NULL DEFAULT 0,
        performance1DPrePost REAL NOT NULL DEFAULT 0,
        totalDividends REAL NOT NULL DEFAULT 0,
        investedCapital REAL NOT NULL DEFAULT 0,
        assetCount  INTEGER NOT NULL DEFAULT 0,
        color       TEXT,
        createdAt   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolioId  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        type         TEXT    NOT NULL,
        assetTicker  TEXT,
        date         TEXT    NOT NULL,
        quantity     REAL    NOT NULL DEFAULT 0,
        price        REAL    NOT NULL DEFAULT 0,
        commission   REAL    NOT NULL DEFAULT 0,
        tax          REAL    NOT NULL DEFAULT 0,
        exchangeRate REAL    NOT NULL DEFAULT 1,
        amount       REAL    NOT NULL DEFAULT 0,
        createdAt    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS assets (
        id            TEXT    PRIMARY KEY,
        ticker        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT    NOT NULL,
        type          TEXT,
        exchange      TEXT,
        currency      TEXT    NOT NULL DEFAULT 'USD',
        currentPrice  REAL    NOT NULL DEFAULT 0,
        changePercent REAL    NOT NULL DEFAULT 0,
        pe            REAL,
        country       TEXT,
        targetPrice   REAL,
        stopLoss      REAL,
        forwardPE     REAL,
        dividendYield REAL,
        eps           REAL,
        beta          REAL,
        nextDividendDate TEXT,
        isManual      INTEGER NOT NULL DEFAULT 0,
        dataSource    TEXT    NOT NULL DEFAULT 'YF',
        isin          TEXT,
        lastUpdateError TEXT,
        quoteDate     TEXT,
        changeValue   REAL    NOT NULL DEFAULT 0,
        isVirtualHistory INTEGER NOT NULL DEFAULT 0,
        targetPrice2  REAL,
        volatilityAlert INTEGER,
        updatedAt     TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migration: Add type to portfolios if it doesn't exist
    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN type TEXT NOT NULL DEFAULT 'Investimento'`).run();
    } catch (e) {}

    // Migration: Add performance1DPrePost to portfolios if it doesn't exist
    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN performance1DPrePost REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    // Migration: Add totalDividends to portfolios if it doesn't exist
    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN totalDividends REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    // Migration: Add investedCapital to portfolios if it doesn't exist
    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN investedCapital REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    // Migration: Add color to portfolios if it doesn't exist
    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN color TEXT`).run();
    } catch (e) {}

    // Migration: Add country to assets if it doesn't exist
    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN country TEXT`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN isManual INTEGER NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN inWatchlist INTEGER NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN isMonitored INTEGER NOT NULL DEFAULT 1`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN targetPrice REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN stopLoss REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN dataSource TEXT NOT NULL DEFAULT 'YF'`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN isin TEXT`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN lastUpdateError TEXT`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN quoteDate TEXT`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN changeValue REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN isVirtualHistory INTEGER NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN targetPrice2 REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN volatilityAlert INTEGER`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN volatilityAlert INTEGER DEFAULT 5`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN preMarketChangePercent REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN postMarketChangePercent REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN totalDividends REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN color TEXT DEFAULT '#6366f1'`).run();
    } catch (e) {}

    // --- New Equity Metrics Migrations ---
    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN forwardPE REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN dividendYield REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN eps REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN beta REAL`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE assets ADD COLUMN nextDividendDate TEXT`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE portfolio_history ADD COLUMN netDeposits REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    // ─── Notifications Table ──────────────────────────────────────────────────
    dbConnection.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        type    TEXT    NOT NULL,
        title   TEXT    NOT NULL,
        message TEXT    NOT NULL,
        ticker  TEXT,
        date    TEXT    NOT NULL DEFAULT (datetime('now')),
        isRead  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS portfolio_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolioId  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        date         TEXT    NOT NULL,
        totalValue   REAL    NOT NULL DEFAULT 0,
        cashValue    REAL    NOT NULL DEFAULT 0,
        assetValue   REAL    NOT NULL DEFAULT 0,
        netDeposits  REAL    NOT NULL DEFAULT 0,
        createdAt    TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(portfolioId, date)
      );

      CREATE TABLE IF NOT EXISTS asset_quotes (
        ticker TEXT NOT NULL COLLATE NOCASE,
        date   TEXT NOT NULL,
        price  REAL NOT NULL,
        UNIQUE(ticker, date)
      );

      CREATE TABLE IF NOT EXISTS tax_rates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_type TEXT    NOT NULL UNIQUE,
        rate       REAL    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_losses (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        portfolioId  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        asset_type   TEXT    NOT NULL,
        amount       REAL    NOT NULL DEFAULT 0,
        UNIQUE(portfolioId, asset_type)
      );

      CREATE TABLE IF NOT EXISTS dividend_projections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker      TEXT    NOT NULL,
        name        TEXT,
        exDate      TEXT    NOT NULL,
        amount      REAL    NOT NULL,
        totalAmount REAL    NOT NULL DEFAULT 0,
        yield       REAL    NOT NULL DEFAULT 0,
        tag         TEXT    NOT NULL,
        year        INTEGER NOT NULL,
        isCustom    INTEGER NOT NULL DEFAULT 0,
        createdAt   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS global_news (
        uuid        TEXT    PRIMARY KEY,
        ticker      TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        publisher   TEXT    NOT NULL,
        link        TEXT    NOT NULL,
        publishedAt INTEGER NOT NULL,
        createdAt   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        email         TEXT    UNIQUE,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL DEFAULT 'free',
        display_name  TEXT,
        last_login    TEXT,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        reset_token   TEXT,
        reset_token_expiry TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS portfolio_users (
        portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(portfolio_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT    NOT NULL,
        resource    TEXT    NOT NULL,
        is_enabled  INTEGER NOT NULL DEFAULT 1,
        UNIQUE(role, resource)
      );
    `);

    // Migration: Add role_permissions defaults if empty
    try {
        const count = dbConnection.prepare('SELECT COUNT(*) as c FROM role_permissions').get().c;
        if (count === 0) {
            const defaultResources = [
                'page_dashboard', 'page_portfolio', 'page_market', 'page_reports', 'page_history', 'page_dividend', 'page_watchlist', 'page_settings', 'page_notifications',
                'setting_account', 'setting_appearance', 'setting_portfolio', 'setting_data_sources', 'setting_news', 'setting_telegram', 'setting_volatility', 'setting_backup', 'setting_diagnostic', 'setting_maintenance', 'setting_logs', 'setting_history_mgmt', 'setting_taxation', 'setting_audit', 'setting_danger_zone'
            ];
            const roles = ['admin', 'free', 'user'];
            const stmt = dbConnection.prepare('INSERT INTO role_permissions (role, resource, is_enabled) VALUES (?, ?, ?)');
            dbConnection.transaction(() => {
                for (const r of roles) {
                    for (const res of defaultResources) {
                        stmt.run(r, res, 1);
                    }
                }
            })();
        }
    } catch (e) {}

    // Standardized asset types remapping
    const remapSql = [
        `UPDATE assets SET type = 'Azioni' WHERE type IN ('Stock', 'Equity', 'EQUITY', 'Azionario')`,
        `UPDATE tax_rates SET asset_type = 'Azioni' WHERE asset_type IN ('Stock', 'Equity', 'Azionario')`,
        `UPDATE assets SET type = 'Bond' WHERE type IN ('Obbligazionario', 'BOND')`,
        `UPDATE tax_rates SET asset_type = 'Bond' WHERE asset_type IN ('Obbligazionario')`,
        `UPDATE assets SET type = 'ETF Azionario' WHERE type LIKE 'ETF%Azionario%'`,
        `UPDATE assets SET type = 'ETF Monetario' WHERE type LIKE 'ETF%Monetario%'`,
        `UPDATE assets SET type = 'ETF Obblig' WHERE type LIKE 'ETF%Obblig%' OR type LIKE 'ETF%Bond%'`
    ];
    remapSql.forEach(sql => {
        try { dbConnection.prepare(sql).run(); } catch(e) {}
    });

    // Default tax rates for new standardized types
    const standardizedTaxRates = [
        { type: 'Azioni', rate: 26.0 },
        { type: 'Bond', rate: 12.5 },
        { type: 'ETF Azionario', rate: 26.0 },
        { type: 'ETF Monetario', rate: 12.5 },
        { type: 'ETF Obblig', rate: 12.5 },
        { type: 'Deposito Vincolato', rate: 26.0 },
        { type: 'Cash', rate: 0.0 }
    ];

    const insertTaxRate = dbConnection.prepare(
        `INSERT OR IGNORE INTO tax_rates (asset_type, rate) VALUES (?, ?)`
    );
    standardizedTaxRates.forEach(tr => insertTaxRate.run(tr.type, tr.rate));

    // ─── Default settings ────────────────────────────────────────────────────────
    const defaultSettings = {
        fontFamily: "'JetBrains Mono', monospace",
        fontSize:   '14',
        updateFrequency: '5',
        privacyMode: 'false',
        telegramBotToken: '',
        telegramChatId: '',
        telegramEnabled: 'false',
        marketStatusTelegramEnabled: 'false',
        marketStatusInterval: '60',
        disabledNewsSources: '[]',
        schemaVersion: '1.0'
    };

    const insertSetting = dbConnection.prepare(
        `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
    );
    for (const [key, value] of Object.entries(defaultSettings)) {
        insertSetting.run(key, value);
    }

    // ─── Migrations: Add user columns if they don't exist ────────────────────────
    try { dbConnection.prepare(`ALTER TABLE users ADD COLUMN email TEXT UNIQUE`).run(); } catch (e) {}
    try { dbConnection.prepare(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1`).run(); } catch (e) {}
    try { dbConnection.prepare(`ALTER TABLE users ADD COLUMN reset_token TEXT`).run(); } catch (e) {}
    try { dbConnection.prepare(`ALTER TABLE users ADD COLUMN reset_token_expiry TEXT`).run(); } catch (e) {}

    // ─── Seed: default admin user (mauro / pippo) ───────────────────────────
    const existingAdmin = dbConnection.prepare(`SELECT id FROM users WHERE username = 'mauro'`).get();
    if (!existingAdmin) {
        const hash = bcrypt.hashSync('pippo', 10);
        dbConnection.prepare(
            `INSERT INTO users (username, password_hash, role, display_name, must_change_password) VALUES (?, ?, ?, ?, ?)`
        ).run('mauro', hash, 'admin', 'Mauro', 0);
    } else {
        // Ensure mauro is always admin
        try {
            dbConnection.prepare(`UPDATE users SET role = 'admin', must_change_password = 0 WHERE username = 'mauro'`).run();
        } catch (e) {}
    }


    // ─── Seed: associate all existing portfolios to mauro ───────────────────
    try {
        const mauroUser = dbConnection.prepare(`SELECT id FROM users WHERE username = 'mauro'`).get();
        if (mauroUser) {
            const portfolios = dbConnection.prepare(`SELECT id FROM portfolios`).all();
            const insertPU = dbConnection.prepare(
                `INSERT OR IGNORE INTO portfolio_users (portfolio_id, user_id) VALUES (?, ?)`
            );
            portfolios.forEach(p => insertPU.run(p.id, mauroUser.id));
        }
    } catch (e) {
        // Non-critical: will be retried on next boot if portfolios exist
    }
}

// Initial connection
initDb();

// ─── Helper functions ────────────────────────────────────────────────────────

function getSettings() {
    const rows = dbConnection.prepare(`SELECT key, value FROM settings`).all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    
    // Default values for new settings
    if (settings.volatilityNotificationsEnabled === undefined) settings.volatilityNotificationsEnabled = 'false';
    if (settings.volatilityThreshold === undefined) settings.volatilityThreshold = '5.0';
    
    return settings;
}

function setSetting(key, value) {
    dbConnection.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
}

function recalculatePortfolio(portfolioId, liveEurUsdRate = null, variationOverrides = null) {
    const portfolio = dbConnection.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return;

    const transactions = dbConnection.prepare(
        `SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`
    ).all(portfolioId);

    let cash = portfolio.initialCash || 0;
    let totalDividends = 0;
    const holdings = {}; // { ticker: { shares: 0, totalCost: 0, totalCostAssetCurr: 0 } }

    for (const t of transactions) {
        const qty       = t.quantity     || 0;
        const price     = t.price        || 0;
        const comm      = t.commission   || 0;
        const tax       = t.tax          || 0;
        const fx        = t.exchangeRate || 1;
        const amount    = t.amount       || 0;
        const absAmount = Math.abs(amount);
        const ticker    = t.assetTicker || '';

        // 1. Pure Cash Management (No Asset Holdings Impact)
        const typeUC = (t.type || '').toUpperCase();
        if (['DEPOSIT', 'DEPOSITO', 'WITHDRAWAL', 'PRELIEVO', 'TAX', 'TRANSFER', 'RECONCILE'].includes(typeUC)) {
            const absAmount = amount ? Math.abs(amount) : (qty * price) / fx;
            if (['DEPOSIT', 'DEPOSITO', 'RECONCILE'].includes(typeUC)) cash += absAmount;
            else cash -= absAmount;
            continue;
        }

        // 2. Dividends (Can have ticker 'CASH' or no ticker, or asset ticker)
        if (typeUC === 'DIVIDEND' || typeUC === 'DIV') {
            const divAmt = amount ? amount : (qty * price - comm - tax) / fx;
            cash += divAmt; 
            totalDividends += divAmt;
            continue;
        }

        // 3. Asset Operations (Requires a non-CASH ticker)
        if (!ticker || ticker === 'CASH') continue;

        if (!holdings[ticker]) holdings[ticker] = { shares: 0, totalCost: 0, totalCostAssetCurr: 0 };
        const h = holdings[ticker];

        switch (t.type) {
            case 'BUY': {
                const cost = amount ? Math.abs(amount) : (qty * price + comm + tax) / fx;
                const costAsset = amount ? (Math.abs(amount) * fx) : (qty * price + comm + tax);
                cash -= cost;
                h.shares += qty;
                h.totalCost += cost;
                h.totalCostAssetCurr += costAsset;
                break;
            }
            case 'SELL': {
                const proceeds = amount ? Math.abs(amount) : (qty * price - comm - tax) / fx;
                const pmc = h.shares > 0 ? h.totalCost / h.shares : 0;
                const pmcAsset = h.shares > 0 ? h.totalCostAssetCurr / h.shares : 0;
                cash += proceeds;
                h.shares -= qty;
                h.totalCost -= qty * pmc;
                h.totalCostAssetCurr -= qty * pmcAsset;
                break;
            }
        }
    }

    let assetValue = 0;
    let assetCount = 0;
    let performance1D = 0;
    let performance1DPrePost = 0;
    for (const [ticker, h] of Object.entries(holdings)) {
        const shares = h.shares;
        if (shares <= 0.0001) continue;
        assetCount++;
        const asset = dbConnection.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
        let price = (asset && asset.currentPrice > 0) ? asset.currentPrice : 0;
        const aCurr = (asset && asset.currency) ? asset.currency : 'EUR';
        
        // Special logic for CD_ assets: Price is strictly cost-basis based (no market fluctuate)
        if (ticker && ticker.startsWith('CD_')) {
            price = h.shares > 0 ? h.totalCostAssetCurr / h.shares : 0;
        } else if (price <= 0) {
            // Fallback for missing prices for other tickers
            const lastBuy = transactions.filter(t => t.assetTicker === ticker && t.type === 'BUY' && t.price > 0).at(-1);
            if (lastBuy) price = lastBuy.price;
        }

        if (price > 0) {
            let rate = 1;
            const aCurr = (asset && asset.currency) ? asset.currency : 'EUR';
            if (aCurr !== portfolio.currency) {
                if (asset.currency === 'USD' && portfolio.currency === 'EUR') {
                    if (liveEurUsdRate) {
                        rate = liveEurUsdRate;
                    } else {
                        const savedFx = dbConnection.prepare("SELECT currentPrice FROM assets WHERE ticker = 'EURUSD=X'").get();
                        if (savedFx && savedFx.currentPrice > 0) {
                            rate = savedFx.currentPrice;
                        } else {
                            const lastFxTx = transactions
                                .filter(t => t.assetTicker === ticker && t.exchangeRate)
                                .at(-1);
                            rate = lastFxTx ? lastFxTx.exchangeRate : 1;
                        }
                    }
                } else {
                    const lastFxTx = transactions
                        .filter(t => t.assetTicker === ticker && t.exchangeRate)
                        .at(-1);
                    rate = lastFxTx ? lastFxTx.exchangeRate : 1;
                }
            }
            
            const priceInPCurr = (aCurr !== portfolio.currency && rate !== 0)
                ? price / rate
                : price;
            assetValue += shares * priceInPCurr;

            // Calculate daily market variations
            let chgReg = (asset && asset.changeValue) ? asset.changeValue : 0;
            let chgPrePost = 0;

            if (variationOverrides) {
                if (variationOverrides.regular && variationOverrides.regular.hasOwnProperty(ticker)) {
                    chgReg = variationOverrides.regular[ticker];
                }
                if (variationOverrides.prePost && variationOverrides.prePost.hasOwnProperty(ticker)) {
                    chgPrePost = variationOverrides.prePost[ticker];
                }
            }

            if (chgReg !== 0) {
                const changeInPCurr = (aCurr !== portfolio.currency && rate !== 0) ? chgReg / rate : chgReg;
                performance1D += shares * changeInPCurr;
            }
            if (chgPrePost !== 0) {
                const changeInPCurr = (aCurr !== portfolio.currency && rate !== 0) ? chgPrePost / rate : chgPrePost;
                performance1DPrePost += shares * changeInPCurr;
            }
        }
    }

    // Total value = Cash + Assets (Dividends are already in Cash)
    const totalValue = cash + assetValue;

    // Safety guards against NaN and Infinity
    const finalCash = (isNaN(cash) || !isFinite(cash)) ? 0 : cash;
    const finalTotalValue = (isNaN(totalValue) || !isFinite(totalValue)) ? 0 : totalValue;
    const finalDividends = (isNaN(totalDividends) || !isFinite(totalDividends)) ? 0 : totalDividends;
    const finalPerf1D = (isNaN(performance1D) || !isFinite(performance1D)) ? 0 : performance1D;
    const finalPerf1DPrePost = (isNaN(performance1DPrePost) || !isFinite(performance1DPrePost)) ? 0 : performance1DPrePost;

    dbConnection.prepare(`
        UPDATE portfolios
        SET currentCash = ?, totalValue = ?, totalDividends = ?, assetCount = ?, performance1D = ?, performance1DPrePost = ?
        WHERE id = ?
    `).run(finalCash, finalTotalValue, finalDividends, assetCount, finalPerf1D, finalPerf1DPrePost, portfolioId);
}

function recalculateAll(liveEurUsdRate = null, variationOverrides = null) {
    const ids = dbConnection.prepare(`SELECT id FROM portfolios`).all();
    for (const { id } of ids) {
        try {
            recalculatePortfolio(id, liveEurUsdRate, variationOverrides);
        } catch (err) {
            console.error(`[DB] Error recalculating portfolio ${id}:`, err);
        }
    }
}

function savePortfolioSnapshot(portfolioId = null, eurUsdRate = 1.0) {
    let totalValue = 0, cashValue = 0, assetValue = 0, netDeposits = 0;
    const date = new Date().toISOString().split('T')[0];

    if (portfolioId) {
        const p = dbConnection.prepare(`SELECT totalValue, currentCash FROM portfolios WHERE id = ?`).get(portfolioId);
        if (p) {
            totalValue = p.totalValue || 0;
            cashValue = p.currentCash || 0;
            assetValue = totalValue - cashValue;
            
            // Calculate current netDeposits for this portfolio
            const txs = dbConnection.prepare(`SELECT type, amount, exchangeRate, quantity, price, commission, tax FROM transactions WHERE portfolioId = ?`).all(portfolioId);
            let netDep = 0;
            for (const t of txs) {
                const amount = t.amount || ((t.quantity || 0) * (t.price || 0) + (t.commission || 0) + (t.tax || 0)) / (t.exchangeRate || 1);
                if (t.type === 'DEPOSIT') netDep += amount;
                if (t.type === 'WITHDRAWAL') netDep -= amount;
                if (t.type === 'TRANSFER') netDep -= amount;
            }
            // For now, simplicity: netDeposits is used to identify profit. 
            // Better to use portfolio and calculated netDeposits if available.
            netDeposits = netDep;
        } else return;
    } else {
        // Global Dashboard Snapshot - Convert to EUR for consistent aggregate history
        const portfolios = dbConnection.prepare(`SELECT id, currency, totalValue, currentCash FROM portfolios`).all();
        for (const p of portfolios) {
            let tVal = (p.totalValue || 0);
            let cVal = (p.currentCash || 0);
            
            // Calculate netDeposits for this portfolio to aggregate globally
            const txs = dbConnection.prepare(`SELECT type, amount, exchangeRate, quantity, price, commission, tax FROM transactions WHERE portfolioId = ?`).all(p.id);
            let pNetDep = 0;
            for (const t of txs) {
                const amount = t.amount || ((t.quantity || 0) * (t.price || 0) + (t.commission || 0) + (t.tax || 0)) / (t.exchangeRate || 1);
                if (t.type === 'DEPOSIT') pNetDep += amount;
                if (t.type === 'WITHDRAWAL') pNetDep -= amount;
                if (t.type === 'TRANSFER') pNetDep -= amount;
            }

            // Convert to EUR if native is USD
            if (p.currency === 'USD' && eurUsdRate && eurUsdRate > 0) {
                tVal /= eurUsdRate;
                cVal /= eurUsdRate; 
                pNetDep /= eurUsdRate;
            }
            
            totalValue += tVal;
            cashValue += cVal;
            netDeposits += pNetDep;
        }
        assetValue = totalValue - cashValue;
    }

    dbConnection.prepare(`
        INSERT INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue, netDeposits)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(portfolioId, date) DO UPDATE SET
            totalValue = excluded.totalValue,
            cashValue = excluded.cashValue,
            assetValue = excluded.assetValue,
            netDeposits = excluded.netDeposits
    `).run(portfolioId, date, Math.round(totalValue), Math.round(cashValue), Math.round(assetValue), Math.round(netDeposits));
}

// ─── Auth helper functions ───────────────────────────────────────────────────

/**
 * Creates a new user. Returns the created user object or throws on error.
 */
function createUser(username, password, email = null, role = 'free', displayName = '', mustChangePassword = 1) {
    const hash = bcrypt.hashSync(password, 10);
    const result = dbConnection.prepare(
        `INSERT INTO users (username, email, password_hash, role, display_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(username, email, hash, role, displayName || username, mustChangePassword);
    return dbConnection.prepare(`SELECT id, username, email, role, display_name, created_at FROM users WHERE id = ?`).get(result.lastInsertRowid);
}

/**
 * Verifies credentials. Returns user object on success, null on failure.
 */
function verifyUser(username, password) {
    const user = dbConnection.prepare(`SELECT * FROM users WHERE username = ? OR email = ?`).get(username, username);
    if (!user) return null;
    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return null;
    // Update last_login
    dbConnection.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);
    return { id: user.id, username: user.username, email: user.email, role: user.role, display_name: user.display_name, must_change_password: user.must_change_password };
}

/**
 * Returns all users (without password hashes).
 */
function getAllUsers() {
    return dbConnection.prepare(`SELECT id, username, email, role, display_name, last_login, created_at FROM users ORDER BY id`).all();
}

/**
 * Returns portfolios accessible by a user. Admin sees all.
 */
function getUserPortfolios(userId, role) {
    if (role === 'admin') {
        return dbConnection.prepare(`SELECT id FROM portfolios`).all().map(r => r.id);
    }
    return dbConnection.prepare(
        `SELECT portfolio_id as id FROM portfolio_users WHERE user_id = ?`
    ).all(userId).map(r => r.id);
}

/**
 * Associates a portfolio with a user (idempotent).
 */
function addPortfolioUser(portfolioId, userId) {
    dbConnection.prepare(
        `INSERT OR IGNORE INTO portfolio_users (portfolio_id, user_id) VALUES (?, ?)`
    ).run(portfolioId, userId);
}

/**
 * Deletes a user and their portfolio associations.
 */
function deleteUser(userId) {
    dbConnection.prepare(`DELETE FROM portfolio_users WHERE user_id = ?`).run(userId);
    dbConnection.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}

/**
 * Updates a user's role.
 */
function updateUserRole(userId, role) {
    dbConnection.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, userId);
}

/**
 * Updates a user's password.
 */
function updateUserPassword(userId, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    dbConnection.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, userId);
}

// ─── PERMISSIONS EXPORTS ────────────────────────────────────────────────────────
function getRolePermissions() {
    return dbConnection.prepare('SELECT role, resource, is_enabled FROM role_permissions ORDER BY role, resource').all();
}

function updateRolePermission(role, resource, isEnabled) {
    dbConnection.prepare('INSERT INTO role_permissions (role, resource, is_enabled) VALUES (?, ?, ?) ON CONFLICT(role, resource) DO UPDATE SET is_enabled = excluded.is_enabled').run(role, resource, isEnabled);
}

function getUserPermissions(role) {
    const perms = dbConnection.prepare('SELECT resource, is_enabled FROM role_permissions WHERE role = ?').all(role);
    const result = {};
    for (const p of perms) {
        result[p.resource] = p.is_enabled === 1;
    }
    return result;
}

module.exports = { 
    get db() { return dbConnection; }, 
    initDb, 
    getSettings, 
    setSetting, 
    recalculatePortfolio, 
    recalculateAll,
    savePortfolioSnapshot,
    createUser,
    verifyUser,
    getAllUsers,
    getUserPortfolios,
    addPortfolioUser,
    deleteUser,
    updateUserRole,
    updateUserPassword,

    // Permissions
    getRolePermissions,
    updateRolePermission,
    getUserPermissions
};
