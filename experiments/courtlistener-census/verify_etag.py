"""Checks downloaded bulk files against S3's Content-Length and (multipart) ETag.

    python -I verify_etag.py DIR URL_BASE FILE...

A multipart ETag "<md5>-<N>" is md5(concat(md5(part_i))) over N equal parts; the part
size is the smallest whole MiB that splits the file into exactly N parts.
"""
import hashlib, json, os, sys, urllib.request

def head(url):
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"]), r.headers["ETag"].strip('"')

def etag_of(path, parts):
    size = os.path.getsize(path)
    if parts == 0:
        h = hashlib.md5()
        with open(path, "rb") as f:
            for b in iter(lambda: f.read(1 << 24), b""):
                h.update(b)
        return h.hexdigest()
    mib = 1 << 20
    part = -(-size // parts)
    part = -(-part // mib) * mib
    digests = []
    with open(path, "rb") as f:
        while True:
            h = hashlib.md5(); left = part
            while left:
                b = f.read(min(left, 1 << 24))
                if not b:
                    break
                h.update(b); left -= len(b)
            if left == part:
                break
            digests.append(h.digest())
            if left:
                break
    if len(digests) != parts:
        return f"part-count {len(digests)} != {parts} (part size {part})"
    return hashlib.md5(b"".join(digests)).hexdigest() + f"-{parts}"

out = []
for name in sys.argv[3:]:
    size, etag = head(sys.argv[2] + name)
    path = os.path.join(sys.argv[1], name)
    local = os.path.getsize(path)
    parts = int(etag.split("-")[1]) if "-" in etag else 0
    got = etag_of(path, parts) if local == size else None
    rec = {"file": name, "s3_bytes": size, "local_bytes": local, "s3_etag": etag, "local_etag": got, "ok": got == etag}
    print(json.dumps(rec), flush=True)
    out.append(rec)
sys.exit(0 if all(r["ok"] for r in out) else 1)
