@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "PS1=%ROOT%install.ps1"
set "SRC=%ROOT%TimelineQC"

if not exist "%SRC%\manifest.xml" (
    echo ERROR: TimelineQC folder not found next to install.bat.
    echo Please unzip the package completely before running the installer.
    pause
    exit /b 1
)

if /I not "%~1"=="--elevated" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs"
    if errorlevel 1 (
        echo ERROR: Unable to request administrator permission.
        pause
        exit /b 1
    )
    exit /b 0
)

if not exist "%PS1%" (
    echo ERROR: install.ps1 is missing.
    pause
    exit /b 1
)

echo Installing Chicken Leg Quick Assistant...
echo Source: %SRC%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo Installation failed with code %RC%.
    pause
    exit /b %RC%
)

echo.
echo Installation completed.
echo Open DaVinci Resolve Studio, then go to Workspace > Workflow Integrations > Chicken Leg Quick Assistant.
pause
