"""Sources ledger: every document pulled for the benchmark, where from, and what became of it.

Usage: python ledger.py            rebuild sources-ledger.jsonl and print the breadth summary
       python ledger.py --summary  summary only

Rows come from the records themselves: each record's source PDF
(source.json) and its same-matter documents (matter_docs.json). Sources
tried and rejected are appended by whoever rejects them to
rejected-sources.jsonl, one JSON object per line:
  {"url": ..., "site": ..., "court": ..., "reason": ..., "date": "YYYY-MM-DD", "by": ...}
and are merged in. The summary counts records by court, jurisdiction, level,
subject and site, so the gaps in breadth are visible.
"""
import collections, json, os, re, sys
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "records")  # the committed JSON copies (gold, source, split, matter_docs)
site = lambda url: (urlparse(url).netloc or "local").removeprefix("www.")
INSOLVENCY = re.compile(r"\b(CCAA|BIA|receiver|receivership|bankrupt|insolven|proposal|monitor|creditors)", re.I)


def rows():
    out = []
    for rid in sorted(os.listdir(ROOT)):
        g, s = os.path.join(ROOT, rid, "gold.json"), os.path.join(ROOT, rid, "source.json")
        if not os.path.exists(g):
            continue
        gold, src = json.load(open(g, encoding="utf-8")), json.load(open(s, encoding="utf-8")) if os.path.exists(s) else {}
        url = src.get("url") or src.get("landing_url") or ""
        base = {"record": rid, "court": gold.get("court", ""), "jurisdiction": gold.get("jurisdiction", ""),
                "level": gold.get("court_level", ""), "court_file": gold.get("court_file", ""), "family": gold.get("family", ""),
                "subject": gold.get("subject") or ("insolvency" if INSOLVENCY.search(gold.get("proceeding", "") + " " + gold.get("document", "")) else "other")}
        out.append({**base, "use": "record_source", "url": url, "landing_url": src.get("landing_url", ""), "site": site(url),
                    "sha256": src.get("source_sha256", ""), "retrieved": src.get("retrieved", ""), "title": src.get("document_title", gold.get("document", ""))[:200],
                    "exhibits": len(gold["exhibits"]), "events": len(gold["events"])})
        md = os.path.join(ROOT, rid, "matter_docs.json")
        for m in json.load(open(md, encoding="utf-8")) if os.path.exists(md) else []:
            out.append({**base, "use": "matter_doc", "url": m.get("url", ""), "site": site(m.get("url", "")), "title": m.get("title", "")[:200],
                        "kind": m.get("kind", ""), "relation": m.get("relation", "")})
    rej = os.path.join(HERE, "rejected-sources.jsonl")
    for line in open(rej, encoding="utf-8") if os.path.exists(rej) else []:
        if line.strip():
            r = json.loads(line)
            out.append({"use": "rejected", "site": site(r.get("url", "")), **r})
    return out


def summary(ledger):
    recs = [r for r in ledger if r["use"] == "record_source"]
    print(f"{len(recs)} records; {sum(r['use'] == 'matter_doc' for r in ledger)} matter documents; {sum(r['use'] == 'rejected' for r in ledger)} rejected sources logged")
    bench = lambda c: re.sub(r"\s*\(.*?\)|,.*$", "", c).strip()  # "Court of King's Bench of Manitoba, Winnipeg Centre" -> the court
    for key in ("jurisdiction", "level", "subject", "court", "site"):
        c = collections.Counter((bench(r[key]) if key == "court" else r[key]) or "?" for r in recs)
        print(f"\nby {key} ({len(c)}):", ", ".join(f"{k} {v}" for k, v in c.most_common()))
    fams = collections.Counter(r["family"] for r in recs if r["family"])
    print(f"\nfamilies: {len(fams)} ({sum(fams.values())} records)")


if __name__ == "__main__":
    ledger = rows()
    if "--summary" not in sys.argv:
        with open(os.path.join(HERE, "sources-ledger.jsonl"), "w", encoding="utf-8") as f:
            for r in ledger:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    summary(ledger)
