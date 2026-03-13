#!/bin/bash

# ==============================================================================
# Script di Aggiornamento FolioTrack
# ==============================================================================
# Questo script automatizza il processo di aggiornamento del progetto:
# 1. Controlla la presenza di modifiche nel repository remoto.
# 2. Scarica le modifiche se presenti (git pull).
# 3. Installa le nuove dipendenze (npm install).
# 4. Riavvia il server tramite PM2.
# ==============================================================================

# Impostazioni nomi e percorsi
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="foliotrack" # Nome del processo definito in PM2
BRANCH="main"

echo "----------------------------------------------------"
echo "Inizio controllo aggiornamenti per FolioTrack..."
echo "Directory: $PROJECT_DIR"
echo "----------------------------------------------------"

cd "$PROJECT_DIR" || { echo "Errore: directory non trovata"; exit 1; }

# Recupera lo stato dal repository remoto
echo "Sincronizzazione con il repository..."
git fetch origin "$BRANCH"

# Verifica se ci sono differenze tra locale e remoto
UPSTREAM=${1:-'@{u}'}
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse "$UPSTREAM")
BASE=$(git rev-parse @{u})

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Il progetto è già aggiornato all'ultima versione."
elif [ "$LOCAL" = "$BASE" ]; then
    echo "Trovate nuove modifiche! Inizio aggiornamento..."
    
    # Esegue il pull delle modifiche
    git pull origin "$BRANCH"
    
    # Ricostruisce l'immagine e riavvia i container
    echo "Ricostruzione immagine Docker e riavvio container..."
    docker compose up -d --build
    
    echo "----------------------------------------------------"
    echo "Aggiornamento completato con successo!"
    echo "----------------------------------------------------"
else
    echo "ATTENZIONE: Il branch locale è divergente dal remoto."
    echo "Esegui un 'git reset' o un 'git stash' manualmente."
fi
