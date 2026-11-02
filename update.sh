#!/bin/bash

# FolioTracker Auto-Update Script (Docker version)
# Robust deployment & update script with error handling, git diagnostics, and auto-healing.

set -o pipefail

# 1. Ensure working directory is always the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || {
    echo "❌ Errore fatale: impossibile accedere alla directory $SCRIPT_DIR"
    exit 1
}

FORCE_UPDATE=false
CHECK_ONLY=false

for arg in "$@"; do
    case "$arg" in
        --force|-f)
            FORCE_UPDATE=true
            ;;
        --check|-c)
            CHECK_ONLY=true
            ;;
        *)
            ;;
    esac
done

echo "══════════════════════════════════════════════════════════════"
echo "  FolioTracker Auto-Update Script"
echo "  Avvio: $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Directory: $SCRIPT_DIR"
echo "══════════════════════════════════════════════════════════════"

# 2. Check essential tools
if ! command -v git >/dev/null 2>&1; then
    echo "❌ Errore critico: git non è installato o non è presente nel PATH."
    exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "❌ Errore critico: $SCRIPT_DIR non è un repository Git valido."
    exit 1
fi

# 3. Clean up stale lock files if left over by crashed git processes
if [ -f ".git/index.lock" ]; then
    echo "⚠️ Rilevato file di lock .git/index.lock pendente. Rimozione per sbloccare git..."
    rm -f .git/index.lock
fi

# 4. Abort any hanging merge or rebase
if [ -f ".git/MERGE_HEAD" ]; then
    echo "⚠️ Rilevato merge non concluso (.git/MERGE_HEAD). Interruzione del merge pendente..."
    git merge --abort 2>/dev/null || true
fi
if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
    echo "⚠️ Rilevato rebase non concluso. Interruzione del rebase pendente..."
    git rebase --abort 2>/dev/null || true
fi

# 5. Detect current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$CURRENT_BRANCH" ] || [ "$CURRENT_BRANCH" = "HEAD" ]; then
    echo "⚠️ HEAD non associato a un branch (detached). Tentativo di passaggio al branch 'main'..."
    git checkout main 2>/dev/null || git checkout master 2>/dev/null || true
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
fi

echo "📌 Branch locale attivo: $CURRENT_BRANCH"

# Ensure upstream is set to origin/$CURRENT_BRANCH
git branch --set-upstream-to="origin/$CURRENT_BRANCH" "$CURRENT_BRANCH" >/dev/null 2>&1 || true

# 6. Fetch latest changes from remote with explicit error checking
echo "🔄 Connessione a GitHub e prelievo dati (git fetch origin $CURRENT_BRANCH)..."
FETCH_OUTPUT=$(git fetch origin "$CURRENT_BRANCH" 2>&1)
FETCH_STATUS=$?

if [ $FETCH_STATUS -ne 0 ]; then
    echo "❌ ERRORE: 'git fetch origin' è fallito (codice: $FETCH_STATUS)!"
    echo "--------------------------------------------------------------"
    echo "$FETCH_OUTPUT"
    echo "--------------------------------------------------------------"
    echo "Possibili cause:"
    echo "  - Mancanza di connettività Internet sul server"
    echo "  - Chiave SSH o Personal Access Token GitHub scaduto o errato"
    echo "  - Errore di risoluzione DNS (es. github.com non raggiungibile)"
    echo "L'aggiornamento è stato interrotto per evitare corruzione dello stato."
    exit 1
fi

# 7. Compare local commit with remote commit
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null)

if [ -z "$REMOTE" ]; then
    echo "❌ Errore: il branch remoto 'origin/$CURRENT_BRANCH' non è stato trovato."
    exit 1
fi

BASE=$(git merge-base HEAD "origin/$CURRENT_BRANCH" 2>/dev/null)

echo "📊 Stato Git:"
echo "   - Commit locale:  ${LOCAL:0:7} ($(git log -1 --format="%s" HEAD 2>/dev/null))"
echo "   - Commit remoto:  ${REMOTE:0:7} ($(git log -1 --format="%s" origin/$CURRENT_BRANCH 2>/dev/null))"

# Check-only mode
if [ "$CHECK_ONLY" = true ]; then
    if [ "$LOCAL" = "$REMOTE" ]; then
        echo "✅ L'applicazione è già aggiornata all'ultimo commit disponibile."
        exit 0
    else
        echo "🚀 Nuovi aggiornamenti disponibili su GitHub!"
        git log --oneline --color=never "$LOCAL..$REMOTE"
        exit 0
    fi
fi

SHOULD_REBUILD=false

if [ "$LOCAL" = "$REMOTE" ]; then
    if [ "$FORCE_UPDATE" = true ]; then
        echo "⚡ Commit identico, ma flag --force attivo. Esecuzione rebuild forzato..."
        SHOULD_REBUILD=true
    else
        echo "✅ L'applicazione è già aggiornata all'ultimo commit (${LOCAL:0:7}). Nessuna azione necessaria."
        echo "   (Usa './update.sh --force' se desideri forzare la ricostruzione dei container Docker)"
        exit 0
    fi
