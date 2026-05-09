# Paperclip — Installation per Docker

Diese Anleitung zeigt, wie Paperclip als Docker-Container installiert wird.
Das Setup ist auf den Betrieb im **privaten Netz** (LAN, VPN oder Tailscale)
ausgelegt — Login erforderlich, kein oeffentliches HTTPS noetig.

Der Container intern laeuft auf Linux, das Host-Betriebssystem ist egal:
**Linux, macOS und Windows** werden unterstuetzt.

## Voraussetzungen je Plattform

| Plattform | Was vorab installiert sein muss |
|---|---|
| **Linux** (Ubuntu/Debian/RHEL/Fedora/Arch) | Nichts — das Install-Skript installiert Docker und Git automatisch. |
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) einmalig installieren und starten. |
| **Windows** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (mit aktiviertem WSL2-Backend) und [Git for Windows](https://git-scm.com/download/win) einmalig installieren. |

Optional: API-Keys fuer OpenRouter, OpenAI oder Anthropic.

## Installation (ein einziger Befehl)

### Linux / macOS — in einem Terminal

```sh
curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.sh | bash
```

### Windows — in PowerShell

```powershell
iwr -useb https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.ps1 | iex
```

Beide Skripte:

1. pruefen Voraussetzungen (auf Linux wird Docker bei Bedarf installiert)
2. klonen das Repo nach `~/paperclip` (Branch `addons` mit dem OpenRouter-Adapter)
3. erzeugen eine `.env` mit zufaelligem `BETTER_AUTH_SECRET` und auto-erkannter LAN-IP fuer `PAPERCLIP_PUBLIC_URL`
4. bauen das Image und starten den Container im privaten/authentifizierten Modus

Erststart-Build dauert 5–10 Minuten. Danach ist die UI unter der in der
Konsole angezeigten URL erreichbar.

### Optionen anpassen

Vor dem Aufruf Umgebungsvariablen setzen:

**Linux/macOS:**
```sh
PAPERCLIP_PUBLIC_URL=http://paperclip.firma.local:3100 \
PAPERCLIP_INSTALL_DIR=/opt/paperclip \
PAPERCLIP_PORT=3100 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.sh)"
```

**Windows:**
```powershell
$env:PAPERCLIP_PUBLIC_URL  = 'http://paperclip.firma.local:3100'
$env:PAPERCLIP_INSTALL_DIR = 'C:\paperclip'
$env:PAPERCLIP_PORT        = '3100'
iwr -useb https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.ps1 | iex
```

API-Keys koennen entweder spaeter in der UI eingetragen werden oder direkt in
`~/paperclip/.env` (anschliessend Update-Skript ausfuehren, damit der Container
sie aufnimmt).

## Update auf neue Version (ein einziger Befehl)

### Linux / macOS

```sh
curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/update-customer.sh | bash
```

### Windows

```powershell
iwr -useb https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/update-customer.ps1 | iex
```

Daten (User, Companies, Agenten, Tasks) bleiben im Docker-Volume
`paperclip-data` erhalten.

## Erststart: Board-User anlegen

Beim allerersten Start erzeugt Paperclip einen einmaligen
**Bootstrap-Invite-Link**. Diesen aus den Logs holen:

**Linux / macOS:**
```sh
docker compose -f ~/paperclip/docker/docker-compose.customer.yml logs paperclip | grep -i invite
```

**Windows (PowerShell):**
```powershell
docker compose -f $HOME\paperclip\docker\docker-compose.customer.yml logs paperclip | Select-String invite
```

Den Link im Browser oeffnen, Account anlegen — dieser Account wird automatisch
Board-Admin.

## Tagesgeschaeft

Alle Befehle vom Install-Verzeichnis aus (`cd ~/paperclip` bzw.
`cd $HOME\paperclip`):

```sh
# Status / Logs
docker compose -f docker/docker-compose.customer.yml ps
docker compose -f docker/docker-compose.customer.yml logs -f paperclip

# Stoppen
docker compose -f docker/docker-compose.customer.yml stop

# Wieder starten (Daten bleiben erhalten)
docker compose -f docker/docker-compose.customer.yml start

# Komplett herunterfahren (Container entfernen, Daten bleiben im Volume)
docker compose -f docker/docker-compose.customer.yml down
```

## Backup

Das `paperclip-data`-Volume enthaelt embedded Postgres + alle persistenten
Daten. Mit `docker volume ls | grep paperclip` den exakten Namen pruefen
(haengt vom Compose-Projektnamen ab).

```sh
# Backup erstellen
docker run --rm \
  -v paperclip_paperclip-data:/data \
  -v "$(pwd):/backup" \
  alpine tar czf /backup/paperclip-backup-$(date +%Y%m%d).tar.gz -C /data .
```

## Fehlerbehebung

| Symptom | Loesung |
|---|---|
| Windows: `Docker Desktop ist installiert, laeuft aber nicht` | Docker Desktop manuell starten und warten, bis das Tray-Icon `Docker Desktop is running` zeigt. Dann Skript erneut. |
| Login leitet auf falsche URL um | `PAPERCLIP_PUBLIC_URL` in `~/paperclip/.env` zeigt nicht auf den extern erreichbaren Host. Korrigieren und Update-Skript ausfuehren. |
| Port 3100 ist bereits belegt | In `~/paperclip/.env` `PAPERCLIP_PORT=3200` setzen, `PAPERCLIP_PUBLIC_URL` auf den neuen Port anpassen, Update-Skript ausfuehren. |
| Bootstrap-Invite-Link nicht in den Logs sichtbar | Schon ein Board-User vorhanden? Dann gibt es keinen neuen Invite. Mit dem ersten Account einloggen. |
| Linux: `permission denied` bei Docker-Befehlen | Benutzer ist (noch) nicht in der `docker`-Gruppe. Entweder mit `sudo` voranstellen oder einmal aus- und wieder einloggen. |
| Windows: `iwr ... \| iex` schlaegt mit ExecutionPolicy-Fehler fehl | PowerShell als normaler User starten und einmalig `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` ausfuehren. |
