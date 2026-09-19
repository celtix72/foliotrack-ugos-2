# ==============================================================================
# FolioTrack - Dockerfile Ottimizzato per UGREEN NAS (UGOS 1.9+)
# ==============================================================================
FROM node:22-alpine

# Directory di lavoro
WORKDIR /app

# 1. dumb-init (gestione segnali di stop sicuri per SQLite) + libstdc++ a runtime
RUN apk add --no-cache dumb-init libstdc++

# 2. Copia i descrittori delle dipendenze per sfruttare la cache di Docker
COPY package*.json ./

# 3. Compilazione moduli C++ nativi (better-sqlite3) e pulizia immediata dei tool di build
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev \
    && apk del .build-deps \
    && rm -rf /root/.npm /tmp/*

# 4. Copia il resto dell'applicazione
COPY . .

# 5. Crea la cartella dati per il mount del volume
RUN mkdir -p /app/data/backups

# 6. Variabili d'ambiente di default
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/foliotrack.db \
    BACKUP_DIR=/app/data/backups

EXPOSE 3000

# dumb-init come PID 1 assicura che lo stop del container salvi e chiuda SQLite senza corruzione
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "src/server.js"]
