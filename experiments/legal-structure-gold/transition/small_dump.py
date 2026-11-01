"""A small dump: the first TRAIN train documents and DEV development ones of a dump, copied with their files.
python small_dump.py FROM STORE TO TRAIN DEV"""
import json, os, shutil, sys
src, store, dst, want_train, want_dev = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
os.makedirs(dst, exist_ok=True)
taken = {"train": 0, "development": 0}
for name in sorted(os.listdir(src)):
    if not name.endswith(".json") or name.endswith(".labels.json"):
        continue
    sha = name[:-5]
    try:
        split = json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"]
    except (OSError, KeyError, ValueError):
        continue
    if split not in taken or taken[split] >= (want_train if split == "train" else want_dev):
        continue
    taken[split] += 1
    for suffix in (".json", ".lines.f32", ".moves.f32"):
        if os.path.exists(os.path.join(src, sha + suffix)):
            shutil.copy(os.path.join(src, sha + suffix), os.path.join(dst, sha + suffix))
    if all(taken[k] >= (want_train if k == "train" else want_dev) for k in taken):
        break
print(taken)
