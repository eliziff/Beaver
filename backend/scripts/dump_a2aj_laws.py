"""Dump every English statute text from the A2AJ laws corpus to jsonl.

One row per statute: {id, text}. Used only as the input side of a
skeleton differential -- no structure is computed here.
"""
import glob, json, os, sys

import pyarrow.parquet as pq

root = os.path.join(os.environ["LOCALAPPDATA"], "ALR Quote Verifier", "a2aj_corpus", "laws")
out = sys.argv[1]
n = 0
with open(out, "w", encoding="utf-8", newline="\n") as fh:
    for path in sorted(glob.glob(os.path.join(root, "*", "*.parquet"))):
        juris = os.path.basename(os.path.dirname(path))
        table = pq.read_table(path, columns=["citation_en", "unofficial_text_en"])
        cites = table.column("citation_en").to_pylist()
        texts = table.column("unofficial_text_en").to_pylist()
        for i, (cite, text) in enumerate(zip(cites, texts)):
            if not text:
                continue
            fh.write(json.dumps({"id": f"{juris}:{i}:{cite or ''}", "text": text}) + "\n")
            n += 1
print("statutes written", n)
