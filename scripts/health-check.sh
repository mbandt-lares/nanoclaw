#!/bin/bash
# Health check for NanoClaw — service, DB, Telegram heartbeat, crash detection
# Runs every 5 minutes via cron (root user)
# Sends alerts to #lares-builds Slack channel

set -euo pipefail

NANOCLAW_DIR="/home/nanoclaw/nanoclaw"
ENV_FILE="$NANOCLAW_DIR/.env"
DB_FILE="$NANOCLAW_DIR/store/messages.db"
LOG_DIR="$NANOCLAW_DIR/logs"
HEARTBEAT_LOG="$LOG_DIR/heartbeat.log"
STATE_DIR="/tmp/nanoclaw-health"

mkdir -p "$STATE_DIR" "$LOG_DIR"

SLACK_TOKEN=$(grep SLACK_BOT_TOKEN "$ENV_FILE" | cut -d= -f2)
TG_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$ENV_FILE" | cut -d= -f2)
CHANNEL="C0AKG32DGJZ"

NOW=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$NOW] $1" >> "$HEARTBEAT_LOG"
}

alert() {
    log "ALERT: $1"
    curl -s -X POST "https://slack.com/api/chat.postMessage" \
        -H "Authorization: Bearer $SLACK_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"channel\":\"$CHANNEL\",\"text\":\":warning: *Health Check Alert*: $1\"}" > /dev/null 2>&1 || true
}

alert_critical() {
    log "CRITICAL: $1"
    curl -s -X POST "https://slack.com/api/chat.postMessage" \
        -H "Authorization: Bearer $SLACK_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"channel\":\"$CHANNEL\",\"text\":\":rotating_light: *CRITICAL*: $1\"}" > /dev/null 2>&1 || true
}

# ── Check 1: NanoClaw service running ──────────────────────────────────────
COOLDOWN_FILE="$STATE_DIR/service-alert-cooldown"
if ! systemctl is-active --quiet nanoclaw; then
    log "NanoClaw service is down"
    # Only alert once per hour to avoid flooding Slack
    if [ -f "$COOLDOWN_FILE" ] && [ "$(( $(date +%s) - $(stat -c %Y "$COOLDOWN_FILE") ))" -lt 3600 ]; then
        exit 1
    fi
    alert "NanoClaw service is down. Attempting restart..."
    systemctl restart nanoclaw
    sleep 5
    if systemctl is-active --quiet nanoclaw; then
        alert "NanoClaw restarted successfully."
        rm -f "$COOLDOWN_FILE"
    else
        alert_critical "NanoClaw restart FAILED. Manual intervention needed."
        touch "$COOLDOWN_FILE"
    fi
    exit 1
fi
rm -f "$COOLDOWN_FILE"

# ── Check 2: DB accessible and not corrupted ──────────────────────────────
INTEGRITY=$(sqlite3 "$DB_FILE" "PRAGMA quick_check;" 2>&1)
if [ "$INTEGRITY" != "ok" ]; then
    alert "SQLite database integrity check failed: $INTEGRITY"
    exit 1
fi

# ── Check 3: Process not stuck ────────────────────────────────────────────
MAIN_PID=$(systemctl show nanoclaw --property=MainPID --value)
if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
    if ! kill -0 "$MAIN_PID" 2>/dev/null; then
        alert "NanoClaw main process ($MAIN_PID) is not responsive."
        exit 1
    fi
fi

# ── Check 4: Crash loop detection ────────────────────────────────────────
ERROR_COUNT=$(journalctl -u nanoclaw --since "10 minutes ago" --no-pager 2>/dev/null | grep -c "Max retries exceeded" || true)
if [ "$ERROR_COUNT" -gt 0 ]; then
    alert "Agent hit max retries $ERROR_COUNT time(s) in last 10 minutes. Messages may be dropping."
fi

# ── Check 5: Telegram bot heartbeat ──────────────────────────────────────
# Probe the Telegram Bot API directly to verify the bot token is valid
# and the bot process hasn't silently died inside the NanoClaw service.
TG_DEATH_COUNTER="$STATE_DIR/tg-death-count"
TG_COOLDOWN="$STATE_DIR/tg-alert-cooldown"
TG_RESTART_LOG="$STATE_DIR/tg-restart-times"

