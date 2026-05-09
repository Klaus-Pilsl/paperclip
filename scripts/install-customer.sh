#!/usr/bin/env bash
# Paperclip Customer Bootstrap — installs Docker, clones the addons branch,
# generates secrets, builds and starts the container.
#
# Usage (one-liner from anywhere):
#   curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.sh | bash
#
# Override defaults via env vars:
#   PAPERCLIP_INSTALL_DIR=/opt/paperclip
#   PAPERCLIP_PUBLIC_URL=http://my-host:3100
#   PAPERCLIP_PORT=3200
#   PAPERCLIP_BRANCH=addons

set -euo pipefail

REPO_URL="${PAPERCLIP_REPO_URL:-https://github.com/Klaus-Pilsl/paperclip.git}"
BRANCH="${PAPERCLIP_BRANCH:-addons}"
INSTALL_DIR="${PAPERCLIP_INSTALL_DIR:-$HOME/paperclip}"
PORT="${PAPERCLIP_PORT:-3100}"
COMPOSE_FILE="docker/docker-compose.customer.yml"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info()  { color "1;34" "==> $*"; }
ok()    { color "1;32" "[OK] $*"; }
warn()  { color "1;33" "[!]  $*"; }
fail()  { color "1;31" "[X]  $*"; exit 1; }

# ---------- 1. OS-Erkennung ---------------------------------------------------

OS="$(uname -s)"
case "$OS" in
  Linux)             PLATFORM="linux"  ;;
  Darwin)            PLATFORM="macos"  ;;
  MINGW*|MSYS*|CYGWIN*)
    fail "Du fuehrst dieses Skript in Git-Bash/MSYS aus. Auf Windows bitte das PowerShell-Skript verwenden:

    iwr -useb https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.ps1 | iex

  Alternativ in einer WSL2-Ubuntu-Shell den urspruenglichen curl|bash-Befehl ausfuehren." ;;
  *)                 fail "Unsupported OS: $OS. Unterstuetzt werden Linux, macOS (Bash) und Windows (PowerShell-Skript)." ;;
esac
info "Platform: $PLATFORM"

# ---------- 2. Basistools sicherstellen --------------------------------------

ensure_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Tool '$1' fehlt. Bitte installieren und Skript erneut starten."
}

ensure_or_install_linux() {
  local cmd="$1" pkg="${2:-$1}"
  if command -v "$cmd" >/dev/null 2>&1; then return; fi
  info "Installiere $pkg ..."
  if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update -y && sudo apt-get install -y "$pkg"
  elif command -v dnf     >/dev/null 2>&1; then sudo dnf install -y "$pkg"
  elif command -v yum     >/dev/null 2>&1; then sudo yum install -y "$pkg"
  elif command -v pacman  >/dev/null 2>&1; then sudo pacman -Sy --noconfirm "$pkg"
  else fail "Kein bekannter Paketmanager gefunden. Bitte '$pkg' manuell installieren."
  fi
}

if [ "$PLATFORM" = "linux" ]; then
  ensure_or_install_linux curl
  ensure_or_install_linux git
  ensure_or_install_linux openssl
else
  ensure_cmd curl
  ensure_cmd git
  ensure_cmd openssl
fi

# ---------- 3. Docker installieren -------------------------------------------

if command -v docker >/dev/null 2>&1; then
  ok "Docker ist bereits installiert ($(docker --version))"
else
  if [ "$PLATFORM" = "macos" ]; then
    fail "Docker Desktop ist nicht installiert. Bitte herunterladen und einmalig installieren: https://www.docker.com/products/docker-desktop/  Danach dieses Skript erneut ausfuehren."
  fi
  info "Installiere Docker via get.docker.com ..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker || true
  if id -nG "$USER" | grep -qw docker; then :; else
    info "Fuege Benutzer '$USER' zur 'docker'-Gruppe hinzu (wirksam nach Re-Login)"
    sudo usermod -aG docker "$USER" || true
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose v2 fehlt. Bitte 'docker-compose-plugin' installieren oder Docker neu installieren."
fi

