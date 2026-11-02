# start-watch.ps1 - agentid-sniper launcher (wallet-2, FREE_ONLY, no NFT)
# stop: create empty file WATCH_STOP in this folder, or kill the node process
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path .\data)) { New-Item -ItemType Directory -Path .\data | Out-Null }

$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY  = 'http://127.0.0.1:7897'
$env:NODE_USE_ENV_PROXY = '1'
$env:NO_PROXY    = 'localhost,127.0.0.1,::1'

$fails = 0
while (-not (Test-Path .\WATCH_STOP)) {
  node watch.mjs
  $rc = $LASTEXITCODE
  if (Test-Path .\WATCH_STOP) { break }
  if ($rc -eq 0) { $fails = 0 } else { $fails++ }
  $line = "[{0}] watch.mjs exited rc={1}, restart in 5s (fails={2})" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $rc, $fails
  $line | Out-File -FilePath .\data\watch_console.log -Append -Encoding UTF8
  Start-Sleep -Seconds 5
}
$end = "[{0}] stopped (WATCH_STOP)" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
$end | Out-File -FilePath .\data\watch_console.log -Append -Encoding UTF8