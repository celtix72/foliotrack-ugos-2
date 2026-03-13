'use strict';

const Database = require('better-sqlite3');
const path = require('path');

// Store DB file next to src/, in the project root
const DB_PATH = path.join(__dirname, '..', 'foliotrack.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema initialization ───────────────────────────────────────────────────

db.exec(`
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
    updatedAt     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ─── Default settings ────────────────────────────────────────────────────────

const defaultSettings = {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize:   '14',
    updateFrequency: '5'
};

const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
);
for (const [key, value] of Object.entries(defaultSettings)) {
    insertSetting.run(key, value);
}

// ─── Helper functions ────────────────────────────────────────────────────────

function getSettings() {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function setSetting(key, value) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
}

function recalculatePortfolio(portfolioId) {
    const portfolio = db.prepare(`SELECT * FROM portfolios WHERE id = ?`).get(portfolioId);
    if (!portfolio) return;

    const transactions = db.prepare(
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
            case 'DIVIDEND': {
                // Bulk import might not have 'amount' pre-calculated, use qty*price-comm-tax if amount is 0
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

    // Calculate asset value
    let assetValue = 0;
    let assetCount = 0;
    for (const [ticker, shares] of Object.entries(holdings)) {
        if (shares <= 0) continue;
        assetCount++;
        const asset = db.prepare(`SELECT * FROM assets WHERE ticker = ?`).get(ticker);
        if (asset && asset.currentPrice) {
            // Simple: use last known FX or 1:1
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

    db.prepare(`
        UPDATE portfolios
        SET currentCash = ?, totalValue = ?, assetCount = ?, performance1D = 0
        WHERE id = ?
    `).run(cash, totalValue, assetCount, portfolioId);
}

function recalculateAll() {
    const ids = db.prepare(`SELECT id FROM portfolios`).all();
    for (const { id } of ids) recalculatePortfolio(id);
}

module.exports = { db, getSettings, setSetting, recalculatePortfolio, recalculateAll };
