$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $projectRoot 'extension'
if (-not (Test-Path -LiteralPath (Join-Path $extension 'manifest.json'))) { throw 'Run npm run build first.' }
$output = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination (Join-Path $extension 'LICENSE.txt')
Compress-Archive -Path (Join-Path $extension '*') -DestinationPath (Join-Path $output 'BewlyBewly-Downloads-Chrome.zip') -Force
Write-Output (Join-Path $output 'BewlyBewly-Downloads-Chrome.zip')
