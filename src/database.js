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
    `);

    // ─── Default settings ────────────────────────────────────────────────────────
    const defaultSettings = {
        fontFamily: "'JetBrains Mono', monospace",
        fontSize:   '14',
        updateFrequency: '5',
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

function recalculatePortfolio(portfolioId) {
    const portfolio = dbConnection.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return;

    const transactions = dbConnection.prepare(
        `SELECT * FROM transactions WHERE portfolioId = ? ORDER BY date ASC`
    ).all(portfolioId);

    let cash = portfolio.initialCash || 0;
    const holdings = {};

    for (const t of transactions) {
        const qty       = t.quantity     || 0;
        const price     = t.price        || 0;
        const comm      = t.commission   || 0;
        const tax       = t.tax          || 0;
        const fx        = t.exchangeRate || 1;
        const amount    = t.amount       || 0;

        switch (t.type) {
            case 'DEPOSIT':    cash += amount; break;
            case 'WITHDRAWAL': cash -= amount; break;
            case 'TAX':        cash -= amount; break;
            case 'TRANSFER':   cash -= amount; break;
            case 'DIVIDEND': {
                const dividendAmount = amount || (qty * price - comm - tax);
                cash += (dividendAmount / fx); 
                break;
            }
            case 'BUY': {
                const cost = (qty * price + comm + tax) / fx;
                cash -= cost;
                holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) + qty;
                break;
            }
            case 'SELL': {
                const proceeds = (qty * price - comm - tax) / fx;
                cash += proceeds;
                holdings[t.assetTicker] = (holdings[t.assetTicker] || 0) - qty;
                break;
            }
        }
    }

    let assetValue = 0;
    let assetCount = 0;
    for (const [ticker, shares] of Object.entries(holdings)) {
        if (shares <= 0) continue;
        assetCount++;
        const asset = dbConnection.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
        if (asset && asset.currentPrice) {
            const lastFxTx = transactions
                .filter(t => t.assetTicker === ticker && t.exchangeRate)
                .at(-1);
            const rate = lastFxTx ? lastFxTx.exchangeRate : 1;
            const priceInPCurr = asset.currency !== portfolio.currency
                ? asset.currentPrice / rate
                : asset.currentPrice;
            assetValue += shares * priceInPCurr;
        }
    }

    const totalValue = cash + assetValue;

    dbConnection.prepare(`
        UPDATE portfolios
        SET currentCash = ?, totalValue = ?, assetCount = ?, performance1D = 0
        WHERE id = ?
    `).run(cash, totalValue, assetCount, portfolioId);
}

function recalculateAll() {
    const ids = dbConnection.prepare(`SELECT id FROM portfolios`).all();
    for (const { id } of ids) recalculatePortfolio(id);
}

module.exports = { 
    get db() { return dbConnection; }, 
    initDb, 
    getSettings, 
    setSetting, 
    recalculatePortfolio, 
    recalculateAll 
};
