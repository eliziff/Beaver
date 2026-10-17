"""Decode a .bz2 to stdout in parallel, starting at a decoded byte offset (resume without re-piping).

    python -I bz2cat.py FILE PARALLELIZATION SKIP_BYTES
"""
import sys
import indexed_bzip2

path, parallel, skip = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
with indexed_bzip2.open(path, parallelization=parallel) as f:
    if skip:
        f.seek(skip)
        if f.tell() != skip:
            sys.exit(f"seek landed at {f.tell()}, not {skip}")
    out = sys.stdout.buffer
    while True:
        b = f.read(4 << 20)
        if not b:
            break
        out.write(b)
    out.flush()
