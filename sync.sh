#!/bin/bash

# FolioTracker Bidirectional Sync Script
# This script pulls the latest changes from GitHub and pushes any local changes.

echo "--- Starting Sync at $(date) ---"

# 1. Stash local changes if any exist
HAS_CHANGES=false
if [[ -n $(git status -s) ]]; then
    HAS_CHANGES=true
    echo "📦 Temporarily stashing local changes..."
    git stash -u
fi

# 2. Pull latest changes from GitHub
echo "📥 Checking for remote updates..."
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    git pull --rebase origin main
    PULL_STATUS=$?
else
    echo "ℹ️ Remote branch 'main' does not exist yet on remote. Skipping pull..."
    PULL_STATUS=0
fi

# Restore local changes if they were stashed
if [ $HAS_CHANGES = true ]; then
    echo "🔓 Restoring local changes..."
    git stash pop
    POP_STATUS=$?
    if [ $POP_STATUS -ne 0 ]; then
        echo "⚠️ Conflict detected while restoring local changes. Please resolve manually."
        exit 1
    fi
fi

if [ $PULL_STATUS -ne 0 ]; then
    echo "❌ Error pulling remote changes."
    exit 1
fi

# 3. Commit and push local changes
if [[ -n $(git status -s) ]]; then
    echo "📝 Local changes detected."
    
    # Use the first argument as commit message, or default to generic message
    COMMIT_MSG="$1"
    if [ -z "$COMMIT_MSG" ]; then
        COMMIT_MSG="Aggiornamento automatico locale - $(date '+%Y-%m-%d %H:%M:%S')"
    fi
    
    NOW_DATE=$(date '+%d/%m/%y %H:%M')
    NOW_TS=$(date +%s)
    cat <<EOF > build_info.json
{
  "lastModified": "$NOW_DATE",
  "commit": "HEAD",
  "timestamp": ${NOW_TS}000
}
EOF
    echo "📝 File build_info.json aggiornato con data: $NOW_DATE"
    
    echo "💾 Staging and committing changes with message: \"$COMMIT_MSG\""
    git add -A
    git commit -m "$COMMIT_MSG"
    
    # Push to GitHub
    echo "📤 Pushing changes to GitHub..."
    git push -u origin main
    
    if [ $? -eq 0 ]; then
        echo "✅ Changes successfully pushed to GitHub!"
    else
        echo "❌ Failed to push changes to GitHub."
        exit 1
    fi
else
    echo "✅ No local changes to commit."
fi

echo "--- Sync Finished ---"
