#!/usr/bin/env python3
"""
replace_directa_deposits.py
Sostituisce nel database di FolioTrack (SQLite) tutti i movimenti di tipo DEPOSITO / CONFERIMENTO
per il portafoglio "DIRECTA" con la lista dei 14 conferimenti effettivi estratti dall'estratto conto.

Uso:
    python3 scripts/replace_directa_deposits.py [percorso_database.db]
"""

import sys
import os
import sqlite3
import shutil
from datetime import datetime

NEW_DEPOSITS = [
    # (data ISO, importo, descrizione/note)
    ('2024-02-14', 15000.0, 'Conferimento con bonifico'),
    ('2024-02-14', 5000.0,  'Conferimento con bonifico'),
    ('2025-03-07', 2000.0,  'Conferimento con bonifico'),
    ('2025-04-01', 5000.0,  'Conferimento con bonifico'),
    ('2025-04-09', 10000.0, 'Conferimento con bonifico'),
    ('2025-04-14', 10000.0, 'Conferimento con bonifico'),
    ('2025-05-30', 5000.0,  'Conferimento con bonifico'),
    ('2025-06-13', 15000.0, 'Conferimento con bonifico'),
    ('2025-06-17', 12000.0, 'Conferimento con bonifico'),
    ('2025-07-24', 15000.0, 'Conferimento con bonifico'),
    ('2025-07-25', 11600.0, 'Conferimento con bonifico'),
    ('2025-08-07', 15000.0, 'Conferimento con bonifico'),
    ('2025-08-08', 50715.0, 'Conferimento con bonifico'),
    ('2026-06-23', 5000.0,  'Conferimento con bonifico'),
]

def recalculate_portfolio_stats(conn, portfolio_id):
    """
    Ricalcola currentCash e investedCapital secondo la logica ufficiale di FolioTrack (src/db.js).
    """
    cur = conn.cursor()
    cur.execute('SELECT initialCash FROM portfolios WHERE id = ?', (portfolio_id,))
    row = cur.fetchone()
    initial_cash = row[0] if row and row[0] is not None else 0.0

    cur.execute('SELECT type, amount, quantity, price, commission, tax, exchangeRate, assetTicker FROM transactions WHERE portfolioId = ? ORDER BY date ASC', (portfolio_id,))
    txs = cur.fetchall()

    cash = initial_cash
    invested_capital = initial_cash

    for t in txs:
        raw_type = (t[0] or '').upper()
        amount = t[1] or 0.0
        qty = t[2] or 0.0
        price = t[3] or 0.0
        comm = t[4] or 0.0
        tax = t[5] or 0.0
        fx = t[6] or 1.0
        ticker = (t[7] or '').strip().upper()

        abs_amount = abs(amount) if amount else (qty * price) / fx

        if raw_type in ('DEPOSIT', 'DEPOSITO', 'RECONCILE'):
            cash += abs_amount
            if raw_type != 'RECONCILE':
                invested_capital += abs_amount
            continue

        if raw_type in ('WITHDRAWAL', 'PRELIEVO', 'TAX', 'TRANSFER'):
            cash -= abs_amount
            if raw_type in ('WITHDRAWAL', 'PRELIEVO', 'TRANSFER'):
                invested_capital -= abs_amount
            continue

        if raw_type in ('DIVIDEND', 'DIV'):
            div_amt = amount if amount else (qty * price - comm - tax) / fx
            cash += div_amt
            continue

        if not ticker or ticker == 'CASH':
            continue

        if raw_type == 'BUY':
            cost = abs(amount) if amount else (qty * price + comm + tax) / fx
            cash -= cost
        elif raw_type == 'SELL':
            proceeds = abs(amount) if amount else (qty * price - comm - tax) / fx
            cash += proceeds

    cur.execute('UPDATE portfolios SET currentCash = ?, investedCapital = ? WHERE id = ?', (cash, invested_capital, portfolio_id))
    return cash, invested_capital

def replace_deposits(db_path, create_backup=True):
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database non trovato: {db_path}")

    if create_backup:
        backup_file = db_path + f".bak_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        shutil.copy2(db_path, backup_file)
        print(f"📦 Backup preventivo salvato in: {backup_file}")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Trova il portafoglio DIRECTA
    cur.execute("SELECT id, name, currentCash, investedCapital FROM portfolios WHERE UPPER(name) = 'DIRECTA'")
    port = cur.fetchone()
    if not port:
        # Cerca parziale
        cur.execute("SELECT id, name, currentCash, investedCapital FROM portfolios WHERE UPPER(name) LIKE '%DIRECTA%'")
        port = cur.fetchone()

    if not port:
        conn.close()
        raise ValueError("Nessun portafoglio 'DIRECTA' trovato nel database.")

    pid, pname, old_cash, old_inv = port
    print(f"🎯 Portafoglio trovato: ID={pid}, Nome='{pname}'")
    print(f"   Stato attuale: Liquidità = {old_cash:.2f} €, Capitale investito = {old_inv:.2f} €")

    # Conta ed elimina i vecchi depositi
    cur.execute("""
        SELECT count(*), coalesce(sum(amount), 0) FROM transactions 
        WHERE portfolioId = ? AND (UPPER(type) IN ('DEPOSIT', 'DEPOSITO') OR notes LIKE '%conferimento%')
    """, (pid,))
    del_count, del_sum = cur.fetchone()
    print(f"🗑️  Rimozione di {del_count} vecchi depositi (Totale: {del_sum:.2f} €)...")

    cur.execute("""
        DELETE FROM transactions 
        WHERE portfolioId = ? AND (UPPER(type) IN ('DEPOSIT', 'DEPOSITO') OR notes LIKE '%conferimento%')
    """, (pid,))

    # Inserisci i nuovi depositi
    now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    for d_date, d_amt, d_notes in NEW_DEPOSITS:
        cur.execute("""
            INSERT INTO transactions (
                portfolioId, type, assetTicker, date, quantity, price, 
                commission, tax, exchangeRate, amount, notes, createdAt
            ) VALUES (?, 'DEPOSIT', 'CASH', ?, 1.0, ?, 0.0, 0.0, 1.0, ?, ?, ?)
        """, (pid, d_date, d_amt, d_amt, d_notes, now_str))

    new_sum = sum(x[1] for x in NEW_DEPOSITS)
    print(f"✨ Inseriti {len(NEW_DEPOSITS)} nuovi conferimenti (Totale: {new_sum:.2f} €).")

    # Ricalcola totali del portafoglio
    new_cash, new_inv = recalculate_portfolio_stats(conn, pid)
    conn.commit()
    conn.close()

    print(f"✅ Ricalcolo completato con successo per '{pname}':")
    print(f"   Nuova Liquidità:         {new_cash:.2f} € (variazione: {new_cash - old_cash:+.2f} €)")
    print(f"   Nuovo Capitale Investito: {new_inv:.2f} € (variazione: {new_inv - old_inv:+.2f} €)")

if __name__ == '__main__':
    target_db = sys.argv[1] if len(sys.argv) > 1 else 'foliotrack.db'
    replace_deposits(target_db)
