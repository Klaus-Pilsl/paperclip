# Update master from upstream and rebase addons on top
# Run this whenever paperclipai/paperclip has new commits

$dir = $PSScriptRoot

Write-Host "Fetching upstream (paperclipai/paperclip)..." -ForegroundColor Cyan
git -C $dir fetch upstream

Write-Host "Updating master..." -ForegroundColor Cyan
git -C $dir checkout master
git -C $dir merge --ff-only upstream/master
git -C $dir push origin master

Write-Host "Rebasing addons onto master..." -ForegroundColor Cyan
git -C $dir checkout addons
git -C $dir rebase master

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "KONFLIKT beim Rebase! Löse die Konflikte, dann:" -ForegroundColor Yellow
    Write-Host "  git add <konflikt-dateien>" -ForegroundColor Yellow
    Write-Host "  git rebase --continue" -ForegroundColor Yellow
    Write-Host "  git push origin addons --force-with-lease" -ForegroundColor Yellow
    exit 1
}

git -C $dir push origin addons --force-with-lease
Write-Host "Fertig! addons-Branch ist auf dem neuesten Stand." -ForegroundColor Green
