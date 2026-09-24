@echo off
rem usage: run_peft.cmd <log name> <mc_peft.py args...>
cd /d C:\Users\elias\beaver-train\assoc
set "PYTHONUTF8=1"
set "HF_HUB_OFFLINE=1"
set "PY=C:\Users\elias\beaver-train\venv\Scripts\python.exe"
set "LOG=%1"
set "ARGS="
shift
:loop
if "%~1"=="" goto run
set "ARGS=%ARGS% %1"
shift
goto loop
:run
%PY% mc_peft.py %ARGS% > %LOG% 2>&1
echo done > %LOG%.done
