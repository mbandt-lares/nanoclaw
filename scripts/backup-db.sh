#!/bin/bash
# Daily SQLite backup with integrity check
# Keeps last 7 days of backups

DB="/root/nanoclaw/store/messages.db"
BACKUP_DIR="/root/nanoclaw/backups"
DATE=$(date +%Y-%m-%d)

# Use SQLite's online backup API (safe even while DB is in use)
sqlite3 "$DB" ".backup '${BACKUP_DIR}/messages-${DATE}.db'"

# Verify the backup
INTEGRITY=$(sqlite3 "${BACKUP_DIR}/messages-${DATE}.db" "PRAGMA integrity_check;" 2>&1)
if [ "$INTEGRITY" != "ok" ]; then
    echo "WARNING: Backup integrity check failed: $INTEGRITY" >&2
    exit 1
fi

# Remove backups older than 7 days
find "$BACKUP_DIR" -name "messages-*.db" -mtime +7 -delete

echo "Backup complete: messages-${DATE}.db (integrity: ok)"
