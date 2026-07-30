"""Harvest REAL extraction-layer text for the vacuously-covered entries.

Six grammar-table entries match zero spans on document-level prose. Each
is fed, in production, a string of a particular GRANULARITY:

  label.pure            core.py:1249/1270  a single span's candidate text
  label.superscript     core.py:1290       a line carrying U+00B9-class glyphs
  marker.inline-fn      core.py:1724/1742  Paragraph.text after FN inlining
  bracket.editorial     det_citations:199  a trailing bracket's INTERIOR
  attach.link           det_citations:163  the gap between two anchors
  trap.double-zero-width core.py:170       raw fitz span text, pre-normalise

So the fix for vacuous coverage is granularity, not volume. Every row
this script writes is a verbatim slice of a real document or a token a
production function emitted from one. Nothing is synthesised.

  python -X utf8 probes/journal_harvest_extraction_text.py

Writes <out>.jsonl with BOTH a "footnote_text" and an "input" key per
row (grammar_differential reads footnote_text via --jsonl and input via
--harvest; there is no generic field fallback), plus provenance fields.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import zipfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORK = HERE.parent.parent.parent
ENGINE_SRC = FORK / "universal-legal-pdf-engine" / "src"
PRIVATE_SOURCES = FORK / "benchmarks" / "docx_corpus" / "private_sources"
PATHOLOGY_DIR = FORK / "backend" / "src" / "lib" / "__tests__" / "fixtures" / "docx-pathologies"
PILOT = FORK / "universal-legal-pdf-engine" / "_temp" / "docx_upstream_pilot"
BENCH_OUT = FORK / "universal-legal-pdf-engine" / "benchmark-output"
CASES_JSONL = (
    FORK / "benchmarks" / "docx_corpus" / "private_results" / "local" / "cases.private.jsonl"
)
PUBLIC_ENDPOINT_DB = Path(
    r"C:\Users\elias\AppData\Local\ALR Quote Verifier\data\public_endpoint-424c9f516423.db"
)

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SUPERSCRIPT_DIGITS = "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079"
SUP_RE = re.compile(f"[{SUPERSCRIPT_DIGITS}]")
BRACKET_RE = re.compile(r"\[([^\[\]\n]{1,60})\]")


# ── docx extraction (python-docx has no footnote API; go via the zip) ──


def para_text(paragraph, ns_sup: list[bool]) -> str:
    """Text of one w:p, tabs/breaks preserved, w:delText excluded.

    ns_sup collects whether any run in the paragraph is superscript, so
    the caller can tell a superscript FOOTNOTE REFERENCE (a run
    property) from a superscript GLYPH (a codepoint) -- the distinction
    that decides whether label.superscript can ever fire on docx text.
    """
    parts: list[str] = []
    for run in paragraph.iter():
        tag = run.tag
        if tag == f"{W}t":
            parts.append(run.text or "")
        elif tag == f"{W}tab":
            parts.append("\t")
        elif tag in (f"{W}br", f"{W}cr"):
            parts.append("\n")
        elif tag == f"{W}noBreakHyphen":
            parts.append("-")
        elif tag in (f"{W}footnoteReference", f"{W}endnoteReference"):
            # the reference itself carries no text; the engine is what
            # substitutes a marker here, so leave the position empty
            continue
        elif tag == f"{W}vertAlign":
            if (run.get(f"{W}val") or "") == "superscript":
                ns_sup.append(True)
    return "".join(parts)


def read_docx_parts(path: Path) -> dict:
    """Body / footnote / endnote paragraph text from one docx."""
    from lxml import etree

    out = {"body": [], "footnotes": [], "endnotes": [], "sup_runs": 0, "sup_glyphs": 0}
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        for part, key in (
            ("word/document.xml", "body"),
            ("word/footnotes.xml", "footnotes"),
            ("word/endnotes.xml", "endnotes"),
        ):
            if part not in names:
                continue
            tree = etree.fromstring(zf.read(part))
            for paragraph in tree.iter(f"{W}p"):
                sup: list[bool] = []
                text = para_text(paragraph, sup)
                out["sup_runs"] += len(sup)
                if text.strip():
                    out[key].append(text)
                    out["sup_glyphs"] += len(SUP_RE.findall(text))
    return out


# ── rows ──────────────────────────────────────────────────────────────


class Harvest:
    def __init__(self, cap: int) -> None:
        self.rows: list[dict] = []
        self.cap = cap
        self.per_gran: Counter = Counter()
        self.seen: set[str] = set()

    def add(self, text: str, gran: str, src: str) -> None:
        text = text.strip("\n")
        if not text.strip() or len(text) > 20000:
            return
        if self.per_gran[gran] >= self.cap:
            return
        key = f"{gran}\x00{text}"
        if key in self.seen:
            return
        self.seen.add(key)
        self.per_gran[gran] += 1
        self.rows.append(
            {"footnote_text": text, "input": text, "granularity": gran, "source": src}
        )


def harvest_docx(h: Harvest, files: list[Path], tag: str) -> dict:
    stats = {"files": 0, "body": 0, "footnotes": 0, "endnotes": 0,
             "sup_runs": 0, "sup_glyphs": 0, "bracket_interiors": 0, "label_paras": 0}
    for path in sorted(files):
        try:
            parts = read_docx_parts(path)
        except Exception as error:  # noqa: BLE001
            print(f"  ! {path.name}: {type(error).__name__}: {error}")
            continue
        stats["files"] += 1
        stats["sup_runs"] += parts["sup_runs"]
        stats["sup_glyphs"] += parts["sup_glyphs"]
        src = f"{tag}:{path.name}"
        for key, gran in (
            ("body", "docx.body.para"),
            ("footnotes", "docx.footnote.para"),
            ("endnotes", "docx.endnote.para"),
        ):
            for text in parts[key]:
                stats[key] += 1
                h.add(text, gran, src)
                # real bracket interiors, verbatim slices
                for match in BRACKET_RE.finditer(text):
                    interior = match.group(1).strip()
                    if interior:
                        stats["bracket_interiors"] += 1
                        h.add(interior, "docx.bracket.interior", src)
                # a paragraph that IS a bare label (real, not synthesised)
                if len(text.strip()) <= 4 and re.fullmatch(r"[\d*\u2020\u2021\u00a7\u00b6#]{1,4}", text.strip()):
                    stats["label_paras"] += 1
                    h.add(text.strip(), "docx.label.token", src)
        print(f"  {path.name}: body={len(parts['body'])} fn={len(parts['footnotes'])} "
              f"en={len(parts['endnotes'])} sup_runs={parts['sup_runs']} "
              f"sup_glyphs={parts['sup_glyphs']}", flush=True)
    return stats


def harvest_engine_artifacts(h: Harvest) -> dict:
    """Paragraph.text carrying the FN sentinel + engine-emitted labels."""
    stats = {"paragraph_files": 0, "sentinel_paras": 0, "labels": 0, "footnote_bodies": 0}
    for root in (PILOT, BENCH_OUT):
        for path in sorted(root.glob("**/paragraphs.jsonl")):
            stats["paragraph_files"] += 1
            src = f"engine:{path.relative_to(FORK).as_posix()}"
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = row.get("text") or ""
                if "\u27e6FN:" in text:
                    stats["sentinel_paras"] += 1
                    h.add(text, "engine.paragraph.text", src)
                for anchor in row.get("anchors") or ():
                    label = str(anchor.get("label") or "").strip()
                    if label:
                        stats["labels"] += 1
                        h.add(label, "engine.label.token", src)
        for path in sorted(root.glob("**/footnotes.jsonl")):
            src = f"engine:{path.relative_to(FORK).as_posix()}"
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                body = row.get("body") or ""
                if body.strip():
                    stats["footnote_bodies"] += 1
                    h.add(body, "engine.footnote.body", src)
                label = str(row.get("label") or "").strip()
                if label:
                    stats["labels"] += 1
                    h.add(label, "engine.label.token", src)
    return stats


def harvest_superscript_lines(h: Harvest, cap: int) -> dict:
    """Real lines whose text carries genuine superscript CODEPOINTS."""
    stats = {"articles_scanned": 0, "lines": 0}
    if not PUBLIC_ENDPOINT_DB.is_file():
        print("  ! journals db not present")
        return stats
    con = sqlite3.connect(PUBLIC_ENDPOINT_DB)
    rows = con.execute(
        "select article_id, text from articles "
        "where text is not null and length(text) > 200 order by article_id"
    )
    for article_id, text in rows:
        stats["articles_scanned"] += 1
        if not SUP_RE.search(text):
            continue
        for line in text.splitlines():
            if SUP_RE.search(line):
                stats["lines"] += 1
                h.add(line, "journal.superscript.line", f"journals:article_{article_id}")
        if stats["lines"] >= cap:
            break
    con.close()
    return stats


def harvest_engine_granularity(h: Harvest, texts: list[str], tag: str) -> dict:
    """Run the engine's OWN functions over real text and keep what they feed.

    _anchors() gaps (the string attach.link fullmatches) and the
    trailing-bracket interiors (the string bracket.editorial matches).
    """
    sys.path.insert(0, str(ENGINE_SRC))
    import legalpdf.deterministic_citations as det  # noqa: PLC0415

    stats = {"texts": 0, "gaps": 0, "url_gaps": 0, "trailing_interiors": 0}
    for text in texts:
        stats["texts"] += 1
        try:
            anchors = det._anchors(text)
        except Exception:  # noqa: BLE001
            anchors = []
        for previous, current in zip(anchors, anchors[1:]):
            gap = text[previous[1]:current[0]]
            if not gap:
                continue
            stats["gaps"] += 1
            if current[2] == "url":
                stats["url_gaps"] += 1
                h.add(gap, "engine.anchor.gap.url", tag)
            else:
                h.add(gap, "engine.anchor.gap", tag)
        match = det._TRAILING_SHORT_FORM_RE.search(text)
        if match:
            value = (match.group(1) or "").strip()
            if value:
                stats["trailing_interiors"] += 1
                h.add(value, "engine.trailing.bracket.interior", tag)
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path,
                    default=HERE / "snap" / "journal_extraction_vectors.jsonl")
    ap.add_argument("--cap", type=int, default=1500, help="max rows per granularity")
    ap.add_argument("--cases-cap", type=int, default=4000)
    ap.add_argument(
        "--pathology-dir",
        type=Path,
        default=PATHOLOGY_DIR,
        help="where the built pathology .docx live (they are built at test "
        "time, not committed; emit them with buildPathologyFixtures)",
    )
    args = ap.parse_args()

    h = Harvest(args.cap)
    report: dict = {}

    print("[a] docx pathology fixtures")
    pathology = sorted(args.pathology_dir.glob("*.docx"))
    if not pathology:
        print(f"  none present: {args.pathology_dir} holds only "
              f"{[p.name for p in args.pathology_dir.iterdir()]} "
              "-- fixtures are BUILT at test time, not committed")
    report["pathology"] = harvest_docx(h, pathology, "pathology") if pathology else {"files": 0}

    print("[b] real briefs")
    report["briefs"] = harvest_docx(h, sorted(PRIVATE_SOURCES.glob("*.docx")), "brief")

    print("[c] engine artifacts (FN sentinel + emitted labels)")
    report["engine"] = harvest_engine_artifacts(h)
    print(f"  {report['engine']}")

    print("[d] real journal lines carrying superscript codepoints")
    report["superscript"] = harvest_superscript_lines(h, args.cap)
    print(f"  {report['superscript']}")

    print("[e] engine granularity over real footnote text")
    case_texts: list[str] = []
    if CASES_JSONL.is_file():
        for line in CASES_JSONL.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line).get("footnote_text")
            except json.JSONDecodeError:
                continue
            if isinstance(value, str) and value.strip():
                case_texts.append(value)
            if len(case_texts) >= args.cases_cap:
                break
    docx_footnotes = [
        row["footnote_text"] for row in h.rows
        if row["granularity"] in ("docx.footnote.para", "docx.endnote.para")
    ]
    report["granularity_cases"] = harvest_engine_granularity(h, case_texts, "cases.private.jsonl")
    report["granularity_docx"] = harvest_engine_granularity(h, docx_footnotes, "brief-footnotes")
    print(f"  cases: {report['granularity_cases']}")
    print(f"  docx:  {report['granularity_docx']}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        for row in h.rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    report["rows"] = len(h.rows)
    report["per_granularity"] = dict(h.per_gran.most_common())
    (args.out.with_suffix(".report.json")).write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"\n{len(h.rows)} rows -> {args.out}")
    for gran, count in h.per_gran.most_common():
        print(f"  {gran:34} {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
