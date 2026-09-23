#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# FolioTrack - Script di aggiornamento per NAS UGREEN (UGOS)
# Scarica l'ultima immagine pre-compilata da GitHub Container Registry (ghcr.io)
# e riavvia il container. NON ricompila il codice localmente.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="ghcr.io/celtix72/foliotrack:latest"

echo "══════════════════════════════════════════════════════════════"
echo "  FolioTrack NAS Update Script"
echo "  Avvio: $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════════════════"

# Determina il comando docker compose
if docker compose version >/dev/null 2>&1; then
    DOCKER_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_CMD="docker-compose"
else
    echo "❌ Errore: 'docker compose' non trovato!"
    exit 1
fi

# 1. Scarica l'ultima versione dell'immagine da ghcr.io
echo "⬇️  Download nuova immagine da GitHub..."
if docker pull "$IMAGE"; then
    echo "✅ Immagine aggiornata: $IMAGE"
else
    echo "❌ Errore durante il download dell'immagine. Verificare connessione internet."
    exit 1
fi

# 2. Ferma e ricrea il container con la nuova immagine
echo "🔄 Riavvio container con la nuova immagine..."
$DOCKER_CMD down || true
$DOCKER_CMD up -d

# 3. Attendi e verifica lo stato
echo "⏳ Attesa avvio servizio (5 secondi)..."
sleep 5

STATUS=$($DOCKER_CMD ps --format "{{.Status}}" 2>/dev/null || true)
if [ -n "$STATUS" ]; then
    echo "✅ Container attivo: $STATUS"
else
    echo "⚠️  Container potrebbe non essere ancora avviato."
    echo "   Controlla con: $DOCKER_CMD logs --tail 30 foliotrack"
fi

echo "══════════════════════════════════════════════════════════════"
echo "  🎉 Aggiornamento completato alle $(date '+%H:%M:%S')!"
echo "══════════════════════════════════════════════════════════════"
