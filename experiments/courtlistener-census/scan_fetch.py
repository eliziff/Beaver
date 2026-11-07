"""Harvard's scans of the given cases, once each, kept. Resumable: what is already on disk is not fetched again.

    python -I scan_fetch.py CLUSTERS SCANS_DIR [WORKERS] [PAUSE_SECONDS]

CLUSTERS has one cluster id a line. A case with no scan leaves an empty file, so that it is not asked for twice.
"""
import concurrent.futures, os, sys, time, urllib.error, urllib.request

clusters, scans = sys.argv[1:3]
workers = int(sys.argv[3]) if len(sys.argv) > 3 else 3
pause = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
wanted = [line.strip() for line in open(clusters, encoding="utf-8") if line.strip()]


def fetch(cluster):
    path = os.path.join(scans, f"{cluster}.pdf")
    if os.path.exists(path):
        return "held"
    request = urllib.request.Request(f"https://storage.courtlistener.com/harvard_pdf/{cluster}.pdf", headers={"User-Agent": "beaver-structure-check/1.0"})
    time.sleep(pause)
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(request, timeout=90).read()
            break
        except urllib.error.HTTPError as error:
            if error.code in (403, 404):
                data = b""
                break
            time.sleep(10 * (attempt + 1))
        except Exception:
            time.sleep(10 * (attempt + 1))
    else:
        return "failed"
    partial = path + ".part"
    with open(partial, "wb") as out:
        out.write(data)
    os.replace(partial, path)
    return "fetched" if data else "no scan"


counts = {}
with concurrent.futures.ThreadPoolExecutor(workers) as pool:
    for done, result in enumerate(pool.map(fetch, wanted), 1):
        counts[result] = counts.get(result, 0) + 1
        if done % 200 == 0:
            print(done, counts, flush=True)
print("SCANS-DONE", counts, flush=True)
