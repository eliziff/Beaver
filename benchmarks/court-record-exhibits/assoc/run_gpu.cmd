@echo off
cd /d C:\Users\elias\beaver-train\assoc
set "PYTHONUTF8=1"
set "HF_HUB_OFFLINE=1"
set "PY=C:\Users\elias\beaver-train\venv\Scripts\python.exe"
%PY% llm_mc.py Qwen/Qwen2.5-0.5B-Instruct q05f --dir f2l --rot 5 --shortlist oof_v4.npz --bs 4 > q05f.log 2>&1
%PY% llm_mc.py Qwen/Qwen2.5-1.5B-Instruct q15f --dir f2l --rot 5 --shortlist oof_v4.npz --bs 4 > q15f.log 2>&1
%PY% llm_mc.py Qwen/Qwen3-1.7B q17f --dir f2l --rot 5 --shortlist oof_v4.npz --bs 4 > q17f.log 2>&1
echo done > zs_done.txt
