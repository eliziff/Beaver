@echo off
rem Usage: run_xenc.cmd <log name> <xenc.py args...>
cd /d C:\Users\elias\beaver-train\assoc
set "PYTHONUTF8=1"
set "HF_HUB_OFFLINE=1"
set "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"
set "LOG=%1"
shift
set "A="
:loop
if "%~1"=="" goto run
set "A=%A% %1"
shift
goto loop
:run
C:\Users\elias\beaver-train\venv\Scripts\python.exe xenc.py %A% > %LOG% 2>&1
echo done >> %LOG%.done
