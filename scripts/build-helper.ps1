param(
    [string]$BinDirectory,
    [switch]$DevSign,
    [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $BinDirectory) {
    $BinDirectory = $env:BEWLY_MEDIA_BIN
    if (-not $BinDirectory) { $BinDirectory = $env:BEWLY_BILIDOWN_BIN }
    if (-not $BinDirectory) {
        foreach ($cachedBin in @('dist\toolchain\bin','dist\private-build-deps\bin')) {
            $candidateBin = Join-Path $projectRoot $cachedBin
            if ((Test-Path -LiteralPath (Join-Path $candidateBin 'ffmpeg.exe')) -and (Test-Path -LiteralPath (Join-Path $candidateBin 'aria2c.exe'))) {
                $BinDirectory = $candidateBin
                break
            }
        }
    }
    if (-not $BinDirectory) { throw 'Fetch the pinned media toolchain using docs/BUILD-DOWNLOADS.md, or pass -BinDirectory.' }
}
$BinDirectory = (Resolve-Path -LiteralPath $BinDirectory).Path
foreach ($binary in @('aria2c.exe','ffmpeg.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $BinDirectory $binary))) { throw "Missing $binary in $BinDirectory" }
}
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object { $_.Name -match '^10\.0\.\d+\.0$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\makeappx.exe')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK (MakeAppx) is required.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$nodeBinary = (Get-Command node.exe).Source
$nodeVersion = (& $nodeBinary -p 'process.versions.node').Trim()
if ([version]$nodeVersion -lt [version]'24.0.0') { throw 'Node.js 24 or later is required for development.' }
$output = Join-Path $projectRoot 'dist'
$stage = Join-Path $output 'helper-msix'
foreach ($folder in @($output,$stage,(Join-Path $stage 'bin'),(Join-Path $stage 'Assets'),(Join-Path $stage 'licenses'))) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
$stagedRuntime = [System.IO.Path]::GetFullPath((Join-Path $stage 'runtime'))
if ($stagedRuntime -ne [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\helper-msix\runtime'))) { throw 'Unexpected runtime staging path.' }
if (Test-Path -LiteralPath $stagedRuntime) {
    if ((Get-Item -LiteralPath $stagedRuntime).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clear a linked runtime staging directory.' }
    Remove-Item -LiteralPath $stagedRuntime -Recurse -Force
}
foreach ($binary in @('aria2c.exe','ffmpeg.exe')) { Copy-Item -LiteralPath (Join-Path $BinDirectory $binary) -Destination (Join-Path $stage "bin\$binary") }
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'native') -File -Filter '*.mjs' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) }
foreach ($folder in @('platform','runtime')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "native\$folder") -Destination (Join-Path $stage $folder) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\identity.json') -Destination (Join-Path $stage 'identity.json')
$nativeModules = Join-Path $projectRoot 'native\node_modules'
if (-not (Test-Path -LiteralPath (Join-Path $nativeModules 'classic-level\package.json'))) { throw 'Run npm ci --prefix native before building the helper.' }
$stagedModules = [System.IO.Path]::GetFullPath((Join-Path $stage 'node_modules'))
$expectedModules = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\helper-msix\node_modules'))
if ($stagedModules -ne $expectedModules) { throw 'Unexpected helper dependency staging path.' }
if (Test-Path -LiteralPath $stagedModules) {
    if ((Get-Item -LiteralPath $stagedModules).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clear a linked staging directory.' }
    Remove-Item -LiteralPath $stagedModules -Recurse -Force
}
Get-ChildItem -LiteralPath $nativeModules -Recurse -File | Where-Object {
    $relative = $_.FullName.Substring($nativeModules.Length).TrimStart('\').Replace('\','/')
    $keep = $relative -notmatch '(^|/)\.(vite|cache|bin)(/|$)' -and $relative -notmatch '(^|/)(test|tests|benchmark|benchmarks|example|examples|deps|src|types)(/|$)' -and $relative -notmatch '\.(cc|cpp|h|gyp|gypi|map|ts)$'
    if ($relative -match '/prebuilds/') { $keep = $relative -match '/prebuilds/win32-x64/[^/]+\.node$' }
    $keep
} | ForEach-Object {
    $relative = $_.FullName.Substring($nativeModules.Length).TrimStart('\')
    $destination = Join-Path (Join-Path $stage 'node_modules') $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\windows\AppxManifest.xml') -Destination (Join-Path $stage 'AppxManifest.xml')
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination (Join-Path $stage 'licenses\BewlyBewly-MIT.txt')
$nodeLicense = Join-Path $stage 'licenses\Node-LICENSE.txt'
if (Test-Path -LiteralPath $nodeLicense) { Remove-Item -LiteralPath $nodeLicense -Force }
$gplLicense = Join-Path $stage 'licenses\GPL-3.0.txt'
if (-not (Test-Path -LiteralPath $gplLicense)) { Invoke-WebRequest -Uri 'https://www.gnu.org/licenses/gpl-3.0.txt' -OutFile $gplLicense }
@'
This is a local development package, not an upstream Bilidown release.
The download core and UI changes are newly implemented in the BewlyBewly fork.
aria2 and FFmpeg binaries are copied from the user's supplied installation.
aria2: https://github.com/aria2/aria2 (GPL-2.0-or-later)
FFmpeg: https://ffmpeg.org/ (this supplied build reports GPL-3.0)
The exact matching third-party build sources must be supplied before public redistribution.
Node.js is not distributed in this package. A compatible system Node.js 24+ x64 is required.
BewlyBewly MIT and retained dependency license notices are included in this directory.
'@ | Set-Content -LiteralPath (Join-Path $stage 'licenses\THIRD-PARTY.txt') -Encoding utf8
Add-Type -Path (Join-Path $projectRoot 'native\windows\TrayArtwork.cs') -ReferencedAssemblies System.Drawing
[TrayArtwork]::WriteIcon((Join-Path $stage 'Assets\BewlyDownload.ico'))
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\windows\NativeHost.config') -Destination (Join-Path $stage 'BewlyDownloadHost.exe.config')
$desktopSources = @('NativeHost.cs','TrayHost.cs','TrayArtwork.cs','DesktopUi.cs','NodeRuntime.cs','NodeInstaller.cs','BundledTool.cs') | ForEach-Object { Join-Path $projectRoot "native\windows\$_" }
& $compiler /nologo /target:winexe /platform:x64 /codepage:65001 /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Security.dll "/win32manifest:$projectRoot\native\windows\NativeHost.manifest" "/win32icon:$stage\Assets\BewlyDownload.ico" "/out:$stage\BewlyDownloadHost.exe" $desktopSources
if ($LASTEXITCODE -ne 0) { throw 'Native host compilation failed.' }
# MSIX tile assets: every size is rendered natively by TrayArtwork (vector metrics, never
# downscaled from a master bitmap). Scale variants let Start menu and the Store listing pick
# a crisp asset at 100%-400% DPI instead of upscaling the 150 px base image.
$assetSet = [ordered]@{
    'StoreLogo.png' = 50
    'StoreLogo.scale-200.png' = 100
    'Square44x44Logo.png' = 44
    'Square44x44Logo.scale-125.png' = 55
    'Square44x44Logo.scale-150.png' = 66
    'Square44x44Logo.scale-200.png' = 88
    'Square44x44Logo.scale-400.png' = 176
    'Square150x150Logo.png' = 150
    'Square150x150Logo.scale-125.png' = 188
    'Square150x150Logo.scale-150.png' = 225
    'Square150x150Logo.scale-200.png' = 300
    'Square150x150Logo.scale-400.png' = 600
}
foreach ($entry in $assetSet.GetEnumerator()) {
    $image = [TrayArtwork]::Bitmap([int]$entry.Value)
    try { $image.Save((Join-Path $stage "Assets\$($entry.Key)"), [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
}
$packageManifest = [xml](Get-Content -LiteralPath (Join-Path $stage 'AppxManifest.xml') -Raw)
$helperVersion = ([version]$packageManifest.Package.Identity.Version).ToString(3)
if ($StageOnly) { Write-Output "Unpacked test helper: $stage"; return }
$msix = Join-Path $output "Bewly-DownloadHelper-$helperVersion-x64.msix"
$packageLog = Join-Path $output 'helper-package.log'
& (Join-Path $sdk.FullName 'x64\makeappx.exe') pack /d $stage /p $msix /o *> $packageLog
if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $packageLog -Tail 30; throw 'MSIX package validation failed.' }
if ($DevSign) {
    $targetPublisher = $packageManifest.Package.Identity.Publisher
    $candidateCert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $targetPublisher -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $candidateCert) {
        $candidateCert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -eq $targetPublisher -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    }
    if (-not $candidateCert) {
        throw "Signing certificate matching publisher '$targetPublisher' with private key was not found in Cert:\CurrentUser\My."
    }
    & (Join-Path $sdk.FullName 'x64\signtool.exe') sign /fd SHA256 /s My /sha1 $candidateCert.Thumbprint $msix
    if ($LASTEXITCODE -ne 0) { throw 'Development signing failed.' }
    Export-Certificate -Cert $candidateCert -FilePath (Join-Path $output 'BewlyDownload-Development.cer') -Force | Out-Null
}
Write-Output "MSIX: $msix"
Write-Output 'Package built. No certificate trust, package installation or browser registration was changed.'
