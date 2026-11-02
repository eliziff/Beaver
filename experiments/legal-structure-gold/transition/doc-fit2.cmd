@echo off
rem Detect-Order-Construct fitted on the regenerated gold's dump (lines2): the region heads' pair terms, the
rem reading-order head, the trees' gaps; development each epoch, the best checkpoint kept.
cd /d C:\Users\elias\fable\joint
C:\Users\elias\beaver-train\venv\Scripts\python.exe -u -W ignore docparse.py fit C:\Users\elias\fable\doc\lines2 C:\Users\elias\gold-store\gold C:\Users\elias\fable\doc\model2 > C:\Users\elias\AppData\Local\OpenLegalData\gold-grades\doc-fit2.out 2>&1
