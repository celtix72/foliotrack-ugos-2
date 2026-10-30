#!/usr/bin/env python3
"""
convert_directa_to_wealthfolio.py
Converte l'estratto conto movimenti di DIRECTA nel formato CSV standard di Wealthfolio (wealthfolio.app).

Uso:
    python3 scripts/convert_directa_to_wealthfolio.py <input_directa.csv> [output_wealthfolio.csv]
"""

import sys
import csv
from datetime import datetime
from collections import defaultdict

TICKER_MAP = {
    # US stocks
    'ABNB': ('ABNB', 'EQUITY'),
    'ADBE': ('ADBE', 'EQUITY'),
    'ASPN': ('ASPN', 'EQUITY'),
    'BABA': ('BABA', 'EQUITY'),
    'CRM': ('CRM', 'EQUITY'),
    'ELV': ('ELV', 'EQUITY'),
    'FI': ('FI', 'EQUITY'),
    'GOOGL': ('GOOGL', 'EQUITY'),
    'HIMS': ('HIMS', 'EQUITY'),
    'IONQ': ('IONQ', 'EQUITY'),
    'JD': ('JD', 'EQUITY'),
    'KSPI': ('KSPI', 'EQUITY'),
    'LULU': ('LULU', 'EQUITY'),
    'MARA': ('MARA', 'EQUITY'),
    'MELI': ('MELI', 'EQUITY'),
    'META': ('META', 'EQUITY'),
    'NOMD': ('NOMD', 'EQUITY'),
    'NU': ('NU', 'EQUITY'),
    'PLTR': ('PLTR', 'EQUITY'),
    'PYPL': ('PYPL', 'EQUITY'),
    'SE': ('SE', 'EQUITY'),
    'UNH': ('UNH', 'EQUITY'),
    'ZTS': ('ZTS', 'EQUITY'),
    
    # European / Xetra / GEM
    'X.AHLA': ('AHLA.DE', 'EQUITY'),
    'X.AMD': ('AMD.DE', 'EQUITY'),
    'X.ASME': ('ASME.DE', 'EQUITY'),
    'X.MSF': ('MSF.DE', 'EQUITY'),
    'X.NOV': ('NOV.DE', 'EQUITY'),
    'X.TL0': ('TL0.DE', 'EQUITY'),
    '1MSFT': ('1MSFT.MI', 'EQUITY'),
    'I.PRX': ('PRX.AS', 'EQUITY'),
    
    # Milan Equities
    'FCT': ('FCT.MI', 'EQUITY'),
    'MFEA': ('MFEA.MI', 'EQUITY'),
    'NEXI': ('NEXI.MI', 'EQUITY'),
    'SPM': ('SPM.MI', 'EQUITY'),
    'STMMI': ('STMMI.MI', 'EQUITY'),
    'TIT': ('TIT.MI', 'EQUITY'),
    
    # ETFs & Commodities
    '3GOO': ('3GOO.MI', 'ETF'),
    '3LNV': ('3LNV.MI', 'ETF'),
    'NGAS': ('NGAS.MI', 'COMMODITY'),
    'TDIV': ('TDIV.MI', 'ETF'),
    'VERE': ('VERE.MI', 'ETF'),
    'X25E': ('X25E.MI', 'ETF'),
    'XCHA': ('XCHA.MI', 'ETF'),
    'XEON': ('XEON.MI', 'ETF'),
}

def clean_sym(raw):
    raw = (raw or '').strip()
    if raw.startswith('.'):
        bare = raw[1:]
        if bare in TICKER_MAP:
            return TICKER_MAP[bare]
        return (bare, 'EQUITY')
    if raw in TICKER_MAP:
        return TICKER_MAP[raw]
    return (raw, 'EQUITY')

def parse_num(s):
    if not s: return 0.0
    return abs(float(str(s).replace(' ', '').replace('.', '').replace(',', '.')))

def parse_date(s):
    if not s: return ''
    parts = s.strip().split('-')
    if len(parts) == 3:
        return f'{parts[2]}-{parts[1]}-{parts[0]}'
    return s

def fmt_money(n):
    if n is None or n == '': return ''
    return f'{float(n):.2f}'

def fmt_price(n):
    if n is None or n == '': return ''
    val = float(n)
    s = f'{val:.4f}'.rstrip('0').rstrip('.')
    if '.' in s:
        parts = s.split('.')
        if len(parts[1]) < 2:
            s = f'{val:.2f}'
    else:
        s = f'{val:.2f}'
    return s

def fmt_qty(n):
    if n is None or n == '': return ''
    val = float(n)
    if val.is_integer():
        return str(int(val))
    return f'{val:.4f}'.rstrip('0').rstrip('.')

