@echo off
setlocal
cd /d "%~dp0experiments\legal_compaction_qwen"
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0experiments\legal_compaction_qwen\watch_run.ps1"
