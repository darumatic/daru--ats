#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
	echo "Run this installer as root."
	exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
UNIT_NAME="${BACKUP_SYSTEMD_NAME:-hire-gnome-db-backup}"
ON_CALENDAR="${BACKUP_ON_CALENDAR:-*-*-* 02:15:00}"
RANDOMIZED_DELAY_SEC="${BACKUP_RANDOMIZED_DELAY_SEC:-0}"
APP_USER="${BACKUP_RUN_USER:-$(stat -c '%U' "$PROJECT_ROOT")}"
APP_GROUP="${BACKUP_RUN_GROUP:-$(stat -c '%G' "$PROJECT_ROOT")}"
HOME_DIR="${BACKUP_RUN_HOME:-$(getent passwd "$APP_USER" | cut -d: -f6 || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
PATH_VALUE="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
SERVICE_TEMPLATE="$PROJECT_ROOT/ops/systemd/hire-gnome-db-backup.service.template"
TIMER_TEMPLATE="$PROJECT_ROOT/ops/systemd/hire-gnome-db-backup.timer.template"

if [ ! -f "$SERVICE_TEMPLATE" ] || [ ! -f "$TIMER_TEMPLATE" ]; then
	echo "Missing systemd template files under $PROJECT_ROOT/ops/systemd."
	exit 1
fi

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
	echo "Could not find package.json in $PROJECT_ROOT."
	exit 1
fi

if [ -z "$NPM_BIN" ]; then
	echo "npm was not found in PATH."
	exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
	echo "Backup user $APP_USER does not exist."
	exit 1
fi

if [ -z "$HOME_DIR" ]; then
	HOME_DIR="$PROJECT_ROOT"
fi

escape_sed() {
	printf '%s' "$1" | sed -e 's/[\\/&]/\\&/g'
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SERVICE_PATH="$SYSTEMD_DIR/$UNIT_NAME.service"
TIMER_PATH="$SYSTEMD_DIR/$UNIT_NAME.timer"
RENDERED_SERVICE="$TMP_DIR/$UNIT_NAME.service"
RENDERED_TIMER="$TMP_DIR/$UNIT_NAME.timer"

sed \
	-e "s/__APP_USER__/$(escape_sed "$APP_USER")/g" \
	-e "s/__APP_GROUP__/$(escape_sed "$APP_GROUP")/g" \
	-e "s/__PROJECT_ROOT__/$(escape_sed "$PROJECT_ROOT")/g" \
	-e "s/__HOME_DIR__/$(escape_sed "$HOME_DIR")/g" \
	-e "s/__PATH_VALUE__/$(escape_sed "$PATH_VALUE")/g" \
	-e "s/__NPM_BIN__/$(escape_sed "$NPM_BIN")/g" \
	"$SERVICE_TEMPLATE" > "$RENDERED_SERVICE"

sed \
	-e "s/__ON_CALENDAR__/$(escape_sed "$ON_CALENDAR")/g" \
	-e "s/__RANDOMIZED_DELAY_SEC__/$(escape_sed "$RANDOMIZED_DELAY_SEC")/g" \
	-e "s/__UNIT_NAME__/$(escape_sed "$UNIT_NAME")/g" \
	"$TIMER_TEMPLATE" > "$RENDERED_TIMER"

install -m 0644 "$RENDERED_SERVICE" "$SERVICE_PATH"
install -m 0644 "$RENDERED_TIMER" "$TIMER_PATH"

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME.timer"

echo "Installed $SERVICE_PATH"
echo "Installed $TIMER_PATH"
echo "Timer status:"
systemctl --no-pager --full status "$UNIT_NAME.timer"

