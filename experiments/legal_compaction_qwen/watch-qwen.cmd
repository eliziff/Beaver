@echo off
setlocal
cd /d "%~dp0"

echo Show thinking traces too? [Y/N]
powershell.exe -NoLogo -NoProfile -Command "$key = [Console]::ReadKey($true).Key; if ($key -eq [ConsoleKey]::Y) { exit 0 }; exit 1"
if errorlevel 1 goto no_thinking

echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0watch_run.ps1" -Thinking
goto done

:no_thinking
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0watch_run.ps1"

:done
endlocal
