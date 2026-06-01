param(
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    Write-Host $Message
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceRoot = if ($env:TIMELINEQC_INSTALL_SOURCE) { $env:TIMELINEQC_INSTALL_SOURCE } else { Join-Path $ScriptDir "TimelineQC" }
$DestRoot = if ($env:TIMELINEQC_INSTALL_DEST) {
    $env:TIMELINEQC_INSTALL_DEST
} else {
    Join-Path $env:ProgramData "Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\TimelineQC"
}
$LogPath = if ($env:TIMELINEQC_INSTALL_LOG) {
    $env:TIMELINEQC_INSTALL_LOG
} else {
    Join-Path $env:TEMP "TimelineQC_install.log"
}

Start-Transcript -Path $LogPath -Append | Out-Null
try {
    Write-Log "Source: $SourceRoot"
    Write-Log "Target: $DestRoot"
    Write-Log ""

    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot "manifest.xml"))) {
        throw "TimelineQC source folder is incomplete."
    }

    if (Get-Process Resolve -ErrorAction SilentlyContinue) {
        throw "DaVinci Resolve is running. Close it before installing."
    }

    New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null

    Write-Log "Copying files..."
    & robocopy $SourceRoot $DestRoot /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD __pycache__ reports /XF *.pyc | Out-Null
    $CopyCode = $LASTEXITCODE
    if ($CopyCode -ge 8) {
        throw "Robocopy failed with exit code $CopyCode"
    }

    $NodePath = Join-Path $DestRoot "WorkflowIntegration.node"
    if (-not (Test-Path -LiteralPath $NodePath)) {
        $NodeCandidates = @(
            "C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node",
            "C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\CompatibleSamplePlugin\WorkflowIntegration.node",
            "C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\ScriptTestPlugin\WorkflowIntegration.node",
            "C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePromisePlugin\WorkflowIntegration.node"
        )
        foreach ($Candidate in $NodeCandidates) {
            if (Test-Path -LiteralPath $Candidate) {
                Copy-Item -LiteralPath $Candidate -Destination $NodePath -Force
                Write-Log "WorkflowIntegration.node copied from Resolve samples."
                break
            }
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $DestRoot "manifest.xml"))) {
        throw "Copy completed but manifest.xml is still missing in target."
    }

    Write-Log ""
    Write-Log "Installed to: $DestRoot"
    Write-Log "Open Workspace > Workflow Integrations > 鸡腿快助手 in Resolve."
    exit 0
}
catch {
    Write-Log ""
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
}
finally {
    try { Stop-Transcript | Out-Null } catch {}
    if (-not $Quiet) {
        # The batch wrapper owns the pause.
    }
}

