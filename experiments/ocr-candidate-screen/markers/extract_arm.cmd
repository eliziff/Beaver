@echo off
rem extract_arm.cmd ARM : runs the lsg-v4 extract.mjs batch for structure-ab\jobs-ARM.json with the pinned addon
set LEGAL_STRUCTURE_ADDON=C:\Users\elias\Desktop\oajd_compute\lsg-v4\native\legal-structure-node\target\release\legal_structure_node.867a0f8ef4abd2b4b5d5fe5b2b2838332525317871cb2de3a7c6862085fd440a.dll
cd /d C:\Users\elias\Desktop\oajd_compute\lsg-v4
node experiments\legal-structure-gold\extract.mjs --batch C:\Users\elias\beaver-train\markers\structure-ab\%1 > C:\Users\elias\beaver-train\markers\structure-ab\%~n1.log 2> C:\Users\elias\beaver-train\markers\structure-ab\%~n1.err
