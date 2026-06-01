param(
    [Parameter(Mandatory = $true)]
    [string]$RemoteUrl,
    [string]$Branch = "master"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PackageJson = Get-Content -Raw -Encoding UTF8 (Join-Path $Root "TimelineQC\package.json") | ConvertFrom-Json
$Version = [string]$PackageJson.version

Push-Location $Root
try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root ".git"))) {
        git init
    }

    $remote = git remote
    if ($remote -contains "origin") {
        git remote set-url origin $RemoteUrl
    } else {
        git remote add origin $RemoteUrl
    }

    git add .
    git commit -m "Release v$Version" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "No commit created. Working tree may be clean."
    }

    git tag -f "v$Version"
    git branch -M $Branch
    git push -u origin $Branch
    git push -f origin "v$Version"
} finally {
    Pop-Location
}
