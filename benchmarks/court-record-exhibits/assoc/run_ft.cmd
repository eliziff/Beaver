@echo off
cd /d C:\Users\elias\beaver-train\assoc
set "PYTHONUTF8=1"
set "HF_HUB_OFFLINE=1"
set "PY=C:\Users\elias\beaver-train\venv\Scripts\python.exe"
%PY% mc_ft.py Qwen/Qwen2.5-0.5B-Instruct ft05 --epochs 1 --shortlist oof_v4.npz > ft05.log 2>&1
echo done > ft_done.txt