if [ -n "$TG_TOKEN" ]; then
    # Call getMe — lightweight API probe, returns bot info if token works
    TG_RESPONSE=$(curl -s --max-time 10 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>&1)
    TG_OK=$(echo "$TG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")

    # Also check if "Telegram bot connected" appears in log AFTER last service start
    # This catches the case where the token is valid but the polling loop died inside Node.js
    SERVICE_START=$(systemctl show nanoclaw --property=ActiveEnterTimestamp --value 2>/dev/null || echo "")
    TG_CONNECTED_AFTER_START=true
    if [ -n "$SERVICE_START" ]; then
        START_EPOCH=$(date -d "$SERVICE_START" +%s 2>/dev/null || echo "0")
        LAST_CONNECTED=$(grep "Telegram bot connected" "$LOG_DIR/nanoclaw.log" 2>/dev/null | tail -1 || true)
        if [ -z "$LAST_CONNECTED" ]; then
            TG_CONNECTED_AFTER_START=false
        fi
    fi

    TG_FAILED=false
    FAIL_REASON=""

    if [ "$TG_OK" != "True" ]; then
        TG_FAILED=true
        FAIL_REASON="API probe failed: $TG_RESPONSE"
    elif [ "$TG_CONNECTED_AFTER_START" = "false" ]; then
        TG_FAILED=true
        FAIL_REASON="Bot token valid but no 'Telegram bot connected' log found since service start"
    fi

    if [ "$TG_FAILED" = "true" ]; then
        log "Telegram check FAILED: $FAIL_REASON"

        # Increment death counter
        DEATHS=0
        [ -f "$TG_DEATH_COUNTER" ] && DEATHS=$(cat "$TG_DEATH_COUNTER")
        DEATHS=$((DEATHS + 1))
        echo "$DEATHS" > "$TG_DEATH_COUNTER"

        # Record restart time
        echo "$NOW" >> "$TG_RESTART_LOG"

        # Keep restart log trimmed to last 50 entries
        if [ -f "$TG_RESTART_LOG" ] && [ "$(wc -l < "$TG_RESTART_LOG")" -gt 50 ]; then
            tail -50 "$TG_RESTART_LOG" > "$TG_RESTART_LOG.tmp" && mv "$TG_RESTART_LOG.tmp" "$TG_RESTART_LOG"
        fi

        if [ "$DEATHS" -ge 3 ]; then
            # 3+ failures in a row = critical, something is fundamentally wrong
            if [ ! -f "$TG_COOLDOWN" ] || [ "$(( $(date +%s) - $(stat -c %Y "$TG_COOLDOWN") ))" -ge 3600 ]; then
                alert_critical "Telegram Lares has died $DEATHS times. Restarting NanoClaw service. $FAIL_REASON"
                touch "$TG_COOLDOWN"
            fi
        else
            alert "Telegram Lares bot is not responding (attempt $DEATHS). Restarting NanoClaw... $FAIL_REASON"
        fi

        # Restart the entire NanoClaw service (Telegram runs inside it)
        systemctl restart nanoclaw
        sleep 5
        if systemctl is-active --quiet nanoclaw; then
            log "NanoClaw restarted for Telegram recovery"
        else
            alert_critical "NanoClaw restart FAILED during Telegram recovery."
        fi
    else
        # Telegram is fully healthy
        # Reset death counter on success
        if [ -f "$TG_DEATH_COUNTER" ]; then
            PREV_DEATHS=$(cat "$TG_DEATH_COUNTER")
            if [ "$PREV_DEATHS" -gt "0" ] 2>/dev/null; then
                log "Telegram recovered after $PREV_DEATHS failure(s)"
                alert "Telegram Lares recovered and is online. (was down for $PREV_DEATHS check(s))"
            fi
        fi
        echo "0" > "$TG_DEATH_COUNTER"
        rm -f "$TG_COOLDOWN"
        log "Telegram heartbeat OK"
    fi
else
    log "TELEGRAM_BOT_TOKEN not configured, skipping Telegram heartbeat"
fi

# ── Check 6: Docker host reachable ────────────────────────────────────────
# Docker unreachable is the #1 cause of NanoClaw death (blocks ExecStartPre)
DOCKER_COOLDOWN="$STATE_DIR/docker-alert-cooldown"
if ! DOCKER_HOST=tcp://10.31.220.1:2375 docker info >/dev/null 2>&1; then
    log "Docker host unreachable"
    if [ ! -f "$DOCKER_COOLDOWN" ] || [ "$(( $(date +%s) - $(stat -c %Y "$DOCKER_COOLDOWN") ))" -ge 3600 ]; then
        alert "Docker host (10.31.220.1:2375) is unreachable. Agent containers cannot spawn. NanoClaw will crash-loop on restart."
        touch "$DOCKER_COOLDOWN"
    fi
else
    rm -f "$DOCKER_COOLDOWN"
fi

log "Health check complete"
