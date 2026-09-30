#!/usr/bin/env bash
# Rotating local backup of the inventory database and uploaded photos.
# Meant to run on a schedule (see README "Automated local backups") — keeps the last
# $RETENTION_DAYS daily snapshots under $DATA_DIR/backups and prunes older ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${DATA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BACKUP_DIR="$DATA_DIR/backups"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

DB_FILE="$DATA_DIR/data/db.json"
UPLOADS_DIR="$DATA_DIR/uploads"

if [ ! -f "$DB_FILE" ]; then
  echo "backup.sh: no db.json found at $DB_FILE, nothing to back up" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
DEST="$BACKUP_DIR/$STAMP.tar.gz"

TAR_ARGS=(-czf "$DEST" -C "$DATA_DIR" "data/db.json")
[ -d "$UPLOADS_DIR" ] && TAR_ARGS+=("uploads")
tar "${TAR_ARGS[@]}"

echo "backup.sh: wrote $DEST"

# prune anything older than the retention window
find "$BACKUP_DIR" -maxdepth 1 -name '*.tar.gz' -mtime "+$RETENTION_DAYS" -print -delete
