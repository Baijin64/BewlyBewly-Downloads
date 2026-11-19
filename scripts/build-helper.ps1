param(
    [string]$FfmpegDirectory,
    [switch]$DevSign,
    [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
# Muxing, audio extraction and MP3 need FFmpeg; without it the helper falls back to
# low-quality single-file streams, so a package without it is refused.
if (-not $FfmpegDirectory) { $FfmpegDirectory = $env:BEWLY_FFMPEG_DIR }
if (-not $FfmpegDirectory) { $FfmpegDirectory = Join-Path $projectRoot 'dist\toolchain\ffmpeg\win32-x64' }
$ffmpegBinary = Join-Path $FfmpegDirectory 'ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffmpegBinary)) {
    throw "FFmpeg not found at $ffmpegBinary. Build it with 'bash scripts/toolchain/build-ffmpeg-docker.sh win32-x64' (or build-ffmpeg.sh on a host with MinGW), or pass -FfmpegDirectory."
}
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object { $_.Name -match '^10\.0\.\d+\.0$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\makeappx.exe')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK (MakeAppx) is required.' }
$dotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnetCommand) { throw '.NET SDK (dotnet) is required.' }
$dotnetBinary = $dotnetCommand.Source
$output = Join-Path $projectRoot 'dist'
$stage = Join-Path $output 'helper-msix'
# The MSIX packs the whole staging folder, so start from an empty one: earlier
# builds left Node-era files (node_modules, *.mjs, aria2c.exe) behind.
if ([System.IO.Path]::GetFullPath($stage) -ne [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\helper-msix'))) { throw 'Unexpected staging path.' }
if (Test-Path -LiteralPath $stage) {
    if ((Get-Item -LiteralPath $stage).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clear a linked staging directory.' }
    Remove-Item -LiteralPath $stage -Recurse -Force
}
foreach ($folder in @($output,$stage,(Join-Path $stage 'bin'),(Join-Path $stage 'Assets'),(Join-Path $stage 'licenses'))) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
$stagedRuntime = [System.IO.Path]::GetFullPath((Join-Path $stage 'runtime'))
if ($stagedRuntime -ne [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\helper-msix\runtime'))) { throw 'Unexpected runtime staging path.' }
if (Test-Path -LiteralPath $stagedRuntime) {
    if ((Get-Item -LiteralPath $stagedRuntime).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clear a linked runtime staging directory.' }
    Remove-Item -LiteralPath $stagedRuntime -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'platforms\windows\AppxManifest.xml') -Destination (Join-Path $stage 'AppxManifest.xml')
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination (Join-Path $stage 'licenses\BewlyBewly-MIT.txt')
$nodeLicense = Join-Path $stage 'licenses\Node-LICENSE.txt'
if (Test-Path -LiteralPath $nodeLicense) { Remove-Item -LiteralPath $nodeLicense -Force }
foreach ($retired in @('GPL-3.0.txt')) {
    $retiredPath = Join-Path $stage "licenses\$retired"
    if (Test-Path -LiteralPath $retiredPath) { Remove-Item -LiteralPath $retiredPath -Force }
}
# Older stagings left aria2c.exe and other retired tools in bin\; the MSIX packs
# whatever is there, so bin\ holds exactly the bundled FFmpeg.
Get-ChildItem -LiteralPath (Join-Path $stage 'bin') -File | Where-Object { $_.Name -ne 'ffmpeg.exe' } | Remove-Item -Force
# The host looks for bin\ffmpeg.exe next to itself (bewly-media candidate_paths).
Copy-Item -LiteralPath $ffmpegBinary -Destination (Join-Path $stage 'bin\ffmpeg.exe') -Force
foreach ($notice in @('LICENSE-FFmpeg-LGPL-2.1.txt','LICENSE-LAME-LGPL.txt','SOURCES.txt')) {
    $noticePath = Join-Path $FfmpegDirectory $notice
    if (-not (Test-Path -LiteralPath $noticePath)) { throw "Missing $notice next to the FFmpeg build in $FfmpegDirectory." }
    Copy-Item -LiteralPath $noticePath -Destination (Join-Path $stage "licenses\FFmpeg-$notice") -Force
}
@'
This is a local development package, not an upstream Bilidown release.
The download core and UI changes are newly implemented in the BewlyBewly fork.
Media transfer is implemented in Rust. Muxing, audio extraction and MP3 encoding use
the bundled bin\ffmpeg.exe: FFmpeg (https://ffmpeg.org/) with LAME
(https://lame.sourceforge.io/), both under the LGPL, built from unmodified upstream
sources by scripts/toolchain/build-ffmpeg.sh without GPL or non-free components.
Source URLs, checksums and the exact configure flags are in FFmpeg-SOURCES.txt.
BewlyBewly MIT and retained dependency license notices are included in this directory.
'@ | Set-Content -LiteralPath (Join-Path $stage 'licenses\THIRD-PARTY.txt') -Encoding utf8
Add-Type -Path (Join-Path $projectRoot 'platforms\windows\TrayArtwork.cs') -ReferencedAssemblies System.Drawing
[TrayArtwork]::MascotOverridePath = Join-Path $projectRoot 'platforms\windows\Assets\BewlyMascot.png'
[TrayArtwork]::WriteIcon((Join-Path $stage 'Assets\BewlyDownload.ico'))

# Build Native AOT BewlyDownloadTray
$trayProject = Join-Path $projectRoot 'platforms\windows\BewlyDownloadTray.csproj'
& $dotnetBinary publish $trayProject -c Release -r win-x64
if ($LASTEXITCODE -ne 0) { throw 'BewlyDownloadTray Native AOT compilation failed.' }
$publishExe = Get-ChildItem (Join-Path $projectRoot 'platforms\windows\bin\Release') -Recurse -Filter 'BewlyDownloadTray.exe' | Where-Object { $_.DirectoryName -like '*publish*' } | Select-Object -First 1
if (-not $publishExe) { throw 'Published BewlyDownloadTray.exe not found.' }
$trayBinary = $publishExe.FullName
$releaseTarget = Join-Path $projectRoot 'rust\target\release'
if (Test-Path -LiteralPath $releaseTarget) {
    Copy-Item -LiteralPath $trayBinary -Destination (Join-Path $releaseTarget 'BewlyDownloadTray.exe') -Force
}
Copy-Item -LiteralPath $trayBinary -Destination (Join-Path $stage 'BewlyDownloadTray.exe') -Force

# The package is useless without the host: the manifest declares it as the only
# executable and the app alias points at it. Refuse to produce a broken MSIX.
$rustHost = Join-Path $projectRoot 'rust\target\release\bewly-host.exe'
if (-not (Test-Path -LiteralPath $rustHost)) {
    throw "Rust host not found at $rustHost. Run 'cargo build --release -p bewly-host' inside rust/ first."
}
Copy-Item -LiteralPath $rustHost -Destination (Join-Path $stage 'BewlyDownloadHost.exe') -Force

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
