param(
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

function Write-Utf8NoBomLf {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $normalized = $Value -replace "`r`n", "`n"
    $normalized = $normalized -replace "`r", "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $normalized, $utf8NoBom)
}

$ReleaseRoot = Join-Path $Root "release"
$ReleaseName = "{0}_mac_v{1}_{2}" -f $ProductName, $Version, $DateStamp
$ReleaseDir = Join-Path $ReleaseRoot $ReleaseName
$ZipPath = Join-Path $ReleaseRoot "$ReleaseName.zip"

New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null

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

robocopy $PluginDir (Join-Path $ReleaseDir "TimelineQC") /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ reports runtime /XF install.bat WorkflowIntegration.node *.pyc | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) {
    throw "Robocopy plugin failed with exit code $rc"
}

Copy-Item -LiteralPath (Join-Path $Root "TimelineQC\免责声明.md") -Destination (Join-Path $ReleaseDir "免责声明.md") -Force

$macReadme = @"
# 鸡腿快助手 Mac 安装说明

## 适用环境
- macOS
- DaVinci Resolve Studio

## 安装方式
1. 关闭 DaVinci Resolve。
2. 将压缩包完整解压到本地文件夹，不要直接在压缩包里运行。
3. 终端进入解压目录后执行：
   `chmod +x install.command && ./install.command`
   如果不想修改执行权限，也可以执行：
   `zsh install.command`
4. 重启 DaVinci Resolve Studio。
5. 在 `Workspace > Workflow Integrations` 中打开 `鸡腿快助手`。

## 依赖
- Resolve 的 mac 版 Workflow Integration 示例插件里的原生 `WorkflowIntegration.node`
- `python3`
- Pillow
- numpy
- ffmpeg

## 说明
- 当前仓库只有 Windows 版 `WorkflowIntegration.node`，mac 包不会打入这个 Windows 二进制文件。
- mac 安装脚本会优先从 Resolve 的 mac 版示例插件目录复制原生 `WorkflowIntegration.node`。如果找不到，文件会完成安装，但插件无法在 Resolve 里正常加载。
- 如果脚本提示找不到 `WorkflowIntegration.node`，请先确认 Resolve 的开发者示例已安装。
- 如果脚本提示缺少 Python 依赖，请执行：
  `python3 -m pip install --user Pillow numpy`
- 如果脚本提示缺少 ffmpeg，请用 Homebrew 安装或自行提供可执行文件。
"@
Write-Utf8NoBomLf -Path (Join-Path $ReleaseDir "Mac安装说明.md") -Value $macReadme

$installCommand = @'
#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/TimelineQC"
DEST="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Support/Workflow Integration Plugins/TimelineQC"
NODE_CANDIDATES=(
  "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Support/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
  "$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Support/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
  "/Applications/DaVinci Resolve.app/Contents/Resources/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
)

run_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_root mkdir -p "$DEST"
run_root rsync -a --delete \
  --exclude 'WorkflowIntegration.node' \
  --exclude '__pycache__' \
  --exclude 'reports' \
  --exclude '*.pyc' \
  "$SRC"/ "$DEST"/

if [[ ! -f "$DEST/WorkflowIntegration.node" ]]; then
  for candidate in "${NODE_CANDIDATES[@]}"; do
    if [[ -f "$candidate" ]]; then
      run_root cp "$candidate" "$DEST/WorkflowIntegration.node"
      break
    fi
  done
fi

if [[ ! -f "$DEST/WorkflowIntegration.node" ]]; then
  echo "WARNING: WorkflowIntegration.node not found."
  echo "The Windows WorkflowIntegration.node is intentionally not included."
  echo "Copy the mac-native file from Resolve's SamplePlugin folder or install the developer examples."
fi

if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c 'import PIL, numpy' >/dev/null 2>&1; then
    echo "WARNING: Python dependencies missing. Run: python3 -m pip install --user Pillow numpy"
  fi
else
  echo "WARNING: python3 not found."
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not found."
fi

echo "Installed to: $DEST"
echo "Open Workspace > Workflow Integrations > 鸡腿快助手 in Resolve."
'@
Write-Utf8NoBomLf -Path (Join-Path $ReleaseDir "install.command") -Value $installCommand

Compress-Archive -Path (Join-Path $ReleaseDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal -Force

[PSCustomObject]@{
    Version = $Version
    ReleaseDir = $ReleaseDir
    ZipPath = $ZipPath
    MacNativeNodeBundled = $false
}

