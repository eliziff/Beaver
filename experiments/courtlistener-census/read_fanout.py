"""Have a model read opinions written out by sample_head.py, all at once.

    python -I read_fanout.py READING_DIR MODEL [CONCURRENCY]

Each opinion's fields and every rendition go into one prompt (no tools, so no file-opening turns)
for headless `claude -p --model MODEL`; the reading lands in READING_DIR/<MODEL>/<id>.md.
Opinions already read are skipped.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

INSTRUCTION = """You will be given one court opinion from CourtListener: its record fields, then every version ("rendition") of its text that CourtListener stores, exactly as stored (plain text, HTML or XML).

Read every rendition all the way through. Then write down everything about the document beyond plain running sentences: anything that organizes it, divides it, numbers it, labels it, marks it up, refers from one place to another, or identifies people, parts or pages. Use your own judgment about what counts. Don't limit yourself to any list. Include things that look odd or that you can't name.

For each thing you find, give:
- what it is, in your own words;
- an exact short quote or markup snippet showing it;
- which renditions show it, and which don't when they could;
- for markup, whether it is marked by tags or attributes, or appears only as text.

Then note where the renditions differ in what they show. Answer in Markdown, nothing else."""


def prompt_for(d):
    parts = [INSTRUCTION]
    for name in sorted(os.listdir(d)):
        with open(os.path.join(d, name), encoding="utf-8") as f:
            parts.append(f"===== {name} =====\n{f.read()}")
    parts.append("===== end of the opinion =====\n\nNow write the report described at the top, in Markdown, nothing else.")
    return "\n\n".join(parts)


def read_one(claude, model, d, out):
    t0 = time.time()
    r = subprocess.run([claude, "-p", "--model", model, "--disallowedTools", "*"],
                       input=prompt_for(d), capture_output=True, text=True, encoding="utf-8")
    ok = r.returncode == 0 and r.stdout.strip()
    with open(out if ok else out + ".err", "w", encoding="utf-8") as f:
        f.write(r.stdout if ok else f"exit {r.returncode}\n{r.stdout}\n{r.stderr}")
    return os.path.basename(d), bool(ok), round(time.time() - t0)


def main():
    root, model = sys.argv[1], sys.argv[2]
    conc = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    claude = shutil.which("claude.cmd") or shutil.which("claude")
    outdir = os.path.join(root, model)
    os.makedirs(outdir, exist_ok=True)
    jobs = [(os.path.join(root, i), os.path.join(outdir, f"{i}.md")) for i in sorted(os.listdir(root))
            if os.path.isfile(os.path.join(root, i, "fields.json")) and not os.path.exists(os.path.join(outdir, f"{i}.md"))]
    t0 = time.time()
    with ThreadPoolExecutor(conc) as ex:
        for res in ex.map(lambda j: read_one(claude, model, *j), jobs):
            print(json.dumps(res), flush=True)
    print(json.dumps({"model": model, "read": len(jobs), "seconds": round(time.time() - t0)}))


main()
