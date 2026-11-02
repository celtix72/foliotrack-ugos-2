# 📘 FolioTrack - Guida di Ricreazione e Blueprint Architetturale Completo

Questo documento costituisce la specifica tecnica definitiva e la roadmap suddivisa in **Step/Prompt operativi** per ricreare da zero l'intera applicazione **FolioTrack** (piattaforma web self-hosted per il tracciamento avanzato di portafogli multi-asset: Azioni, ETF, Obbligazioni/BTP, Criptovalute, Liquidità e Fondi, ottimizzata per Docker e NAS UGOS).

Questa versione integra nativamente l'estetica visiva e le funzionalità di punta analizzate da **Wealthfolio**:
* **Tipografia Finanziaria Quantitativa**: basata sul font **`JetBrains Mono`** con allineamento numerico tabellare (`tabular-nums`) e **`Inter Variable`** per i controlli.
* **Design System "Signature"**: card con raggio 16px (`rounded-2xl`), pulsanti e badge a pillola (`rounded-full`), ombreggiature diffuse multilivello e palette colori pastello naturale (verde salvia e corallo).
* **Dashboard Dinamica a 12 Colonne con 14 Widget Spostabili**: motore di drag-and-drop e ridimensionamento basato su **`GridStack.js`** con persistenza del layout a database.
* **Tassonomia Multi-Dimensionale**: classificazione simultanea per *Asset Class*, *Instrument Type*, *Categoria di Rischio*, *11 Settori GICS* ed *Esposizione Geografica*.
* **Accounting Flessibile dei Lotti**: supporto a **WAC** (Prezzo Medio Ponderato / PMC italiano) e **FIFO**.
* **Simulatore Pensionamento & FIRE con Monte Carlo**: proiezioni stocastiche di sostenibilità del capitale e analisi della sequenza dei rendimenti (SORR).

---

## 🗺️ Indice delle Fasi e Priorità

