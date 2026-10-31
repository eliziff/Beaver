"""Whether two grader builds parse the same: for every document both dump folders hold (STRUCTURE_GOLD_DUMP of
each build's grade), the structure and pages compared byte for byte once decompressed, and where they
differ, the first differing JSON path. python identical.py DUMP_A DUMP_B [--paths N]"""
import gzip, json, os, sys, time
a_dir, b_dir = sys.argv[1], sys.argv[2]
show = int(sys.argv[sys.argv.index("--paths") + 1]) if "--paths" in sys.argv else 5
def first_difference(x, y, path="$"):
    if type(x) is not type(y):
        return f"{path}: {type(x).__name__} vs {type(y).__name__}"
    if isinstance(x, dict):
        for key in x.keys() | y.keys():
            if key not in x or key not in y:
                return f"{path}.{key}: only in {'a' if key in x else 'b'}"
        for key in x:
            found = first_difference(x[key], y[key], f"{path}.{key}")
            if found:
                return found
        if list(x) != list(y):
            return f"{path}: key order"
        return None
    if isinstance(x, list):
        for k, (p, q) in enumerate(zip(x, y)):
            found = first_difference(p, q, f"{path}[{k}]")
            if found:
                return found
        return f"{path}: length {len(x)} vs {len(y)}" if len(x) != len(y) else None
    return None if x == y else f"{path}: {str(x)[:60]!r} vs {str(y)[:60]!r}"
started = time.time()
names = sorted(set(os.listdir(a_dir)) & set(os.listdir(b_dir)))
same = differ = 0; shown = 0; paths = {}
for name in names:
    if not name.endswith(".json.gz"):
        continue
    x = gzip.open(os.path.join(a_dir, name)).read()
    y = gzip.open(os.path.join(b_dir, name)).read()
    if x == y:
        same += 1
        continue
    differ += 1
    where = first_difference(json.loads(x), json.loads(y))
    kind = name.split(".")[1]
    key = (kind, (where or "bytes only (same JSON)").split("[")[0].split(":")[0])
    paths[key] = paths.get(key, 0) + 1
    if shown < show:
        shown += 1
        print(f"  {name[:12]} {kind}: {where or 'bytes only (same JSON)'}")
print(f"{same} identical, {differ} differ, of {same + differ} files in both ({len(os.listdir(a_dir))} / {len(os.listdir(b_dir))}); {time.time() - started:.0f} s")
for key, n in sorted(paths.items(), key=lambda kv: -kv[1])[:15]:
    print(f"  {n:5d} {key[0]} {key[1]}")
