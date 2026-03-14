#!/bin/bash

# FolioTracker Auto-Update Script
# This script checks for remote changes, pulls them, updates dependencies, and restarts the app.

echo "--- Starting Update Check at $(date) ---"

# 1. Fetch latest changes from remote
git fetch origin

# 2. Compare local branch with remote
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})
BASE=$(git merge-base @ @{u})

if [ $LOCAL = $REMOTE ]; then
    echo "✅ Application is already up to date."
elif [ $LOCAL = $BASE ]; then
    echo "🚀 New updates found! Pulling changes..."
    
    # 3. Pull changes
    git pull
    
    # 4. Update dependencies
    echo "📦 Updating dependencies..."
    npm install
    
    # 5. Restart the application
    echo "🔄 Restarting FolioTracker server..."
    # Kill any running instance of the server
    pkill -f "node src/server.js" || true
    
    # Start the server in background
    nohup npm start > server.log 2>&1 &
    
    echo "✅ Update complete and server restarted."
else
    echo "⚠️ Local and remote branches have diverged. Manual intervention required."
fi

echo "--- Update Check Finished ---"
