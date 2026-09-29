#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# FolioTrack - Script di aggiornamento per NAS UGREEN (UGOS)
# Autentica Docker con ghcr.io usando un Personal Access Token GitHub,
# scarica l'ultima immagine pre-compilata e riavvia il container.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="ghcr.io/celtix72/foliotrack:latest"
ENV_FILE="$SCRIPT_DIR/.env"

echo "══════════════════════════════════════════════════════════════"
echo "  FolioTrack NAS Update Script"
echo "  Avvio: $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════════════════"

# ─── Legge le credenziali dal .env ─────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ File .env non trovato in $SCRIPT_DIR"
    echo "   Crea il file .env con GITHUB_USERNAME e GHCR_TOKEN."
    echo "   Vedi .env.example per il formato."
    exit 1
fi

# Carica solo le variabili rilevanti (evita di eseguire codice shell nel .env)
GITHUB_USERNAME=$(grep '^GITHUB_USERNAME=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]"'"'" 2>/dev/null || true)
GHCR_TOKEN=$(grep '^GHCR_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]"'"'" 2>/dev/null || true)

if [ -z "$GITHUB_USERNAME" ] || [ -z "$GHCR_TOKEN" ] || [ "$GHCR_TOKEN" = "your_github_personal_access_token_here" ]; then
    echo "❌ Credenziali ghcr.io mancanti o non configurate nel file .env"
    echo ""
    echo "   Aggiungi queste righe al file .env:"
    echo "     GITHUB_USERNAME=celtix72"
    echo "     GHCR_TOKEN=<il_tuo_token>"
    echo ""
    echo "   Genera il token su: https://github.com/settings/tokens"
    echo "   Scope necessari: read:packages"
    exit 1
fi

# Determina il comando docker compose
if docker compose version >/dev/null 2>&1; then
    DOCKER_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_CMD="docker-compose"
else
    echo "❌ Errore: 'docker compose' non trovato!"
    exit 1
fi

# ─── 0. Aggiornamento file di configurazione da Git (se repository presente) ──
if [ -d "$SCRIPT_DIR/.git" ]; then
    echo "📥 Aggiornamento file di configurazione da Git..."
    git pull origin main || true
fi

# ─── 1. Login su ghcr.io ───────────────────────────────────────────────────
echo "🔑 Autenticazione su GitHub Container Registry (ghcr.io)..."
if echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin; then
    echo "✅ Login riuscito come $GITHUB_USERNAME"
else
    echo "❌ Login fallito. Verifica GITHUB_USERNAME e GHCR_TOKEN nel file .env"
    exit 1
fi

# ─── 2. Scarica l'ultima immagine da ghcr.io ───────────────────────────────
echo "⬇️  Download nuova immagine: $IMAGE"
if docker pull "$IMAGE"; then
    echo "✅ Immagine aggiornata con successo"
else
    echo "❌ Errore durante il download. Verifica che il token abbia scope 'read:packages'."
    docker logout ghcr.io
    exit 1
fi

# ─── 3. Riavvia il container con la nuova immagine ─────────────────────────
echo "🔄 Riavvio container con la nuova immagine..."
$DOCKER_CMD down || true
$DOCKER_CMD up -d

# ─── 4. Logout per sicurezza ──────────────────────────────────────────────
docker logout ghcr.io >/dev/null 2>&1 || true

# ─── 5. Health check ───────────────────────────────────────────────────────
echo "⏳ Attesa avvio servizio (5 secondi)..."
sleep 5

STATUS=$($DOCKER_CMD ps --format "{{.Status}}" 2>/dev/null || true)
if [ -n "$STATUS" ]; then
    echo "✅ Container attivo: $STATUS"
else
    echo "⚠️  Container non ancora avviato. Verifica con:"
    echo "   $DOCKER_CMD logs --tail 30 foliotrack"
fi

echo "══════════════════════════════════════════════════════════════"
echo "  🎉 Aggiornamento completato alle $(date '+%H:%M:%S')!"
echo "══════════════════════════════════════════════════════════════"
