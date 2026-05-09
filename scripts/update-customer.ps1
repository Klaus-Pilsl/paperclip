# Paperclip Customer Update (Windows)
# Holt die neuesten Aenderungen vom addons-Branch, baut das Image neu und
# startet den Container. Daten im Volume bleiben erhalten.
#
# Usage (One-Liner):
#   iwr -useb https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/update-customer.ps1 | iex
#
# Oder direkt aus dem Install-Verzeichnis:
#   ~\paperclip\scripts\update-customer.ps1

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$InstallDir  = if ($env:PAPERCLIP_INSTALL_DIR) { $env:PAPERCLIP_INSTALL_DIR } else { Join-Path $HOME 'paperclip' }
$Branch      = if ($env:PAPERCLIP_BRANCH)      { $env:PAPERCLIP_BRANCH }      else { 'addons' }
$ComposeFile = 'docker/docker-compose.customer.yml'

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[OK] $msg"  -ForegroundColor Green }
function Fail($msg) { Write-Host "[X]  $msg"  -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $InstallDir '.git'))) {
    Fail "Keine Paperclip-Installation unter $InstallDir. Erst install-customer.ps1 ausfuehren."
}
if (-not (Test-Path (Join-Path $InstallDir '.env'))) {
    Fail "$InstallDir\.env fehlt. Bitte install-customer.ps1 erneut ausfuehren."
}

try { docker info *> $null } catch {}
if ($LASTEXITCODE -ne 0) {
    Fail "Docker Desktop laeuft nicht. Bitte starten und warten, bis 'Docker Desktop is running' im Tray erscheint."
}

Set-Location $InstallDir

Info "Hole neueste Aenderungen vom $Branch-Branch ..."
git fetch origin
git checkout $Branch
git pull --ff-only origin $Branch
if ($LASTEXITCODE -ne 0) { Fail "git pull schlug fehl (lokale Aenderungen?). Bitte manuell pruefen: git status" }

Info "Baue Image neu und starte Container ..."
docker compose -f $ComposeFile --env-file .env up -d --build
if ($LASTEXITCODE -ne 0) { Fail "docker compose up schlug fehl. Logs: docker compose -f $ComposeFile logs paperclip" }

Ok "Update abgeschlossen."
$publicUrl = (Select-String -Path '.env' -Pattern '^PAPERCLIP_PUBLIC_URL=' | Select-Object -First 1).Line -replace '^PAPERCLIP_PUBLIC_URL=', ''
Write-Host "UI:    $publicUrl" -ForegroundColor Cyan
Write-Host "Logs:  docker compose -f $ComposeFile logs -f paperclip" -ForegroundColor Cyan