elif [ "$LOCAL" = "$BASE" ]; then
    echo "🚀 Nuovi aggiornamenti trovati su GitHub! Preparazione al download..."
    echo "📋 Commit da applicare:"
    git log --oneline --color=never "$LOCAL..$REMOTE"
    
    # Discard any local uncommitted changes to tracked files (e.g. build_info.json) to prevent "cannot pull with rebase: unstaged changes"
    echo "🧹 Pulizia file locali tracciati..."
    git reset --hard HEAD >/dev/null 2>&1 || true
    
    # Apply changes reliably using reset --hard to remote ref (already fetched)
    echo "📥 Applicazione modifiche da GitHub (origin/$CURRENT_BRANCH)..."
    if git reset --hard "origin/$CURRENT_BRANCH"; then
        echo "✅ File aggiornati scaricati e applicati con successo."
    else
        echo "❌ Errore critico durante l'aggiornamento. Intervento manuale richiesto."
        exit 1
    fi
    SHOULD_REBUILD=true
else
    echo "⚠️ ATTENZIONE: Il branch locale del server e quello remoto sono DIVERGENTI!"
    echo "   Commit locali presenti solo sul server:"
    git log --oneline "$BASE..$LOCAL" | sed 's/^/     /'
    echo "   Commit su GitHub non ancora applicati:"
    git log --oneline "$BASE..$REMOTE" | sed 's/^/     /'
    
    # Auto-healing for deployment server: save a backup ref and hard reset to remote
    BACKUP_BRANCH="backup-server-$(date +%Y%m%d_%H%M%S)"
    echo "🛡️ Creazione branch di backup di sicurezza: $BACKUP_BRANCH..."
    git branch "$BACKUP_BRANCH" 2>/dev/null || true
    
    echo "🔄 Allineamento forzato del server a 'origin/$CURRENT_BRANCH'..."
    git reset --hard "origin/$CURRENT_BRANCH"
    if [ $? -eq 0 ]; then
        echo "✅ Repository sincronizzato con successo a origin/$CURRENT_BRANCH."
        SHOULD_REBUILD=true
    else
        echo "❌ Errore critico durante il reset. Intervento manuale richiesto."
        exit 1
    fi
fi

# 8. Verify post-pull commit hash
NEW_COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null)
NEW_COMMIT_SHORT=${NEW_COMMIT_HASH:0:7}
echo "📍 Nuovo commit attivo sul server: $NEW_COMMIT_SHORT"

# 9. Update build_info.json with accurate git metadata
GIT_DATE=$(git log -1 --format="%cd" --date=format:"%d/%m/%y %H:%M" 2>/dev/null || date '+%d/%m/%y %H:%M')
GIT_COMMIT=$(git log -1 --format="%h" 2>/dev/null || echo "$NEW_COMMIT_SHORT")
GIT_TS=$(git log -1 --format="%ct" 2>/dev/null || date +%s)
cat <<EOF > build_info.json
{
  "lastModified": "$GIT_DATE",
  "commit": "$GIT_COMMIT",
  "timestamp": ${GIT_TS}000
}
EOF
echo "📝 File build_info.json aggiornato con data: $GIT_DATE (commit $GIT_COMMIT)"

# 10. Rebuild & restart Docker containers if needed
if [ "$SHOULD_REBUILD" = true ]; then
    # Determine docker command
    if docker compose version >/dev/null 2>&1; then
        DOCKER_CMD="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        DOCKER_CMD="docker-compose"
    else
        echo "❌ Errore: né 'docker compose' né 'docker-compose' sono installati!"
        exit 1
    fi
    
    echo "🐳 Riavvio dei container FolioTracker con '$DOCKER_CMD'..."
    
    $DOCKER_CMD down || true
    
    echo "🔨 Ricostruzione immagine e avvio container in background..."
    if ! $DOCKER_CMD up --build -d; then
        echo "❌ ERRORE durante il build o l'avvio dei container Docker!"
        exit 1
    fi
    
    # 11. Health-check: wait a few seconds and verify container is running
    echo "⏳ Attesa avvio del servizio (4 secondi)..."
    sleep 4
    
    CONTAINER_STATUS=$($DOCKER_CMD ps --format "{{.Status}}" 2>/dev/null || $DOCKER_CMD ps | grep -E "foliotrack.*Up" || true)
    if [ -n "$CONTAINER_STATUS" ]; then
        echo "✅ Container FolioTracker attivo e in esecuzione!"
        echo "   Dettagli stato: $CONTAINER_STATUS"
    else
        echo "⚠️ Avviso: Il container potrebbe non essere ancora completamente avviato."
        echo "   Controlla i log con: $DOCKER_CMD logs --tail 30 foliotrack-2"
    fi
    
    echo "══════════════════════════════════════════════════════════════"
    echo "  🎉 Aggiornamento completato con successo alle $(date '+%H:%M:%S')!"
    echo "  Versione codice applicata: $GIT_DATE [$GIT_COMMIT]"
    echo "══════════════════════════════════════════════════════════════"
fi

exit 0
