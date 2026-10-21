#!/usr/bin/env bash
# Pulls new commits from origin/main and restarts the service if anything changed.
# Meant to run on a schedule via cron (see README "Automatic deployment") — safe to run
# often, it's a no-op whenever the Pi is already up to date.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-inventory-app}"

cd "$REPO_DIR"

BEFORE="$(git rev-parse HEAD)"
git fetch origin main --quiet
AFTER="$(git rev-parse origin/main)"

if [ "$BEFORE" = "$AFTER" ]; then
  exit 0
fi

echo "auto-deploy.sh: $BEFORE -> $AFTER"
git merge --ff-only origin/main
npm install --omit=dev --quiet
sudo systemctl restart "$SERVICE_NAME"
echo "auto-deploy.sh: restarted $SERVICE_NAME"
