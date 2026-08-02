@echo off
setlocal
cd /d "%~dp0"

choice /c YN /n /m "Show thinking traces too? [Y/N] "
if errorlevel 2 goto no_thinking

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0watch_run.ps1" -Thinking
goto done

:no_thinking
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0watch_run.ps1"

:done
endlocal