def fmt_fee_tax(n):
    if n is None or n == '' or float(n) == 0: return '0'
    return f'{float(n):.2f}'

def fmt_fx(n):
    if n is None or n == '': return ''
    return f'{float(n):.4f}'.rstrip('0').rstrip('.')

def convert_directa_csv(input_path, output_path):
    with open(input_path, 'r', encoding='utf-8-sig', errors='replace') as f:
        lines = f.readlines()

    header_idx = -1
    for i, l in enumerate(lines):
        if 'data operazione' in l.lower() and 'tipo operazione' in l.lower():
            header_idx = i
            break

    if header_idx == -1:
        raise ValueError("Intestazione DIRECTA non trovata nel file.")

    reader = csv.DictReader(lines[header_idx:], delimiter=';')
    rows = list(reader)

    orders = defaultdict(list)
    gross_divs = []
    ritenute = []
    deposits = []
    withdrawals = []
    taxes = []
    fees = []

    for r in rows:
        tipo = r['Tipo operazione'].strip()
        rif = r['Riferimento ordine'].strip()
        
        if rif:
            orders[rif].append(r)
            continue
            
        t_lower = tipo.lower()
        if 'incasso dividend' in t_lower or tipo == 'Provento etf':
            gross_divs.append(r)
        elif 'rit.div' in t_lower or 'ritenuta dividend' in t_lower or tipo == 'Rit.provento etf':
            ritenute.append(r)
        elif tipo == 'Conferimento con bonifico':
            deposits.append(r)
        elif tipo == 'Prelievo bonifico':
            withdrawals.append(r)
        elif tipo in ['Bollo portafoglio titoli*', 'Tobin tax italia', 'Ritenuta su plusvalenza']:
            taxes.append(r)
        elif tipo in ['Prel.cash in lieu/adr fee', 'Addebito canone sms alert', 'Int.passivi finanziamento']:
            fees.append(r)

    records = []

    # 1. Orders (BUY / SELL with partial fills, commissions & ETF withholding tax)
    for rif, rlist in orders.items():
        mains = [r for r in rlist if r['Tipo operazione'].strip() in ['Acquisto', 'Vendita']]
        comms = [r for r in rlist if r['Tipo operazione'].strip() == 'Commissioni']
        rits  = [r for r in rlist if r['Tipo operazione'].strip() == 'Rit. etf']
        
        if not mains:
            continue
            
        first = mains[0]
        act_type = 'BUY' if first['Tipo operazione'].strip() == 'Acquisto' else 'SELL'
        date = parse_date(first['Data operazione'])
        currency = first['Divisa'].strip().upper()
        sym, itype = clean_sym(first['Ticker'])
        
        total_qty = sum(parse_num(m['Quantità']) for m in mains)
        total_div = sum(parse_num(m['Importo Divisa']) for m in mains)
        total_eur = sum(parse_num(m['Importo euro']) for m in mains)
        
        if currency == 'USD':
            unit_price = total_div / total_qty if total_qty > 0 else 0
            total_comm = sum(parse_num(c['Importo Divisa']) if parse_num(c['Importo Divisa']) > 0 else parse_num(c['Importo euro']) for c in comms)
            total_tax  = sum(parse_num(x['Importo Divisa']) if parse_num(x['Importo Divisa']) > 0 else parse_num(x['Importo euro']) for x in rits)
            fx_rate = total_div / total_eur if total_eur > 0 else ''
        else:
            unit_price = total_eur / total_qty if total_qty > 0 else 0
            total_comm = sum(parse_num(c['Importo euro']) for c in comms)
            total_tax  = sum(parse_num(x['Importo euro']) for x in rits)
            fx_rate = ''
            
        records.append({
            'date': date,
            'symbol': sym,
            'instrumentType': itype,
            'quantity': fmt_qty(total_qty),
            'activityType': act_type,
            'unitPrice': fmt_price(unit_price),
            'currency': currency,
            'fee': fmt_fee_tax(total_comm),
            'tax': fmt_fee_tax(total_tax),
            'amount': '',
            'fxRate': fmt_fx(fx_rate),
            'subtype': ''
        })

    # 2. Dividends paired with withholding taxes
    unpaired_rits = list(ritenute)
    for d in gross_divs:
        d_date_obj = datetime.strptime(d['Data operazione'].strip(), '%d-%m-%Y')
        d_ticker = d['Ticker'].strip().lstrip('.')
        date = parse_date(d['Data operazione'])
        sym, itype = clean_sym(d['Ticker'])
        currency = d['Divisa'].strip().upper()
        
        best_idx = -1
        best_diff = 999
        for idx, r in enumerate(unpaired_rits):
            r_ticker = r['Ticker'].strip().lstrip('.')
            if r_ticker == d_ticker:
                r_date_obj = datetime.strptime(r['Data operazione'].strip(), '%d-%m-%Y')
                diff = abs((r_date_obj - d_date_obj).days)
                if diff <= 3 and diff < best_diff:
                    best_diff = diff
                    best_idx = idx
                    
        matched_r = unpaired_rits.pop(best_idx) if best_idx != -1 else None
        
        if currency == 'USD':
            gross = parse_num(d['Importo Divisa'])
            tax_val = parse_num(matched_r['Importo Divisa']) if matched_r else 0.0
            gross_eur = parse_num(d['Importo euro'])
            fx_rate = gross / gross_eur if gross_eur > 0 else ''
        else:
            gross = parse_num(d['Importo euro'])
            tax_val = parse_num(matched_r['Importo euro']) if matched_r else 0.0
            fx_rate = ''
            
        records.append({
            'date': date,
            'symbol': sym,
            'instrumentType': itype,
            'quantity': '1',
            'activityType': 'DIVIDEND',
            'unitPrice': fmt_price(gross),
            'currency': currency,
            'fee': '0',
            'tax': fmt_fee_tax(tax_val),
            'amount': fmt_money(gross),
            'fxRate': fmt_fx(fx_rate),
            'subtype': 'QUALIFIED'
        })

    # 3. Deposits
    for dep in deposits:
        date = parse_date(dep['Data operazione'])
        amt = parse_num(dep['Importo euro'])
        records.append({
            'date': date,
            'symbol': '',
            'instrumentType': '',
            'quantity': '1',
            'activityType': 'DEPOSIT',
            'unitPrice': '1.00',
            'currency': 'EUR',
            'fee': '0',
            'tax': '0',
            'amount': fmt_money(amt),
            'fxRate': '',
            'subtype': ''
        })

    # 4. Withdrawals
    for w in withdrawals:
        date = parse_date(w['Data operazione'])
        amt = parse_num(w['Importo euro'])
        records.append({
            'date': date,
            'symbol': '',
            'instrumentType': '',
            'quantity': '1',
            'activityType': 'WITHDRAWAL',
            'unitPrice': '1.00',
            'currency': 'EUR',
            'fee': '0',
            'tax': '0',
            'amount': fmt_money(amt),
            'fxRate': '',
            'subtype': ''
        })

    # 5. Standalone Taxes (Bollo, Tobin, Plusvalenza)
    for tx in taxes:
        date = parse_date(tx['Data operazione'])
        amt = parse_num(tx['Importo euro'])
        records.append({
            'date': date,
            'symbol': '',
            'instrumentType': '',
            'quantity': '1',
            'activityType': 'TAX',
            'unitPrice': '1.00',
            'currency': 'EUR',
            'fee': '0',
            'tax': '0',
            'amount': fmt_money(amt),
            'fxRate': '',
            'subtype': ''
        })

    # 6. Standalone Fees (ADR fees, SMS alerts, Passivi)
    for fe in fees:
        date = parse_date(fe['Data operazione'])
        currency = fe['Divisa'].strip().upper()
        amt = parse_num(fe['Importo Divisa']) if currency == 'USD' else parse_num(fe['Importo euro'])
        records.append({
            'date': date,
            'symbol': '',
            'instrumentType': '',
            'quantity': '1',
            'activityType': 'FEE',
            'unitPrice': '1.00',
            'currency': currency,
            'fee': '0',
            'tax': '0',
            'amount': fmt_money(amt),
            'fxRate': '',
            'subtype': ''
        })

    # Chronological sort and priority within same date
    TYPE_PRIORITY = {
        'DEPOSIT': 1,
        'DIVIDEND': 2,
        'SELL': 3,
        'BUY': 4,
        'TAX': 5,
        'FEE': 6,
        'WITHDRAWAL': 7
    }
    records.sort(key=lambda r: (r['date'], TYPE_PRIORITY.get(r['activityType'], 99)))

    fieldnames = [
        'date',
        'symbol',
        'instrumentType',
        'quantity',
        'activityType',
        'unitPrice',
        'currency',
        'fee',
        'tax',
        'amount',
        'fxRate',
        'subtype'
    ]

    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in records:
            writer.writerow(r)

    return len(records)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Uso: python3 scripts/convert_directa_to_wealthfolio.py <input_directa.csv> [output_wealthfolio.csv]")
        sys.exit(1)
    inp = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "directa_wealthfolio_export.csv"
    count = convert_directa_csv(inp, out)
    print(f"Conversione completata con successo! {count} movimenti esportati in {out}")
