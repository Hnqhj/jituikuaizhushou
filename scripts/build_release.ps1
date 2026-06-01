param(
    [string]$DownloadBaseUrl = "",
    [string]$DateStamp = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $Root "TimelineQC"
$PackageJson = Get-Content -Raw -Encoding UTF8 (Join-Path $PluginDir "package.json") | ConvertFrom-Json
$Version = [string]$PackageJson.version
$ProductName = [string]$PackageJson.productName
if (-not $ProductName) {
    $ProductName = "鸡腿快助手"
}
if (-not $DateStamp) {
    $DateStamp = Get-Date -Format "yyyyMMdd"
}

$ReleaseRoot = Join-Path $Root "release"
$ReleaseName = "$ProductName`_v$Version`_$DateStamp"
$ReleaseDir = Join-Path $ReleaseRoot $ReleaseName
$ZipPath = Join-Path $ReleaseRoot "$ReleaseName.zip"
$UpdateDir = Join-Path $Root "update"
$UpdateJsonPath = Join-Path $UpdateDir "update.json"

New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null

$ResolvedReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$ResolvedReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)
if (-not $ResolvedReleaseDir.StartsWith($ResolvedReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe release path: $ReleaseDir"
}

if (Test-Path -LiteralPath $ReleaseDir) {
    Remove-Item -LiteralPath $ReleaseDir -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $ReleaseDir "TimelineQC") | Out-Null
Copy-Item -LiteralPath (Join-Path $Root "install.bat") -Destination (Join-Path $ReleaseDir "install.bat") -Force
Copy-Item -LiteralPath (Join-Path $Root "install.ps1") -Destination (Join-Path $ReleaseDir "install.ps1") -Force
Get-ChildItem -LiteralPath $PluginDir -Filter *.md -File |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $ReleaseDir $_.Name) -Force
    }

$PluginTarget = Join-Path $ReleaseDir "TimelineQC"
robocopy $PluginDir $PluginTarget /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ reports /XF *.pyc | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) {
    throw "Robocopy plugin failed with exit code $rc"
}

$RuntimeSource = Join-Path $PluginDir "runtime"
if (-not (Test-Path -LiteralPath $RuntimeSource)) {
    $RuntimeSource = Get-ChildItem -LiteralPath $ReleaseRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "TimelineQC\runtime\python\python.exe") } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 |
        ForEach-Object { Join-Path $_.FullName "TimelineQC\runtime" }
}
if (-not $RuntimeSource -or -not (Test-Path -LiteralPath $RuntimeSource)) {
    throw "Runtime folder not found. Keep an older full release in release/ or put runtime under TimelineQC/runtime."
}

robocopy $RuntimeSource (Join-Path $PluginTarget "runtime") /E /NFL /NDL /NJH /NJS /NP | Out-Null
$rcRuntime = $LASTEXITCODE
if ($rcRuntime -ge 8) {
    throw "Robocopy runtime failed with exit code $rcRuntime"
}

$Required = @(
    (Join-Path $ReleaseDir "install.bat"),
    (Join-Path $ReleaseDir "install.ps1"),
    (Join-Path $PluginTarget "manifest.xml"),
    (Join-Path $PluginTarget "main.js"),
    (Join-Path $PluginTarget "bridge.py"),
    (Join-Path $PluginTarget "WorkflowIntegration.node"),
    (Join-Path $PluginTarget "runtime\python\python.exe"),
    (Join-Path $PluginTarget "runtime\ffmpeg\bin\ffmpeg.exe")
)
foreach ($Path in $Required) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required file: $Path"
    }
}

Compress-Archive -Path (Join-Path $ReleaseDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal -Force
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipPath).Hash.ToLowerInvariant()
$ZipName = Split-Path -Leaf $ZipPath
$DownloadUrl = ""
if ($DownloadBaseUrl) {
    $DownloadUrl = $DownloadBaseUrl.TrimEnd("/") + "/" + $ZipName
}

$Update = [ordered]@{
    version = $Version
    url = $DownloadUrl
    sha256 = $Hash
    notes = "鸡腿快助手 $Version"
    published_at = (Get-Date).ToString("s")
}
$Update | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $UpdateJsonPath
Copy-Item -LiteralPath $UpdateJsonPath -Destination (Join-Path $ReleaseDir "update.json") -Force

[PSCustomObject]@{
    Version = $Version
    ReleaseDir = $ReleaseDir
    ZipPath = $ZipPath
    Sha256 = $Hash
    UpdateJson = $UpdateJsonPath
}

