"""Pull document texts out of the A2AJ parquets by sweep id.

Sweep ids are "<COURT>:<citation>:<lang>". Joining back needs one query
per court (the parquets are big; BCSC is 916 MB) with an IN-list on the
citation column, so we batch by court and cache to a jsonl.

  python -X utf8 fetch_texts.py --ids ids.txt --out snap/texts.jsonl
  python -X utf8 fetch_texts.py --court BCCA --lang en --sample 400 \
      --out snap/bcca_sample.jsonl

READ-ONLY on the corpus.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")
HERE = Path(__file__).resolve().parent


def parse_id(doc_id: str) -> tuple[str, str, str]:
    court, rest = doc_id.split(":", 1)
    cite, lang = rest.rsplit(":", 1)
    return court, cite, lang


def fetch(con, court: str, lang: str, cites: list[str] | None, limit: int | None):
    pq = (A2AJ / "cases" / court / "train.parquet").as_posix()
    where = f"unofficial_text_{lang} is not null"
    params: list = []
    if cites:
        placeholders = ",".join("?" for _ in cites)
        where += f" and citation_{lang} in ({placeholders})"
        params = list(cites)
    sql = f"""
        select citation_{lang}, unofficial_text_{lang},
               document_date_{lang}, name_{lang}, url_{lang},
               len(cases_cited_{lang})
        from read_parquet('{pq}')
        where {where}
        {f'limit {limit}' if limit else ''}
    """
    for cite, text, date, name, url, cited in con.execute(sql, params).fetchall():
        yield {
            "id": f"{court}:{cite}:{lang}",
            "court": court,
            "lang": lang,
            "citation": cite,
            "date": str(date)[:10] if date else None,
            "name": name,
            "url": url,
            "cited_count": cited or 0,
            "text": text,
        }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", help="file of sweep ids, one per line")
    ap.add_argument("--court")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--sample", type=int)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    import duckdb

    con = duckdb.connect()
    out = Path(args.out)
    if not out.is_absolute():
        out = HERE / out
    out.parent.mkdir(parents=True, exist_ok=True)

    want: dict[tuple[str, str], list[str]] = {}
    if args.ids:
        idp = Path(args.ids)
        if not idp.is_absolute():
            idp = HERE / idp
        for line in idp.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            court, cite, lang = parse_id(line)
            want.setdefault((court, lang), []).append(cite)
    else:
        want[(args.court, args.lang)] = []

    n = 0
    with open(out, "w", encoding="utf-8") as fh:
        for (court, lang), cites in sorted(want.items()):
            got = 0
            for rec in fetch(con, court, lang, cites or None, args.sample):
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                got += 1
                n += 1
            print(f"{court}:{lang} -> {got} (asked {len(cites) or args.sample})",
                  flush=True)
    print(f"wrote {n} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
