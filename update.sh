#!/bin/bash

# FolioTracker Auto-Update Script (Docker version)
# This script checks for remote changes, pulls them, and restarts the Docker containers.

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
    
    # 4. Determine docker command (docker compose vs docker-compose)
    if docker compose version >/dev/null 2>&1; then
        DOCKER_CMD="docker compose"
    else
        DOCKER_CMD="docker-compose"
    fi

    # 5. Restart the application using Docker
    echo "🔄 Restarting FolioTracker containers using $DOCKER_CMD..."
    
    $DOCKER_CMD down
    $DOCKER_CMD up --build -d
    
    echo "✅ Update complete and Docker containers restarted."
else
    echo "⚠️ Local and remote branches have diverged. Manual intervention required."
fi

echo "--- Update Check Finished ---"