| Priorità | Sezione | Fase | Descrizione Sintetica |
| :--- | :--- | :--- | :--- |
| **P0** | **Backend** | [Fase 1](#fase-1-backend-p0---fondamenta-database-sicurezza-e-crittografia) | Inizializzazione Node.js, Express 5, Better-SQLite3 (WAL), Crittografia AES-256 e Auth JWT |
| **P1** | **Backend** | [Fase 2](#fase-2-backend-p1---motore-finanziario-tassonomia-gics-e-multi-conto) | Portafogli multi-broker (WAC/FIFO), Tassonomia GICS/Regioni, Calcolo Finanziario (PMC, TWR, XIRR) |
| **P1** | **Frontend** | [Fase 3](#fase-3-frontend-p1---design-system-signature-jetbrains-mono-e-layout) | Design System "Signature", JetBrains Mono, Tailwind CSS, Sidebar dinamica e Shell Mobile PWA |
| **P2** | **Backend** | [Fase 4](#fase-4-backend-p2---provider-dati-di-mercato-scraping-e-cache) | Yahoo Finance, Borsa Italiana (Realtime + API Storica BTP con Bearer Token), Google Finance |
| **P2** | **Frontend** | [Fase 5](#fase-5-frontend-p2---dashboard-a-12-colonne-con-14-widget-spostabili) | Dashboard GridStack.js a 12 colonne con 14 widget riposizionabili, Rebalancing e Modal transazioni |
| **P3** | **Backend** | [Fase 6](#fase-6-backend-p3---motore-importexport-e-parser-broker) | Import CSV con auto-detection (Directa, IFIS, Generico), Export bidirezionale compatibile Wealthfolio |
| **P3** | **Frontend** | [Fase 7](#fase-7-frontend-p3---scheda-dettaglio-portafoglio-e-gestione-movimenti) | Tabella Holdings con scomposizione GICS, Registro transazioni con filtri, Bulk CSV uploader |
| **P4** | **Full-Stack** | [Fase 8](#fase-8-full-stack-p4---dividendi-flussi-di-cassa-e-fisco) | Flussi cedolari aggregati (Mese, Asset, Conto con crescita YoY), Snapshot giornaliero e Zainetto Fiscale |
| **P5** | **Full-Stack** | [Fase 9](#fase-9-full-stack-p5---simulatore-pensione-fire-monte-carlo-e-ai-advisor) | Calcolatore Pensione/FIRE, Simulazione Monte Carlo, AI Advisory Multi-LLM e PDF Report |
| **P6** | **Backend & Deploy** | [Fase 10](#fase-10-backend--devops-p6---notifiche-telegrampush-backup-e-docker-ugos) | Bot Telegram, Web Push VAPID, Disaster Recovery (Local + GDrive), Docker Alpine per NAS UGOS |

---

## 🛠️ Stack Tecnologico di Riferimento

- **Runtime & Server**: Node.js (v20+ LTS), Express 5 (`express@^5.2.1`), `cookie-parser`, `dotenv`.
- **Database**: SQLite 3 ad alte prestazioni tramite `better-sqlite3@^12.6.2`, configurato in modalità `WAL` e `foreign_keys = ON`.
- **Sicurezza & Crittografia**: `helmet@^8.2.0` (dual HTTP/HTTPS Content Security Policy), `express-rate-limit`, `bcryptjs`, `jsonwebtoken` (cookie httpOnly `SameSite=Lax`), crittografia simmetrica `aes-256-gcm` per credenziali e chiavi API memorizzate a DB.
- **Provider Dati**: `yahoo-finance2@^3.15.2`, Scraping HTML e REST API Borsa Italiana (`grafici.borsaitaliana.it`), Google Finance fallback.
- **Frontend & Grafica**:
  - Tipografia: **JetBrains Mono** (numeri e tabelle con `tabular-nums`), **Inter Variable** (testi e form), **Merriweather** (report).
  - Framework CSS: **Tailwind CSS** (`@tailwindcss/forms`, `@tailwindcss/container-queries`), Dark/Light mode theme engine.
  - Griglia Dashboard: **GridStack.js** (`gridstack.min.js`) a 12 colonne con supporto Drag-and-Drop, Resize e salvataggio layout JSON.
  - Grafici Interattivi: Highcharts / Chart.js modulare (candele, serie storiche, benchmark, allocazione treemap/donut).
- **Notifiche & Servizi**: Telegram Bot API (`axios`), Web Push (`web-push` VAPID), `nodemailer`.
- **Motore AI & Analisi Quantitativa**: Multi-LLM (Google Gemini, OpenAI, Qwen, OpenRouter), Tavily Search API, Simulatore Monte Carlo.
- **DevOps & Container**: Docker Alpine con `dumb-init` (gestione corretta segnali PID 1 per SQLite), Docker Compose per UGREEN NAS (UGOS 1.9+).

---

# 🚀 PROMPT OPERATIVI PER ANTIGRAVITY

---

### FASE 1: [BACKEND] [P0] - Fondamenta, Database, Sicurezza e Crittografia

> **Obiettivo**: Creare l'architettura base del server, il sistema di crittografia per i segreti, il database SQLite con WAL mode e le migrazioni, e il layer di autenticazione JWT con protezione rate-limit e Helmet.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Senior Backend Engineer. Inizializza il backend di FolioTrack basato su Node.js ed Express 5.

Requisiti da implementare:
1. Setup Progetto & Dipendenze:
   - Configura package.json con Express 5, better-sqlite3, bcryptjs, jsonwebtoken, cookie-parser, dotenv, helmet, cors, express-rate-limit.
2. Database Layer (src/db.js):
   - Connessione a better-sqlite3 con DB_PATH configurabile via ENV (default: data/foliotrack.db).
   - Abilita pragma 'journal_mode = WAL' e 'foreign_keys = ON'.
   - Crea un gestore di crittografia AES-256-GCM per chiavi API e segreti (prefisso "enc:v1:"), derivando la chiave da SETTINGS_ENCRYPTION_KEY / JWT_SECRET.
   - Implementa il DDL completo delle tabelle:
     * users (id, username, email, password_hash, role ['admin','user','viewer'], createdAt)
     * settings (user_id, key, value, PRIMARY KEY(user_id, key))
     * user_sessions, audit_logs, failed_logins, push_subscriptions
3. Middleware di Sicurezza (src/middlewares/securityMiddleware.js):
   - Configura Helmet con supporto differenziato HTTP e HTTPS per Content-Security-Policy (CSP) consentendo script e stili da self, unsafe-inline, cdn.jsdelivr.net, cdnjs.cloudflare.com, e font google.
   - Configura rate limiter generale per /api/ (max 1000 req / 15 min) e rate limiter rigido per /api/auth/login (max 15 req / 15 min).
   - Abilita CORS con credentials: true e allowedOrigins via ENV.
4. Autenticazione & Sessioni (src/routes/auth.js e src/middlewares/authMiddleware.js):
   - Login con verifica bcrypt, generazione token JWT firmato con scadenza (es. 7 giorni).
   - Invio token sia via cookie httpOnly (SameSite: Lax) che in risposta JSON per client API.
   - Middleware requireAuth che valida il token da cookie o Bearer header e popola req.user.
   - Endpoint di logout che invalida il cookie e pulisce la sessione.
   - Seed iniziale: se la tabella users è vuota, crea l'utente admin predefinito con password configurabile o hash sicuro.
```

---

### FASE 2: [BACKEND] [P1] - Motore Finanziario, Tassonomia GICS e Multi-Conto

> **Obiettivo**: Implementare la gestione di portafogli multi-broker (con supporto WAC e FIFO), la tassonomia multi-dimensionale (Settori GICS, Regioni, Asset Class), il registro transazioni completo e il motore di calcolo finanziario (PMC, ROI, TWR, XIRR, Net Deposits).

#### Prompt da fornire ad Antigravity:
```text
Agisci come Quantitative Financial Software Engineer. Implementa il motore finanziario core, la tassonomia multidimensionale e le API dei portafogli per FolioTrack.

Requisiti da implementare:
1. Tabelle SQLite (estensione src/db.js):
   - portfolios: id, name, type ('Investimento', 'Pensione', 'Trading', 'Liquidità'), currency ('EUR', 'USD'), costBasisMethod ('WAC', 'FIFO' - default: WAC), startDate, initialCash, currentCash, totalValue, performance1D, performance1DPrePost, totalDividends, investedCapital, assetCount, color, include_in_totals, createdAt.
   - portfolio_users: portfolio_id, user_id, role ('owner', 'viewer').
   - assets: id, ticker (COLLATE NOCASE UNIQUE), name, type, exchange, currency, currentPrice, changePercent, pe, country, region (es. Europe, Americas, Asia), sector (11 settori GICS: Information Technology, Financials, Health Care, Consumer Discretionary, Consumer Staples, Industrials, Energy, Utilities, Materials, Real Estate, Communication Services), riskCategory ('LOW', 'MEDIUM', 'HIGH'), targetPrice, stopLoss, forwardPE, dividendYield, eps, beta, quoteDate, changeValue, updatedAt.
   - transactions: id, portfolioId, type ('BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'SPLIT', 'FEE', 'TAX'), assetTicker, date (YYYY-MM-DD), quantity, price, commission, tax, exchangeRate, amount, notes, linkedTransactionId, createdAt.
2. Motore Finanziario (src/utils/finance.js):
   - Calcolo Prezzo Medio di Carico (PMC / WAC): formula della media ponderata progressiva per acquisti successivi; ricalcolo automatico della quantità residua e delle plusvalenze/minusvalenze realizzate ad ogni vendita.
   - Supporto alternativo a FIFO per lotti fiscali individuali.
   - Calcolo Net Deposits: somma di (DEPOSIT + BUY) meno somma di (WITHDRAWAL + TRANSFER + SELL) per la liquidità pura, oppure formula netta cumulativa per il portafoglio.
   - Calcolo Plusvalenze/Minusvalenze Realizzate (Realized P&L) e Non Realizzate (Unrealized P&L).
   - Algoritmo XIRR (Internal Rate of Return per flussi di cassa irregolari con metodo di Newton-Raphson).
   - Algoritmo TWR (Time-Weighted Return) concatenando i rendimenti dei sotto-periodi intermedi tra depositi/prelievi esterni.
   - Calcolo ROI standard: (Valore Attuale / Net Deposits) - 1.
3. API Portafogli (src/routes/portfolios.js):
   - GET /api/portfolios: lista portafogli dell'utente con statistiche calcolate in tempo reale.
   - POST /api/portfolios: creazione nuovo portafoglio con specifica della valuta base e del metodo di costo (WAC o FIFO).
   - PUT /api/portfolios/:id: aggiornamento impostazioni e switch include_in_totals.
   - DELETE /api/portfolios/:id: eliminazione a cascata.
4. API Transazioni (src/routes/transactions.js):
   - Inserimento atomico transazioni (con transazione SQLite dbConnection.transaction):
     * Per BUY/SELL aggiorna la cassa corrente (currentCash) e il PMC.
     * Per DEPOSIT/WITHDRAWAL aggiorna currentCash e netDeposits.
   - PUT e DELETE con rollback e ricalcolo immediato della cassa e delle quote.
```

---

### FASE 3: [FRONTEND] [P1] - Design System "Signature", JetBrains Mono e Layout

> **Obiettivo**: Costruire l'infrastruttura grafica adottando l'estetica di Wealthfolio: tipografia quantitativa `JetBrains Mono` con allineamento tabellare, tema "Signature" con card smussate a 16px, pulsanti a pillola, ombreggiature layered, supporto Dual-View e Dark/Light mode istantaneo.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Senior Frontend Engineer e UI/UX Designer. Implementa l'infrastruttura grafica e il layout "Signature" per FolioTrack.

Requisiti da implementare:
1. Tipografia & CSS Base (public/input.css e tailwind.config.js):
   - Importa i font Google: 'JetBrains Mono' (peso 400, 500, 700) e 'Inter' (peso 400, 500, 600, 700).
   - Imposta come font monospaziale primario 'JetBrains Mono' e applica la regola globale:
     body { font-variant-numeric: tabular-nums; }
   - tailwind.config.js con darkMode: 'class' ed estensione delle classi:
     * rounded-2xl (16px / 1rem) per card e contenitori
     * rounded-full per bottoni e badge
     * Palette colori "Signature":
       - Light Mode: sfondo gradiente (#fafafa -> #f6f6f6), card #fdfdfd, testo #121212, verde profitto #357941, rosso perdita #b3261e, badge sottili #e8f2eb e #fbe7e5.
       - Dark Mode: sfondo gradiente (#121213 -> #0d0d0e), card #1a1a1c, testo #f4f4f5, verde profitto #86c09c, rosso perdita #f08a7e, bordi card #ffffff0f.
       - Palette grafici pastello a 9 colori: #4f6b92, #b89a4c, #8e7cb3, #7b96c9, #b74583, #2f4f73, #d2b98a, #9c998e, #cfccc6.
2. Gestore Tema (public/theme.js):
   - Gestione istantanea Dark/Light mode senza FOUC memorizzata in localStorage con fallback di sistema.
   - Sfumature diffuse a più livelli (layered shadows) applicate alle card.
3. Server-Side Routing Dual-View (src/server.js):
   - Funzione isMobile(req) per rilevamento smartphone da User-Agent o parametro ?view=mobile.
   - Funzione serveWithSidebar(req, res, file):
     * Serve private_views/*_mobile.html su client mobili.
     * Serve private_views/*.html su desktop iniettando la sidebar parziale da private_views/partials/sidebar_partial.html.
     * Cache in memoria per le pagine HTML con invalidazione su mtime dei file.
4. Componenti di Navigazione:
   - Login (public/login.html): login form rifinito con font mono, feedback animati e remember me.
   - Sidebar Desktop (private_views/partials/sidebar_partial.html): navigazione laterale con icone SVG pulite, indicatore di pagina attiva e badge versione build.
   - Live Ticker Bar (public/header_indices.js): barra superiore a scorrimento con quotazioni realtime dei principali indici mondiali (S&P 500, FTSE MIB, BTP 10Y, Oro, Bitcoin).
```

---

### FASE 4: [BACKEND] [P2] - Provider Dati di Mercato, Scraping e Cache

> **Obiettivo**: Implementare il recupero resiliente delle quotazioni correnti e storiche da Yahoo Finance, Borsa Italiana (HTML scraping e API JSON con token Bearer) e Google Finance.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Backend Integration Specialist. Implementa il sistema completo di market data fetching e cron-update per FolioTrack.

Requisiti da implementare:
1. Yahoo Finance Integration (src/routes/market.js):
   - Wrapper su yahoo-finance2 per ricerca ticker (search), quote realtime e storico candele (chart).
   - Sanitizzazione dei prezzi e normalizzazione dei ticker (gestione suffissi .MI, .DE, ecc.).
2. Borsa Italiana Provider per BTP, Obbligazioni MOT ed ETF italiani (src/routes/market.js & src/server.js):
   - Realtime/Quotazione Odierna: scraping HTML mirato su https://www.borsaitaliana.it/borsa/search/scheda.html?code={ISIN}&lang=it estraendo il valore dal selettore "span.-formatPrice strong".
   - Storico Quotazioni BTP/MOT: interrogazione dell'endpoint REST interno:
     https://grafici.borsaitaliana.it/api/instruments/{ISIN},XMIL,ISIN/history/period?period=5Y&adjustment=true&add-last-price=true
   - Autenticazione Borsa Italiana: utilizzo dell'header HTTP:
     Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiItMSIsImV4cCI6NDkwNTU4MzU3MiwiaWF0IjoxNzUxOTgzNTcyLCJhdXRob3JpdGllcyI6W119.d7Eh_LOGqA44BH58HIiPrPIz1SLskVOPj4BRsae05cI
     (Token client ufficiale con scadenza 2125).
   - Parsing dell'array JSON historyDt estraendo dt (YYYYMMDD) e closePx.
3. Google Finance Fallback (src/services/googleFinance.js):
   - Scraping di Google Finance per ticker ritardati o non coperti da Yahoo Finance.
4. Tabella Cache & Batch Update:
   - asset_quotes: ticker, date, close, volume, source, updatedAt.
   - Job programmato di aggiornamento prezzi per tutti gli asset presenti nei portafogli attivi, con rate-limiting tra le chiamate per evitare ban IP.
```

---

### FASE 5: [FRONTEND] [P2] - Dashboard a 12 Colonne con 14 Widget Spostabili

> **Obiettivo**: Realizzare la Dashboard modulare reattiva basata su `GridStack.js` a 12 colonne con 14 widget censiti da Wealthfolio, pulsante di personalizzazione drag-and-drop, motore di Rebalancing e finestra modale transazioni universale.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Lead Frontend Developer. Implementa la Dashboard a widget spostabili e i componenti interattivi di FolioTrack.

Requisiti da implementare:
1. Griglia Reattiva a 12 Colonne (GridStack.js):
   - Integra GridStack.js (gridstack-all.js e gridstack.min.css) in private_views/dashboard.html e dashboard_mobile.html.
   - Configurazione griglia: 12 colonne per Desktop, 6 per Tablet, 2 per Mobile.
   - Implementa i 14 Widget ufficiali censiti da Wealthfolio:
     1. 'value' (w:4, h:2): Portfolio Value (NAV totale + variazione 1D in € e %).
     2. 'cash' (w:2, h:2): Saldo Liquidità disponibile.
     3. 'invested' (w:2, h:2): Capitale Versato Netto (Net Deposits).
     4. 'bookCost' (w:2, h:2): Prezzo Medio di Carico aggregato (PMC totale).
     5. 'pnl' (w:2, h:2): Guadagno/Perdita Totale non realizzato (€ e %).
     6. 'accounts' (w:3, h:4): Ripartizione per Broker/Conto (Directa, Widiba) in ciambella.
     7. 'classes' (w:3, h:4): Ripartizione per Asset Class (Equity, BTP/Bond, ETF, Cash, Crypto).
     8. 'regions' (w:3, h:4): Esposizione Geografica (Italia, Europa, USA, Emergenti).
     9. 'sectors' (w:3, h:4): Esposizione per gli 11 Settori GICS.
     10. 'composition' (w:9, h:8): Treemap o Sunburst dettagliato di tutti i singoli titoli.
     11. 'targets' (w:3, h:8): Widget di Rebalancing (confronto tra allocazione reale e target desiderato, con calcolo automatico dell'importo in € da acquistare o vendere per riequilibrare).
     12. 'breakdown' (w:12, h:5): Tabella riassuntiva di tutti gli asset con pesi % e variazioni.
     13. 'movers' (w:6, h:6): Top Gainers & Losers della giornata.
     14. 'concentration' (w:6, h:6): Indice di concentrazione del rischio (peso dei top 3 e top 5 asset sul totale).
2. Modalità Personalizzazione Dashboard:
   - Pulsante "Personalizza Dashboard": sblocca la griglia, abilita maniglie di trascinamento e maniglie di ridimensionamento in basso a destra su ciascuna card.
   - Pannello a cassetto (Drawer) per mostrare/nascondere singoli widget.
   - Tasto "Salva Layout" che invia l'array delle coordinate JSON all'endpoint PUT /api/settings salvando la chiave 'insightsOverviewLayout'.
3. Modal Inserimento/Modifica Transazione (public/transaction_modal.js):
   - Modale universale con design JetBrains Mono.
   - Autocomplete ticker con quotazione in tempo reale.
   - Calcolo automatico del controvalore (Quantità × Prezzo ± Commissioni ± Tasse).
   - Conversione FX automatica per transazioni in valuta estera (USD -> EUR).
```

---

### FASE 6: [BACKEND] [P3] - Motore Import/Export e Parser Broker

> **Obiettivo**: Implementare il parsing automatico di estratti conto e file CSV di broker italiani/internazionali (Directa, IFIS) e l'esportazione bidirezionale compatibile al 100% con Wealthfolio.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Data Processing Engineer. Implementa il sistema di importazione ed esportazione transazioni in src/utils/brokerParsers.js e src/utils/exportFormats.js.

Requisiti da implementare:
1. Parser CSV Multiformato con Auto-Detection (src/utils/brokerParsers.js):
   - Funzione detectBroker(csvText): analizza le intestazioni per identificare il formato:
     * DIRECTA: colonne "tipo operazione", "riferimento ordine", "data operazione", "descrizione".
     * BANCA IFIS: "data contabile", "causale", "importo".
     * GENERICO: mapping personalizzato basato su data, ticker, tipo, quantità, prezzo, importo.
   - Gestione formattazione numeri e date italiane (virgole decimali, punti per migliaia, formati DD/MM/YYYY o DD-MM-YYYY).
   - Mapping causali Directa: "acquisto" -> BUY, "vendita" -> SELL, "incasso dividendi*" -> DIVIDEND, "conferimento con bonifico" -> DEPOSIT, "prelievo" -> WITHDRAWAL.
2. Endpoint di Importazione (src/routes/transactions.js):
   - POST /api/transactions/import-csv: upload file tramite Multer, parsing in memoria, validazione righe, anteprima opzionale e inserimento atomico a DB saltando duplicati già esistenti.
3. Generatore Export Compatibile Wealthfolio (src/utils/exportFormats.js):
   - Generazione CSV conforme alle specifiche di Wealthfolio:
     date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype
   - Mapping dell'instrumentType: EQUITY, ETF, CRYPTO, BOND, MUTUAL_FUND, COMMODITY (lasciando vuoto per movimenti di pura cassa).
   - Mapping dell'activityType: BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, FEE, TAX, SPLIT.
   - Endpoint GET /api/portfolios/:id/export/wealthfolio che genera e scarica direttamente il file CSV.
```

---

### FASE 7: [FRONTEND] [P3] - Scheda Dettaglio Portafoglio e Gestione Movimenti

> **Obiettivo**: Realizzare le pagine dettagliate di gestione del singolo portafoglio, la tabella completa delle posizioni (holdings) con scomposizione GICS, la tabella dei movimenti con filtri avanzati e l'interfaccia di importazione drag-and-drop.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Frontend UI Engineer. Implementa le viste di dettaglio del portafoglio e la gestione completa delle transazioni con estetica JetBrains Mono.

Requisiti da implementare:
1. Scheda Portafoglio (private_views/portfolio_detail.html e portfolio_detail_mobile.html):
   - Tabella Posizioni Aperte (Holdings): Ticker, Nome, Asset Class, Settore GICS, Paese/Regione, Quantità posseduta, PMC, Prezzo Corrente, Valore di Mercato, P&L Non Realizzato (€ e %), Peso % sul portafoglio.
   - Badge colorati con gradiente tenue per variazione giornaliera e totale.
   - Drawer o modale informativa cliccando su un singolo asset con grafico storico interattivo e dettaglio dividendi percepiti.
2. Registro Transazioni (private_views/transactions.html e transactions_mobile.html):
   - Tabella paginata e filtrabile per tipo operazione, ticker, data range, portafoglio.
   - Azioni rapide per riga: Modifica e Cancella con richiesta di conferma.
   - Tasto "Esporta Transazioni" con download immediato del formato CSV compatibile Wealthfolio.
3. Componente Bulk Import CSV (public/bulk_import.js):
   - Area di drop per trascinamento file CSV.
   - Anteprima tabellare interattiva dei record prima del salvataggio definitivo, con evidenziazione in giallo o rosso di eventuali errori di conversione o ticker sconosciuti.
```

---

### FASE 8: [FULL-STACK] [P4] - Dividendi, Flussi di Cassa e Fisco

> **Obiettivo**: Implementare il tracking avanzato dei flussi cedolari aggregati (ispirato al modulo Income di Wealthfolio: per mese, per asset, per conto e YoY growth), la proiezione a 12 mesi, il calendario stacchi, il calcolo della fiscalità italiana (zainetto fiscale e minusvalenze) e lo snapshot giornaliero del NAV.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Full-Stack Financial Engineer. Implementa il modulo Dividendi & Flussi di Cassa e il modulo Fiscale.

Requisiti da implementare:
1. Backend Flussi di Reddito & Proiezioni (src/routes/dividends.js):
   - Tabella dividend_projections: calcolo dividendi stimati per i prossimi 12 mesi basati sulle quantità a portafoglio e sul dividendYield di Yahoo Finance.
   - Endpoint GET /api/dividends/income-summary: restituisce un'analisi aggregata strutturata:
     * byMonth: storico incassi mensili negli ultimi 3 anni.
     * byAsset: classifica dei titoli più redditizi in portafoglio.
     * byAccount: suddivisione incassi per broker (es. Directa vs Widiba).
     * byType: distinzione netta tra dividendi azionari (DIVIDEND) e cedole BTP/obbligazioni (INTEREST).
     * yoyGrowth: tasso di crescita annuale dei flussi generati.
2. Backend Snapshot Giornaliero (src/server.js o src/backfill_history.js):
   - Tabella portfolio_history: id, portfolioId, date, totalValue, cashValue, assetValue, netDeposits, user_id.
   - Job programmato giornaliero (a chiusura mercati) che calcola il NAV totale e registra uno snapshot immutabile.
   - Endpoint GET /api/history/performance per generare serie temporali complete per grafici di rendimento cumulativo e drawdown.
3. Modulo Fiscale & Minusvalenze:
   - Tabella portfolio_losses: tracciamento delle minusvalenze con anno di creazione e data di scadenza (4 anni successivi secondo normativa italiana).
   - Compensazione automatica delle plusvalenze realizzate con le minusvalenze pregresse capienti.
4. Viste Frontend (private_views/history.html, history_mobile.html):
   - Grafico a barre con flussi cedolari divisi per mese e per tipologia (Dividendi vs Cedole BTP).
   - Tabella delle minusvalenze con barra di avanzamento del periodo di validità residuo.
```

---

### FASE 9: [FULL-STACK] [P5] - Simulatore Pensione / FIRE, Monte Carlo e AI Advisor

> **Obiettivo**: Implementare il simulatore previdenziale con proiezioni stocastiche Monte Carlo e analisi SORR (ispirato a Wealthfolio Goals), combinato con il consulente intelligente Multi-LLM (Gemini, OpenAI, Qwen) e generatore di report PDF.

#### Prompt da fornire ad Antigravity:
```text
Agisci come Quantitative Analyst & AI Engineer. Implementa il simulatore di pensionamento/FIRE e il modulo di consulenza AI di FolioTrack.

Requisiti da implementare:
1. Motore Pensionamento & FIRE con Simulazione Monte Carlo (src/utils/retirement.js e src/routes/goals.js):
   - Parametri utente: Età attuale, età target di pensionamento, patrimonio iniziale, risparmio mensile programmato, spesa mensile prevista post-pensione, orizzonte temporale.
   - Simulatore Monte Carlo (1000 iterazioni stocastiche basate sulla distribuzione log-normale dei rendimenti storici e sulla volatilità dell'asset allocation):
     * Calcolo del Tasso di Successo del Capitale (% di simulazioni in cui il patrimonio non si esaurisce prima della fine).
     * Calcolo del Percentile 10 (Scenario Pessimistico), Percentile 50 (Mediano) e Percentile 90 (Ottimistico).
   - Analisi SORR (Sequence of Returns Risk): simulazione dell'impatto di un crollo di mercato del -30% nei primi 3 anni di pensionamento.
2. Servizio AI Multi-Provider (src/services/aiService.js):
   - Supporto ad architetture e provider multipli configurabili da impostazioni:
     * Google Gemini (gemini-1.5-pro, gemini-2.0-flash, ecc.)
     * OpenAI (gpt-4o, gpt-4o-mini), Qwen, OpenRouter, Requesty, AIMLAPI.
   - Integrazione con Tavily Search API per arricchire il prompt con le ultime notizie macroeconomiche e societarie rilevanti per i titoli in portafoglio.
   - Prompt engineering finanziario strutturato:
     * Input: composizione portafoglio, pesi percentuali, P/E medio, dividend yield, volatilità, orizzonte temporale.
     * Output: Risk Score (1-100), Diversification Score, Asset Allocation Quality, punti di forza, criticità e raccomandazioni tattiche/strategiche.
3. Viste e Generazione PDF Client-Side (private_views/reports.html, public/ai_reports.js, public/pdf_report.js):
   - Visualizzazione interattiva del grafico Monte Carlo a ventaglio e delle scorecard AI.
   - Esportazione istantanea in PDF formattato per stampa (layout pulito con intestazione, tabelle, grafici vettoriali e disclaimer).
```

---

### FASE 10: [BACKEND & DEVOPS] [P6] - Notifiche (Telegram/Push), Backup e Docker UGOS

> **Obiettivo**: Finalizzare le notifiche automatiche via Bot Telegram e Web Push, i backup automatici (locali con rotazione e sincronizzazione Google Drive) e il packaging Docker ottimizzato per NAS UGREEN (UGOS).

#### Prompt da fornire ad Antigravity:
```text
Agisci come Senior DevOps & Systems Engineer. Finalizza i canali di notifica, il sistema di disaster recovery e la configurazione Docker di FolioTrack.

Requisiti da implementare:
1. Notifiche Telegram (src/services/telegramService.js):
   - Invio messaggi con parse_mode: HTML via Bot API ufficiale.
   - Digest giornaliero di chiusura mercati con performance portafogli ed emoji dinamiche in base al rendimento.
   - Alert su prezzi target raggiunti o stop loss toccati.
2. Web Push Notifications (src/services/pushService.js):
   - Setup chiavi VAPID, gestione endpoint /api/push/subscribe e salvataggio subscription su SQLite.
   - Invio notifiche push native al browser desktop e mobile tramite Service Worker (public/sw.js).
3. Disaster Recovery & Backup (src/backup_manager.js e src/services/gdriveBackupService.js):
   - Backup automatico notturno del file SQLite data/foliotrack.db compresso in formato ZIP con timestamp.
   - Politica di retention: mantenimento degli ultimi 14 backup locali in data/backups/.
   - Upload automatico opzionale su Google Drive tramite service account OAuth2 / API Drive.
4. Packaging Docker & Compose per UGREEN UGOS (Dockerfile e docker-compose.yml):
   - Dockerfile basato su node:20-alpine:
     * Installazione dumb-init per gestione PID 1 e chiusura pulita senza corruzione di SQLite.
     * Installazione dipendenze di compilazione C++ (python3, make, g++) per compilare better-sqlite3 su Alpine.
   - docker-compose.yml:
     * Restart policy: unless-stopped.
     * Mapping volumi: ./data:/app/data (persistenza DB e backup).
     * Timezone: Europe/Rome.
     * Limiti log Docker (max-size: "10m", max-file: "3") per non saturare la memoria del NAS.
     * Healthcheck HTTP su porta 3000 con riavvio automatico se non risponde.
```

---

## 📋 Checklist di Verifica Finale

Al termine dell'esecuzione di tutti i passaggi, verifica che:
- [ ] Il database SQLite `data/foliotrack.db` sia in modalità `WAL` e accetti scritture concorrenti.
- [ ] Il layout grafico utilizzi il font **JetBrains Mono** per tutti i dati e le tabelle numeriche (`tabular-nums`).
- [ ] La Dashboard utilizzi **GridStack.js** con i 14 widget censiti e permetta di trascinarli, ridimensionarli e salvarne la posizione.
- [ ] La ricerca dei titoli su Yahoo Finance e l'estrazione dei BTP da Borsa Italiana (`grafici.borsaitaliana.it`) funzionino senza errori.
- [ ] L'inserimento di una transazione ricalcoli correttamente Liquidità, PMC (WAC/FIFO) e Valore Totale.
- [ ] Il simulatore Monte Carlo calcoli la probabilità di successo e i ventagli di rendimento per l'obiettivo pensionistico.
- [ ] L'export in formato Wealthfolio produca un CSV conforme alle specifiche dell'app.
- [ ] Il container Docker si avvii e risponda con esito `healthy` su porta `3000`.
