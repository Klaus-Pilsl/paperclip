# Paperclip Customer Bootstrap (Windows)
# Klont den addons-Branch, generiert Secrets, baut und startet den Container.
# Voraussetzung: Docker Desktop ist installiert und laeuft (WSL2-Backend empfohlen).
#
# Usage (One-Liner in PowerShell):
#   iwr -useb https://raw.githubusercontent.com/Klaus-Pilsl/paperclip/addons/scripts/install-customer.ps1 | iex
#
# Defaults ueberschreiben (vor dem One-Liner setzen):
#   $env:PAPERCLIP_INSTALL_DIR = 'C:\paperclip'
#   $env:PAPERCLIP_PUBLIC_URL  = 'http://my-host:3100'
#   $env:PAPERCLIP_PORT        = '3200'

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$RepoUrl     = if ($env:PAPERCLIP_REPO_URL)     { $env:PAPERCLIP_REPO_URL }     else { 'https://github.com/Klaus-Pilsl/paperclip.git' }
$Branch      = if ($env:PAPERCLIP_BRANCH)       { $env:PAPERCLIP_BRANCH }       else { 'addons' }
$InstallDir  = if ($env:PAPERCLIP_INSTALL_DIR)  { $env:PAPERCLIP_INSTALL_DIR }  else { Join-Path $HOME 'paperclip' }
$Port        = if ($env:PAPERCLIP_PORT)         { $env:PAPERCLIP_PORT }         else { '3100' }
$ComposeFile = 'docker/docker-compose.customer.yml'

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[OK] $msg"  -ForegroundColor Green }
function Warn($msg) { Write-Host "[!]  $msg"  -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[X]  $msg"  -ForegroundColor Red; exit 1 }

# ---------- 1. Voraussetzungen pruefen ---------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "Git ist nicht installiert. Bitte Git for Windows installieren: https://git-scm.com/download/win  (oder: winget install -e --id Git.Git)"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Docker Desktop ist nicht installiert. Bitte einmalig installieren: https://www.docker.com/products/docker-desktop/  (oder: winget install -e --id Docker.DockerDesktop). Nach dem Reboot dieses Skript erneut ausfuehren."
}

try { docker info *> $null } catch {}
if ($LASTEXITCODE -ne 0) {
    Fail "Docker Desktop ist installiert, laeuft aber nicht. Bitte Docker Desktop starten und warten, bis das Tray-Icon 'Docker Desktop is running' anzeigt. Dann Skript erneut ausfuehren."
}

try { docker compose version *> $null } catch {}
if ($LASTEXITCODE -ne 0) {
    Fail "Docker Compose v2 fehlt. Docker Desktop aktualisieren (mind. Version 4.0)."
}

Ok "Docker laeuft: $(docker --version)"

# ---------- 2. Repo holen / aktualisieren ------------------------------------

if (Test-Path (Join-Path $InstallDir '.git')) {
    Info "Repo existiert bereits unter $InstallDir - aktualisiere ..."
    git -C $InstallDir fetch origin
    git -C $InstallDir checkout $Branch
    git -C $InstallDir pull --ff-only origin $Branch
} else {
    Info "Klone Paperclip ($Branch) nach $InstallDir ..."
    $parent = Split-Path -Parent $InstallDir
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    git clone -b $Branch $RepoUrl $InstallDir
}

Set-Location $InstallDir

# ---------- 3. .env vorbereiten ----------------------------------------------

function Get-LanIp {
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.PrefixOrigin -in 'Dhcp','Manual' -and $_.IPAddress -notmatch '^127\.|^169\.254\.' } |
            Select-Object -First 1).IPAddress
        if ($ip) { return $ip }
    } catch {}
    try {
        $ip = (Test-Connection -ComputerName $env:COMPUTERNAME -Count 1 -ErrorAction SilentlyContinue).IPv4Address.IPAddressToString
        if ($ip) { return $ip }
    } catch {}
    return 'localhost'
}

function New-AuthSecret {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join ''
}

function Set-EnvFile {
    param([hashtable]$Values)
    $lines = Get-Content '.env' -Encoding UTF8
    $out = foreach ($line in $lines) {
        $matched = $false
        foreach ($key in $Values.Keys) {
            if ($line -match "^$key=") {
                "$key=$($Values[$key])"
                $matched = $true
                break
            }
        }
        if (-not $matched) { $line }
    }
    [System.IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), $out, [System.Text.UTF8Encoding]::new($false))
}

if (Test-Path '.env') {
    Ok ".env existiert bereits - werte werden nicht ueberschrieben"
    $publicUrl = (Select-String -Path '.env' -Pattern '^PAPERCLIP_PUBLIC_URL=' | Select-Object -First 1).Line -replace '^PAPERCLIP_PUBLIC_URL=', ''
} else {
    Info "Erzeuge .env"
    Copy-Item 'docker/.env.customer.example' '.env'
    $secret = New-AuthSecret
    $publicUrl = if ($env:PAPERCLIP_PUBLIC_URL) { $env:PAPERCLIP_PUBLIC_URL } else { "http://$(Get-LanIp):$Port" }
    Set-EnvFile -Values @{
        BETTER_AUTH_SECRET   = $secret
        PAPERCLIP_PUBLIC_URL = $publicUrl
        PAPERCLIP_PORT       = $Port
    }
    Ok ".env erstellt - PAPERCLIP_PUBLIC_URL=$publicUrl"
}

# ---------- 4. Build & Start -------------------------------------------------

Info "Baue Image und starte Container (Erststart 5-10 Minuten) ..."
docker compose -f $ComposeFile --env-file .env up -d --build
if ($LASTEXITCODE -ne 0) { Fail "docker compose up schlug fehl. Logs: docker compose -f $ComposeFile logs paperclip" }

# ---------- 5. Hinweise ------------------------------------------------------

Write-Host ''
Ok 'Paperclip laeuft.'
Write-Host ''
Write-Host "UI:               $publicUrl"            -ForegroundColor Cyan
Write-Host "Logs:             docker compose -f $ComposeFile logs -f paperclip" -ForegroundColor Cyan
Write-Host "Stoppen:          docker compose -f $ComposeFile stop"             -ForegroundColor Cyan
Write-Host "Starten:          docker compose -f $ComposeFile start"            -ForegroundColor Cyan
Write-Host "Update:           $InstallDir\scripts\update-customer.ps1"          -ForegroundColor Cyan
Write-Host ''
Warn 'Bootstrap-Invite-Link beim Erststart:'
Write-Host "    docker compose -f $ComposeFile logs paperclip | Select-String invite"
Write-Host '    (Link im Browser oeffnen, Account anlegen - wird Board-Admin.)'
