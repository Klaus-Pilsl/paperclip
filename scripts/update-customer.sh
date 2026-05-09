#!/usr/bin/env bash
# Paperclip Customer Update — pulls the latest addons-Branch, rebuildet und
# startet den Container neu. Die Daten im Volume bleiben erhalten.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/update-customer.sh | bash
#
# Oder direkt aus dem Install-Verzeichnis:
#   ~/paperclip/scripts/update-customer.sh

set -euo pipefail

INSTALL_DIR="${PAPERCLIP_INSTALL_DIR:-$HOME/paperclip}"
BRANCH="${PAPERCLIP_BRANCH:-addons}"
COMPOSE_FILE="docker/docker-compose.customer.yml"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "1;34" "==> $*"; }
ok()    { color "1;32" "[OK] $*"; }
fail()  { color "1;31" "[X]  $*"; exit 1; }

[ -d "$INSTALL_DIR/.git" ] || fail "Keine Paperclip-Installation unter $INSTALL_DIR. Erst install-customer.sh ausfuehren."
[ -f "$INSTALL_DIR/.env" ] || fail "$INSTALL_DIR/.env fehlt. Bitte install-customer.sh erneut ausfuehren."

cd "$INSTALL_DIR"

SUDO=""
docker info >/dev/null 2>&1 || SUDO="sudo"

info "Hole neueste Aenderungen vom $BRANCH-Branch ..."
git fetch origin
git checkout "$BRANCH"

if ! git pull --ff-only origin "$BRANCH"; then
  fail "git pull schlug fehl (lokale Aenderungen?). Bitte manuell prüfen: git status"
fi

info "Baue Image neu und starte Container ..."
$SUDO docker compose -f "$COMPOSE_FILE" --env-file .env up -d --build

ok "Update abgeschlossen."
PUBLIC_URL="$(grep -E '^PAPERCLIP_PUBLIC_URL=' .env | cut -d= -f2-)"
color "1;36" "UI:    $PUBLIC_URL"
color "1;36" "Logs:  $SUDO docker compose -f $COMPOSE_FILE logs -f paperclip"
