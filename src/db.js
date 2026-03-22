'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
        assetCount  INTEGER NOT NULL DEFAULT 0,
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
        ticker        TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        type          TEXT,
        exchange      TEXT,
        currency      TEXT    NOT NULL DEFAULT 'USD',
        currentPrice  REAL    NOT NULL DEFAULT 0,
        changePercent REAL    NOT NULL DEFAULT 0,
        pe            REAL,
        country       TEXT,
        isManual      INTEGER NOT NULL DEFAULT 0,
        dataSource    TEXT    NOT NULL DEFAULT 'YF',
        isin          TEXT,
        lastUpdateError TEXT,
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
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN totalDividends REAL NOT NULL DEFAULT 0`).run();
    } catch (e) {}

    try {
        dbConnection.prepare(`ALTER TABLE portfolios ADD COLUMN color TEXT DEFAULT '#6366f1'`).run();
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
        portfolioId  INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
        date         TEXT    NOT NULL,
        totalValue   REAL    NOT NULL,
        cashValue    REAL    NOT NULL,
        assetValue   REAL    NOT NULL,
        createdAt    TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(portfolioId, date)
      );

      CREATE TABLE IF NOT EXISTS asset_quotes (
        ticker TEXT NOT NULL,
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
    `);

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
        schemaVersion: '1.0'
    };

    const insertSetting = dbConnection.prepare(
        `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
    );
    for (const [key, value] of Object.entries(defaultSettings)) {
        insertSetting.run(key, value);
    }
}

// Initial connection
initDb();

// ─── Helper functions ────────────────────────────────────────────────────────

function getSettings() {
    const rows = dbConnection.prepare(`SELECT key, value FROM settings`).all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function setSetting(key, value) {
    dbConnection.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
}

function recalculatePortfolio(portfolioId, liveEurUsdRate = null) {
    const portfolio = dbConnection.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return;

    const transactions = dbConnection.prepare(
        `SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`
    ).all(portfolioId);

    let cash = portfolio.initialCash || 0;
    let totalDividends = 0;
    const holdings = {};

    for (const t of transactions) {
        const qty       = t.quantity     || 0;
        const price     = t.price        || 0;
        const comm      = t.commission   || 0;
        const tax       = t.tax          || 0;
        const fx        = t.exchangeRate || 1;
        const amount    = t.amount       || 0;

        const absAmount = Math.abs(amount);
        switch (t.type) {
            case 'DEPOSIT':    cash += absAmount; break;
            case 'WITHDRAWAL': 
            case 'TAX':        
            case 'TRANSFER':   cash -= absAmount; break;
            case 'DIVIDEND': {
                const dividendAmount = amount || (qty * price - comm - tax);
                const dividendInPCurr = dividendAmount / fx;
                cash += dividendInPCurr; 
                totalDividends += dividendInPCurr;
                break;
            }
            case 'BUY': {
                const cost = (t.amount || (qty * price + comm + tax)) / fx;
                cash -= cost;
                holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + qty;
                break;
            }
            case 'SELL': {
                const proceeds = (t.amount || (qty * price - comm - tax)) / fx;
                cash += proceeds;
                holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - qty;
                break;
            }
        }
    }

    let assetValue = 0;
    let assetCount = 0;
    for (const [ticker, shares] of Object.entries(holdings)) {
        if (shares <= 0.0001) continue;
        assetCount++;
        const asset = dbConnection.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
        if (asset && asset.currentPrice) {
            let rate = 1;
            if (asset.currency !== portfolio.currency) {
                if (asset.currency === 'USD' && portfolio.currency === 'EUR') {
                    if (liveEurUsdRate) {
                        rate = liveEurUsdRate;
                    } else {
                        // Fallback 1: Look for persisted EURUSD=X in assets table
                        const savedFx = dbConnection.prepare("SELECT currentPrice FROM assets WHERE ticker = 'EURUSD=X'").get();
                        if (savedFx && savedFx.currentPrice > 0) {
                            rate = savedFx.currentPrice;
                        } else {
                            // Fallback 2: Use last transaction FX rate
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
            
            const priceInPCurr = asset.currency !== portfolio.currency
                ? asset.currentPrice / rate
                : asset.currentPrice;
            assetValue += shares * priceInPCurr;
        }
    }

    // Total value = Cash + Assets (Dividends are already in Cash)
    const totalValue = cash + assetValue;

    dbConnection.prepare(`
        UPDATE portfolios
        SET currentCash = ?, totalValue = ?, totalDividends = ?, assetCount = ?, performance1D = 0
        WHERE id = ?
    `).run(cash, totalValue, totalDividends, assetCount, portfolioId);
}

function recalculateAll(liveEurUsdRate = null) {
    const ids = dbConnection.prepare(`SELECT id FROM portfolios`).all();
    for (const { id } of ids) recalculatePortfolio(id, liveEurUsdRate);
}

function savePortfolioSnapshot(portfolioId = null) {
    let totalValue = 0, cashValue = 0, assetValue = 0;
    const date = new Date().toISOString().split('T')[0];

    if (portfolioId) {
        const p = dbConnection.prepare(`SELECT totalValue, currentCash FROM portfolios WHERE id = ?`).get(portfolioId);
        if (p) {
            totalValue = p.totalValue || 0;
            cashValue = p.currentCash || 0;
            assetValue = totalValue - cashValue;
        } else return;
    } else {
        // Global Dashboard Snapshot
        const portfolios = dbConnection.prepare(`SELECT totalValue, currentCash FROM portfolios`).all();
        portfolios.forEach(p => {
            totalValue += (p.totalValue || 0);
            cashValue += (p.currentCash || 0);
        });
        assetValue = totalValue - cashValue;
    }

    dbConnection.prepare(`
        INSERT INTO portfolio_history (portfolioId, date, totalValue, cashValue, assetValue)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(portfolioId, date) DO UPDATE SET
            totalValue = excluded.totalValue,
            cashValue = excluded.cashValue,
            assetValue = excluded.assetValue
    `).run(portfolioId, date, Math.round(totalValue), Math.round(cashValue), Math.round(assetValue));
}

module.exports = { 
    get db() { return dbConnection; }, 
    initDb, 
    getSettings, 
    setSetting, 
    recalculatePortfolio, 
    recalculateAll,
    savePortfolioSnapshot
};