# Prefix bestimmen: in dieser Shell-Session ist der Benutzer ggf. noch nicht in
# der 'docker'-Gruppe — dann brauchen wir 'sudo' fuer Docker-Aufrufe.
SUDO=""
if ! docker info >/dev/null 2>&1; then
  SUDO="sudo"
fi

# ---------- 4. Repo holen / aktualisieren ------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Repo existiert bereits unter $INSTALL_DIR — aktualisiere ..."
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  info "Klone Paperclip ($BRANCH) nach $INSTALL_DIR ..."
  git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ---------- 5. .env vorbereiten ----------------------------------------------

detect_lan_ip() {
  local ip=""
  if [ "$PLATFORM" = "macos" ]; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  else
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -z "$ip" ]; then
      ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i=1;i<=NF;i++) if ($i=="src") print $(i+1); exit}')"
    fi
  fi
  [ -n "$ip" ] && echo "$ip" || echo "localhost"
}

if [ -f .env ]; then
  ok ".env existiert bereits — werte werden nicht ueberschrieben"
else
  info "Erzeuge .env"
  cp docker/.env.customer.example .env
  SECRET="$(openssl rand -hex 32)"
  PUBLIC_URL_DEFAULT="http://$(detect_lan_ip):${PORT}"
  PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-$PUBLIC_URL_DEFAULT}"

  # POSIX-portable in-place edit (works on Linux + macOS)
  python3 - "$SECRET" "$PUBLIC_URL" "$PORT" <<'PY' || sed_fallback=1
import os, sys, re
secret, public_url, port = sys.argv[1], sys.argv[2], sys.argv[3]
with open(".env", "r", encoding="utf-8") as f: text = f.read()
text = re.sub(r"^BETTER_AUTH_SECRET=.*$",   f"BETTER_AUTH_SECRET={secret}",     text, flags=re.M)
text = re.sub(r"^PAPERCLIP_PUBLIC_URL=.*$", f"PAPERCLIP_PUBLIC_URL={public_url}", text, flags=re.M)
text = re.sub(r"^PAPERCLIP_PORT=.*$",       f"PAPERCLIP_PORT={port}",           text, flags=re.M)
with open(".env", "w", encoding="utf-8") as f: f.write(text)
PY
  if [ "${sed_fallback:-0}" = "1" ]; then
    # Fallback ohne python3 — re-create from scratch
    cat > .env <<EOF
BETTER_AUTH_SECRET=$SECRET
PAPERCLIP_PUBLIC_URL=$PUBLIC_URL
PAPERCLIP_PORT=$PORT
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
EOF
  fi
  chmod 600 .env
  ok ".env erstellt — PAPERCLIP_PUBLIC_URL=$PUBLIC_URL"
fi

# ---------- 6. Build & Start -------------------------------------------------

info "Baue Image und starte Container (das dauert beim Erststart 5-10 Minuten)"
$SUDO docker compose -f "$COMPOSE_FILE" --env-file .env up -d --build

# ---------- 7. Erststart-Hinweise --------------------------------------------

PUBLIC_URL_FROM_ENV="$(grep -E '^PAPERCLIP_PUBLIC_URL=' .env | cut -d= -f2-)"

echo
ok "Paperclip laeuft."
echo
color "1;36" "UI:               $PUBLIC_URL_FROM_ENV"
color "1;36" "Logs:             $SUDO docker compose -f $COMPOSE_FILE logs -f paperclip"
color "1;36" "Stoppen:          $SUDO docker compose -f $COMPOSE_FILE stop"
color "1;36" "Starten:          $SUDO docker compose -f $COMPOSE_FILE start"
color "1;36" "Update einspielen: $INSTALL_DIR/scripts/update-customer.sh"
echo
warn "Bootstrap-Invite-Link beim Erststart:"
echo "    $SUDO docker compose -f $COMPOSE_FILE logs paperclip | grep -i invite"
echo "    (Link im Browser oeffnen, Account anlegen — wird Board-Admin.)"
echo
if [ -n "$SUDO" ]; then
  warn "Damit du Docker zukuenftig ohne 'sudo' nutzen kannst: einmal aus- und wieder einloggen (oder 'newgrp docker' ausfuehren)."
fi
