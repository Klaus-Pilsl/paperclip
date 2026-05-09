# Paperclip — Installation per Docker

Diese Anleitung zeigt, wie Paperclip auf einem Linux-Host als Docker-Container
installiert wird. Das Setup ist auf den Betrieb im **privaten Netz** (LAN, VPN
oder Tailscale) ausgelegt — Login erforderlich, kein oeffentliches HTTPS noetig.

## Voraussetzungen

- Linux-Host (Ubuntu, Debian, RHEL, Fedora, Arch — alles, was den
  offiziellen Docker-Installer unterstuetzt). macOS funktioniert auch, dort
  muss Docker Desktop einmalig manuell installiert werden.
- `curl` und `git` (auf den meisten Distributionen schon vorhanden — sonst
  installiert das Skript sie nach).
- Optional: API-Keys fuer OpenRouter, OpenAI oder Anthropic.

Das Setup-Skript installiert Docker, klont das Repo, generiert Secrets,
baut das Image und startet den Container — alles automatisch.

## Installation (ein einziger Befehl)

```sh
curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.sh | bash
```

Das Skript:

1. installiert Docker (falls nicht vorhanden) ueber den offiziellen Installer
2. klont das Repo nach `~/paperclip` (Branch `addons` mit dem OpenRouter-Adapter)
3. erzeugt eine `.env` mit zufaelligem `BETTER_AUTH_SECRET` und auto-erkannter LAN-IP fuer `PAPERCLIP_PUBLIC_URL`
4. baut das Image und startet den Container im privaten/authentifizierten Modus

Beim ersten Start dauert der Build 5–10 Minuten. Danach ist die UI unter der
in der Konsole angezeigten URL erreichbar.

### Optionen anpassen

Vor dem Start Umgebungsvariablen setzen, um Defaults zu ueberschreiben:

```sh
curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.sh \
  | PAPERCLIP_PUBLIC_URL=http://paperclip.firma.local:3100 \
    PAPERCLIP_INSTALL_DIR=/opt/paperclip \
    PAPERCLIP_PORT=3100 \
    bash
```

API-Keys koennen entweder spaeter in der UI eingetragen werden oder direkt in
`~/paperclip/.env` (anschliessend `~/paperclip/scripts/update-customer.sh`
ausfuehren, damit der Container sie aufnimmt).

## Update auf neue Version (ein einziger Befehl)

```sh
curl -fsSL https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/update-customer.sh | bash
```

Oder direkt aus dem Install-Verzeichnis:

```sh
~/paperclip/scripts/update-customer.sh
```

Das Skript holt die neuesten Commits vom `addons`-Branch, baut das Image neu
und startet den Container. Daten (User, Companies, Agenten, Tasks) bleiben im
Docker-Volume `paperclip-data` erhalten.

## Erststart: Board-User anlegen

Beim allerersten Start erzeugt Paperclip einen einmaligen
**Bootstrap-Invite-Link**. Diesen aus den Logs holen:

```sh
docker compose -f ~/paperclip/docker/docker-compose.customer.yml logs paperclip | grep -i invite
```

(Mit `sudo` voranstellen, falls der eigene Benutzer noch nicht in der
`docker`-Gruppe ist — ein Re-Login behebt das dauerhaft.)

Den Link im Browser oeffnen, Account anlegen — dieser Account wird automatisch
Board-Admin.

## Tagesgeschaeft

Alle Befehle vom Install-Verzeichnis aus (`cd ~/paperclip`):

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

```sh
# Backup erstellen (Volume-Name kann je nach Compose-Projekt variieren —
# mit 'docker volume ls | grep paperclip' den exakten Namen pruefen)
docker run --rm \
  -v paperclip_paperclip-data:/data \
  -v "$(pwd):/backup" \
  alpine tar czf /backup/paperclip-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restore (Container muss gestoppt sein)
docker compose -f docker/docker-compose.customer.yml down
docker run --rm \
  -v paperclip_paperclip-data:/data \
  -v "$(pwd):/backup" \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/paperclip-backup-YYYYMMDD.tar.gz -C /data"
docker compose -f docker/docker-compose.customer.yml --env-file .env up -d
```

## Fehlerbehebung

| Symptom | Ursache / Loesung |
|---|---|
| `BETTER_AUTH_SECRET must be set` beim Start | `.env` fehlt oder ist leer. Install-Skript erneut ausfuehren — bei vorhandenem Repo wird nur die `.env` neu erzeugt. |
| Login leitet auf falsche URL um | `PAPERCLIP_PUBLIC_URL` in `~/paperclip/.env` zeigt nicht auf den extern erreichbaren Host. Korrigieren und Update-Skript ausfuehren. |
| Port 3100 ist bereits belegt | In `~/paperclip/.env` `PAPERCLIP_PORT=3200` setzen, `PAPERCLIP_PUBLIC_URL` auf den neuen Port anpassen, Update-Skript ausfuehren. |
| Bootstrap-Invite-Link nicht in den Logs sichtbar | Schon ein Board-User vorhanden? Dann gibt es keinen neuen Invite. Mit dem ersten Account einloggen. |
| `permission denied` bei Docker-Befehlen | Benutzer ist (noch) nicht in der `docker`-Gruppe. Entweder mit `sudo` voranstellen oder einmal aus- und wieder einloggen. |
