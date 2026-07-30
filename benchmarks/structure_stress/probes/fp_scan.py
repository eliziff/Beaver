"""False-positive scan of structure CLAIMS before any big sweep.

Doctrine (Eli, 2026-07-29): vet misses, prove performance — and scan
for false positives — before a corpus-scale run. The miss vet asked
"did we call structure absent when it was there?"; this probe asks the
converse: when the cascade CLAIMS paragraphs / endnotes / pages, is
the claim addressable-structure-true? A wrong claim is worse than a
miss — pinpoint resolution would silently address the wrong text.

Populations:
  vetted  — every kind!=none claim from probes/snap/vet_misses.jsonl
            (the ladder_broken->paragraphs flips and the endnote
            recoveries are the least-trusted verdicts we have);
  fresh   — reservoir sample per court parquet (seeded), for
            corpus-wide screen rates plus page-claim sightings;
  laws    — reservoir sample per law set, scored against the
            unofficial_sections oracle: true precision per detector,
            with the actual false-positive labels dumped for reading.

Screens are queues for close reading, never verdicts. Single-threaded
by design (throttle rules).

    python -X utf8 probes/fp_scan.py [--fresh-per-court 20] [--laws-per-set 8]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from structure_ref import (  # noqa: E402
    endnote_index,
    law_section_labels,
    paragraph_index,
    structure_cascade,
)

A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")
MAX_DOC_CHARS = 8_000_000
QUOTE_OR_COLON = ('"', "\u201c", "\u00ab", "\u2018", "'", ":")


def _prev_line_tail(text: str, offset: int) -> str:
    nl = text.rfind("\n", 0, offset)
    if nl <= 0:
        return ""
    return text[max(0, nl - 3):nl].strip()[-1:]


def screen_case(text: str, citation: str) -> tuple[dict, list[str], list[str]]:
    """Run the cascade, then FP screens on whatever it claimed."""
    claim = dict(structure_cascade(text, citation))
    kind = claim["kind"]
    suspects: list[str] = []
    entries: list = []
    if kind == "paragraphs":
        entries = paragraph_index(text)  # lru-cached; free after cascade
        first, last = entries[0][0], entries[-1][0]
        coverage = len(entries) / max(1, last - first + 1)
        terminal = entries[-1][1] / max(1, len(text))
        lead_hits = sum(
            1 for e in entries if _prev_line_tail(text, e[1]) in QUOTE_OR_COLON
        )
        claim.update(coverage=round(coverage, 3), terminal_ratio=round(terminal, 3),
                     lead_hits=lead_hits)
        if coverage < 0.85:
            suspects.append("para_coverage_gaps")
        if first > 5:
            suspects.append("para_late_first")
        if terminal < 0.60:
            suspects.append("para_early_stop")
        if lead_hits / len(entries) > 0.30:
            suspects.append("para_quote_colon_leads")
    elif kind == "endnotes":
        entries = endnote_index(text)
        first, last = entries[0][0], entries[-1][0]
        coverage = len(entries) / max(1, last - first + 1)
        words = statistics.median(len(e[3].split()) for e in entries)
        claim.update(coverage=round(coverage, 3),
                     start_ratio=round(entries[0][1] / max(1, len(text)), 3),
                     median_words_approx=round(words, 1))
        if first > 2:
            suspects.append("endnote_late_first")
        if coverage < 0.80:
            suspects.append("endnote_gaps")
    elif kind == "pages":
        coverage = claim["count"] / max(1, claim["last"] - claim["first"] + 1)
        claim.update(coverage=round(coverage, 3))
        if coverage < 0.90:
            suspects.append("page_gaps")
        if not claim.get("reporter_anchored"):
            suspects.append("page_unanchored")
    excerpts = []
    if suspects and entries:
        picks = entries[:2] + (entries[-2:] if len(entries) > 2 else [])
        excerpts = [f"[{e[0]}] {e[3][:110]!r}" for e in picks]
    return claim, suspects, excerpts


def fetch_texts(con, court: str, lang: str, citations: list[str]):
    pq = (A2AJ / "cases" / court / "train.parquet").as_posix()
    for i in range(0, len(citations), 400):
        chunk = citations[i:i + 400]
        marks = ",".join("?" for _ in chunk)
        yield from con.execute(
            f"""
            select citation_{lang}, unofficial_text_{lang}
            from read_parquet('{pq}')
            where citation_{lang} in ({marks})
            """,
            chunk,
        ).fetchall()


def scan_vetted(con, sink, stats: dict) -> None:
    vet = HERE / "snap" / "vet_misses.jsonl"
    if not vet.exists():
        print("warning: no vet_misses.jsonl; skipping vetted population",
              file=sys.stderr)
        return
    wanted: dict[tuple[str, str], list[str]] = {}
    for line in open(vet, encoding="utf-8"):
        row = json.loads(line)
        if row["cascade"]["kind"] == "none":
            continue
        court, rest = row["id"].split(":", 1)
        citation, lang = rest.rsplit(":", 1)
        wanted.setdefault((court, lang), []).append(citation)
    for (court, lang), citations in sorted(wanted.items()):
        for citation, text in fetch_texts(con, court, lang, citations):
            record_case(sink, stats, "vetted", court, lang, citation, text)


def scan_fresh(con, sink, stats: dict, per_court: int) -> None:
    courts = sorted(p.parent.name for p in (A2AJ / "cases").glob("*/train.parquet"))
    for court in courts:
        pq = (A2AJ / "cases" / court / "train.parquet").as_posix()
        for lang in ("en", "fr"):
            try:
                sample = con.execute(
                    f"""
                    select citation_{lang} from read_parquet('{pq}')
                    where citation_{lang} is not null
                      and unofficial_text_{lang} is not null
                    using sample reservoir({per_court} rows) repeatable (42)
                    """
                ).fetchall()
            except Exception:
                continue
            citations = [row[0] for row in sample]
            if not citations:
                continue
            for citation, text in fetch_texts(con, court, lang, citations):
                record_case(sink, stats, "fresh", court, lang, citation, text)


def record_case(sink, stats, pop, court, lang, citation, text) -> None:
    text = text or ""
    if len(text) > MAX_DOC_CHARS:
        text = text[:MAX_DOC_CHARS]
    claim, suspects, excerpts = screen_case(text, citation)
    stats[pop]["kinds"][claim["kind"]] += 1
    for s in suspects:
        stats[pop]["suspects"][s] += 1
    stats[pop]["docs"] += 1
    if suspects:
        stats[pop]["suspect_docs"] += 1
        sink.write(json.dumps({
            "pop": pop, "id": f"{court}:{citation}:{lang}",
            "chars": len(text), "claim": claim,
            "suspects": suspects, "excerpts": excerpts,
        }, ensure_ascii=False) + "\n")


def scan_laws(con, per_set: int) -> dict:
    sets = sorted(p.parent.name for p in (A2AJ / "laws").glob("*/train.parquet"))
    micro: dict[str, Counter] = {}
    fp_examples: dict[str, Counter] = {}
    combined_recs: list[float] = []
    docs = 0
    for name in sets:
        pq = (A2AJ / "laws" / name / "train.parquet").as_posix()
        for lang in ("en", "fr"):
            try:
                rows = con.execute(
                    f"""
                    select citation_{lang}, unofficial_text_{lang},
                           unofficial_sections_{lang}
                    from read_parquet('{pq}')
                    where unofficial_text_{lang} is not null
                    using sample reservoir({per_set} rows) repeatable (42)
                    """
                ).fetchall()
            except Exception:
                continue
            for _cite, text, sections_json in rows:
                try:
                    want = set(json.loads(sections_json or "{}").keys())
                except (json.JSONDecodeError, TypeError, AttributeError):
                    want = set()
                if not want:
                    continue
                text = (text or "")[:MAX_DOC_CHARS]
                detected = law_section_labels(text)
                docs += 1
                combined = (detected["alr_ext"] | detected["bold"]
                            | detected["ranges"] | detected["named"])
                combined_recs.append(len(want & combined) / len(want))
                for det, found in {**detected, "combined": combined}.items():
                    bucket = micro.setdefault(det, Counter())
                    bucket["tp"] += len(want & found)
                    bucket["fp"] += len(found - want)
                    bucket["fn"] += len(want - found)
                    if found - want:
                        ex = fp_examples.setdefault(det, Counter())
                        for label in list(found - want)[:4]:
                            ex[label] += 1
    return {"docs": docs, "micro": micro, "fp_examples": fp_examples,
            "combined_recs": combined_recs}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fresh-per-court", type=int, default=20)
    parser.add_argument("--laws-per-set", type=int, default=8)
    parser.add_argument("--skip-vetted", action="store_true")
    parser.add_argument("--out", default="probes/snap/fp_scan.jsonl")
    args = parser.parse_args()

    import duckdb

    con = duckdb.connect()
    out_path = HERE.parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    stats = {pop: {"docs": 0, "suspect_docs": 0, "kinds": Counter(),
                   "suspects": Counter()} for pop in ("vetted", "fresh")}

    with open(out_path, "w", encoding="utf-8") as sink:
        if not args.skip_vetted:
            scan_vetted(con, sink, stats)
            print(f"[vetted] {stats['vetted']['docs']} claims screened", flush=True)
        scan_fresh(con, sink, stats, args.fresh_per_court)
        print(f"[fresh] {stats['fresh']['docs']} docs screened", flush=True)

    for pop in ("vetted", "fresh"):
        s = stats[pop]
        if not s["docs"]:
            continue
        print(f"\n== {pop}: {s['docs']} docs, "
              f"{s['suspect_docs']} suspect ({s['suspect_docs'] / s['docs']:.1%})")
        print("   kinds:", dict(s["kinds"].most_common()))
        print("   suspect screens:", dict(s["suspects"].most_common()))

    laws = scan_laws(con, args.laws_per_set)
    print(f"\n== laws: {laws['docs']} docs with section oracle")
    if laws["combined_recs"]:
        print(f"   combined recall mean={statistics.mean(laws['combined_recs']):.3f} "
              f"median={statistics.median(laws['combined_recs']):.3f}")
    for det, c in sorted(laws["micro"].items()):
        denom_p = c["tp"] + c["fp"]
        denom_r = c["tp"] + c["fn"]
        prec = c["tp"] / denom_p if denom_p else None
        rec = c["tp"] / denom_r if denom_r else None
        flag = "  <-- FP-heavy" if prec is not None and prec < 0.90 else ""
        print(f"   {det:12s} prec={prec if prec is None else round(prec, 3)!s:>6} "
              f"rec={rec if rec is None else round(rec, 3)!s:>6} "
              f"(tp={c['tp']} fp={c['fp']} fn={c['fn']}){flag}")
        examples = laws["fp_examples"].get(det)
        if examples and prec is not None and prec < 0.98:
            top = ", ".join(f"{label!r}x{n}" for label, n in examples.most_common(6))
            print(f"                FP labels: {top}")

    print(f"\nsuspect detail: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
