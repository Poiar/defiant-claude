@echo off
where pwsh >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: PowerShell 7+ (pwsh) is required. Install from https://github.com/PowerShell/PowerShell
    exit /b 1
)
pwsh -NoLogo -File "%~dp0defiant.ps1" %*
exit /b %ERRORLEVEL%
