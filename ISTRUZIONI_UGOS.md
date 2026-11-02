# 🚀 Guida di Installazione FolioTrack 2 su UGREEN NAS (UGOS 1.9+)

Questa cartella (`FolioTrackUGOS_2`) è pronta e ottimizzata per essere eseguita come istanza separata e indipendente sul motore **Docker nativo** del tuo **NAS UGREEN con UGOS 1.9**, collegata al repository GitHub `foliotrack-ugos-2`.

---

## 📦 Struttura Principale

- **`data/`**: Contiene il database SQLite persistente (`data/foliotrack.db`) già sincronizzato e la sottocartella `data/backups/`. Questo percorso è montato nel container, quindi tutti i tuoi dati e backup sono al sicuro sul disco del NAS anche aggiornando il container.
- **`Dockerfile`**: Ottimizzato su Alpine Linux con `dumb-init` per la gestione corretta dei segnali di stop (evita corruzioni del database SQLite) e con compilazione dei moduli C++ (`better-sqlite3`).
- **`docker-compose.yml`**: Configurato con riavvio automatico (`unless-stopped`), servizio `foliotrack-2`, IP statico dedicato `192.168.178.211` (per evitare collisioni con l'istanza originale su `192.168.178.210`), limiti sui log di sistema, healthcheck automatico e timezone italiana (`Europe/Rome`).
- **`.env`**: File con le variabili d'ambiente e segreti dell'applicazione.

---

## 📋 Metodo 1: Avvio tramite Interfaccia Grafica di UGOS (Consigliato)

### 1. Copia i file sul NAS
1. Sul Mac, apri il **Finder** e premi `Cmd + K`.
2. Digita `smb://<IP_DEL_TUO_NAS>` e collegati con le tue credenziali.
3. Apri la cartella condivisa **`docker`** del NAS.
4. Trascina l'intera cartella **`FolioTrackUGOS_2`** (oppure rinominala in `foliotrack-2` dentro `docker`).

### 2. Crea il Progetto nell'App Docker di UGOS
1. Apri l'interfaccia web di UGOS e fai clic sull'app **Docker**.
2. Dal menu a sinistra, clicca su **Progetti** (oppure **Compose**).
3. Clicca su **Crea Progetto**:
   - **Nome Progetto**: `foliotrack-2`
   - **Percorso**: Seleziona la cartella `/docker/FolioTrackUGOS_2` (o `/docker/foliotrack-2`) appena copiata.
   - Assicurati che sia selezionato l'uso del file `docker-compose.yml` presente nella cartella.
4. Clicca su **Avanti / Distribuisci**: UGOS compilerà automaticamente l'immagine o scaricherà l'immagine da `ghcr.io/celtix72/foliotrack-ugos-2:latest` e avvierà il container.
5. In breve tempo vedrai lo stato passare a **In esecuzione (Sano/Healthy)**.

---

## 💻 Metodo 2: Avvio da Terminale SSH (Per utenti avanzati)

1. **Abilita SSH** su UGOS:
   - *Pannello di Controllo* > *Terminale e SNMP* > seleziona **Abilita servizio SSH** (porta 22).
2. **Copia la cartella via rsync** dal terminale del Mac:
   ```bash
   rsync -av /Users/mauro/Documents/Progetti_Sviluppo/FolioTrackUGOS_2/ <utente_nas>@<IP_DEL_NAS>:/volume1/docker/foliotrack-2/
   ```
3. **Accedi via SSH** al NAS:
   ```bash
   ssh <utente_nas>@<IP_DEL_NAS>
   ```
4. **Avvia il container**:
   ```bash
   cd /volume1/docker/foliotrack-2
   docker compose up -d --build
   ```

---

## 🌐 Accesso all'Applicazione

Una volta avviato il container, apri il browser all'indirizzo:
```
http://<IP_DEL_NAS>:3000
```

---

## 🔄 Aggiornamenti Futuri

Se in futuro apporterai modifiche al codice sul Mac:
1. Copia i file aggiornati (ad eccezione della cartella `data/`, per non sovrascrivere il database in uso sul NAS).
2. Da UGOS Docker App: clicca sul progetto `foliotrack` > **Ricostruisci/Riavvia**.
   *(Oppure via SSH: `docker compose up -d --build`)*.
