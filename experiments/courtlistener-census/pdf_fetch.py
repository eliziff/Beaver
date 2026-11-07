"""Named court PDFs from CourtListener's public storage, once each, kept. Targeted: never a folder sync, which costs Free Law Project money.

    python -I pdf_fetch.py LIST.jsonl OUT_DIR [HOW_MANY] [PAUSE_SECONDS]

LIST has {"id": opinion, "path": local_path}, a line each. Resumable.
"""
import json, os, sys, time, urllib.error, urllib.request

listing, out = sys.argv[1:3]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
pause = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
os.makedirs(out, exist_ok=True)
counts = {}
for number, line in enumerate(open(listing, encoding="utf-8")):
    if number >= limit:
        break
    row = json.loads(line)
    target = os.path.join(out, row["id"] + ".pdf")
    if os.path.exists(target):
        counts["held"] = counts.get("held", 0) + 1
        continue
    try:
        data = urllib.request.urlopen(urllib.request.Request("https://storage.courtlistener.com/" + row["path"], headers={"User-Agent": "beaver-structure-check/1.0"}), timeout=90).read()
        state = "fetched"
    except urllib.error.HTTPError as error:
        if error.code in (429, 503):
            # Told to slow down: no file, and a long wait that grows each time it is said.
            counts["told to slow down"] = counts.get("told to slow down", 0) + 1
            pause = min(pause * 2, 60)
            time.sleep(max(int(error.headers.get("Retry-After") or 0), 120))
            continue
        data, state = b"", f"http {error.code}"
    except Exception:
        counts["failed"] = counts.get("failed", 0) + 1
        time.sleep(5)
        continue
    partial = target + ".part"
    with open(partial, "wb") as sheet:
        sheet.write(data)
    os.replace(partial, target)
    counts[state] = counts.get(state, 0) + 1
    if number % 100 == 0:
        print(number, counts, flush=True)
    time.sleep(pause)
print("PDFS-DONE", counts, flush=True)
