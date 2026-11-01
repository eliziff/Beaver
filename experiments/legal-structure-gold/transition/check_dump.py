"""Fails unless a dump folder holds a document for at least MINIMUM sources: a grade that stopped part way
(a panic) leaves a short dump, which must not be fitted on. python check_dump.py DUMP_DIR MINIMUM"""
import os, sys
folder, minimum = sys.argv[1], int(sys.argv[2])
found = sum(1 for name in os.listdir(folder) if name.endswith(".json") and not name.endswith(".labels.json")) if os.path.isdir(folder) else 0
print(f"{folder}: {found} documents (at least {minimum} wanted)")
sys.exit(0 if found >= minimum else 1)
