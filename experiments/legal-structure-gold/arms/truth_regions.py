"""Score model-authored structure golds against the human journal manual gold.

  python truth_regions.py MANIFEST [--runs a b ...] [--gold BUNDLE] [--out JSON]
  python truth_regions.py --build-truth-store DIR MANIFEST [--parsed DIR] [--limit N]

Each RUN is the gold store's golds of that run (experiments/legal_pdf_corpus/gold_store.py:
structure/<batch>-<run>/; run a, the current gold, by default; other letters are model trials). MANIFEST is
journal_manifest.json: each document's truth_pages name a PageXML page of the 661-page eScriptorium
manual gold (human-corrected lines in human reading order, inside typed regions) and its physical
PDF page.

Alignment, per truth page: each human line is matched to the gold line on that PDF page that shares
the most characters with it (rapidfuzz partial_ratio_alignment over accent-stripped, case-folded,
whitespace-collapsed text; ties to the closer whole-line ratio, then to a line not matched yet, then
to the one after the previous match); a match needs a score of 60 and 40% of the human line's
characters. When that line holds under 90% of the human line, the window is sought again over it
and its two neighbours (an extraction that split the human line). The window's offsets give the
typed lines that cover it (the typed spans), the majority by characters giving the human line's
region and unit. Reported per store:

- regions: accuracy over aligned human lines whose journal region maps to ours (MAP), with the
  confusion matrix (journal region x our region) over every human line, unaligned included;
- units: boundaries between consecutive aligned human lines (a new eScriptorium region vs a new
  gold unit), precision, recall and F1, our units taken as the prediction;
- text: character error rate of the gold's page text (lines, corrected where present) against the
  human transcription: each human line's Levenshtein distance to the gold text its window covers
  (its whole length when unaligned), plus every gold character no window covers, over the human
  characters; NFKC, typographic quotes straight, the transcription's line-end sign ¬ as "-",
  whitespace collapsed; order-free. The same for the raw extraction, so the corrections' effect
  shows.

--build-truth-store writes a store from the truth itself, in the gold store's layout as run "truth"
(one typed line per human line, one unit per human region; with --parsed, on the parser's own
extracted lines, each typed with the region of its best-matching human line), for checking the
scorer: score it with OPENLEGAL_GOLD=DIR and --runs truth.
"""
import argparse
import gzip
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "legal_pdf_corpus"))
import gold_store  # noqa: E402
# The bundle as saved in the benchmarks repo, or the kraken run's copy on the desktop.
BUNDLE = next((p for p in (Path.home() / "Desktop/MikeOSS Fork/benchmarks/local-data/olj-manual-gold/pagexml-661-20260810/remote_bundle",
                           Path.home() / "Desktop/oajd_compute/kraken_training_runs/catmus_small_transfer_20260810/remote_bundle")
               if p.is_dir()), None)
NS = "{http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15}"
# Journal ontology -> our regions. Absent (byline, reference_content, reference, figure_title,
# image, untyped): no counterpart is settled; those lines are in the confusion matrix only.
MAP = {"text": ("text", "list_item"), "abstract": ("text", "list_item"),
       "footnote": ("note",), "vision_footnote": ("note",),
       "block_quote": ("quote",),
       "doc_title": ("heading",), "paragraph_title": ("heading",),
       "header": ("furniture",), "footer": ("furniture",),
       "number": ("page_label",),
       "table": ("table",), "chart": ("table",),
       "content": ("contents",)}
SCORE, SHARE = 60, 0.4


def read_page(xml: Path):
    """Human lines in reading order: [{id, text, region, block}]."""
    root = ET.parse(xml).getroot()
    lines = []
    for block, region in enumerate(root.iter(NS + "TextRegion")):
        kind = re.search(r"type:([^;]+);", region.get("custom", ""))
        for line in region.findall(NS + "TextLine"):
            order = re.search(r"readingOrder \{index:(\d+);", line.get("custom", ""))
            text = "".join(u.text or "" for u in line.findall(f"{NS}TextEquiv/{NS}Unicode"))
            lines.append({"id": line.get("id"), "text": text, "region": kind[1] if kind else "none", "block": block,
                          "order": int(order[1]) if order else 10**6 + len(lines)})
    lines.sort(key=lambda l: l["order"])
    return [l for l in lines if l["text"].strip()]


def folded(text: str):
    """Matching form and, for each of its characters, the offset in text it came from."""
    out, where = [], []
    for i, ch in enumerate(text):
        for c in unicodedata.normalize("NFKD", ch):
            if unicodedata.combining(c):
                continue
            c = " " if c.isspace() else c.casefold()
            if c == " " and (not out or out[-1] == " "):
                continue
            out.append(c); where.append(i)
    return "".join(out), where


def match(needle: str, hay: list, used=frozenset(), expected=0):
    """Index of the hay string sharing the most characters with needle, and the needle's and its
    matched (start, end) in folded form; None when nothing matches well enough. Equal candidates
    (a line printed twice) go to one not matched yet, then to the one nearest the expected index."""
    best = None
    for k, other in enumerate(hay):
        if not other or not needle:
            continue
        found = fuzz.partial_ratio_alignment(needle, other)
        if found is None or found.score < SCORE:
            continue
        shared = found.score / 100 * min(found.src_end - found.src_start, found.dest_end - found.dest_start)
        key = (round(shared, 3), fuzz.ratio(needle, other), k not in used, -abs(k - expected))
        if best is None or key > best[0]:
            best = (key, k, (found.src_start, found.src_end), (found.dest_start, found.dest_end))
    if best is None or best[0][0] < SHARE * len(needle):
        return None
    return best[1:]


def load_gold(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


QUOTES = str.maketrans({"‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "¬": "-"})


def plain(text: str) -> str:
    """Text as compared for the error rate: NFKC, typographic quotes as straight ones, the
    transcription's line-end hyphen sign (¬) as a hyphen, whitespace collapsed."""
    return " ".join(unicodedata.normalize("NFKC", text).translate(QUOTES).split())


def windows(human, texts):
    """For each human line, where it stands on the gold's lines: (line index or None,
    [(line index, start, end)], the gold text it covers). The line sharing the most characters
    is found first; the window is then sought over it and its neighbours, so a human line the
    extraction split over two lines is covered whole."""
    forms = [folded(t)[0] for t in texts]
    result, used, expected = [], set(), 0
    for line in human:
        needle = folded(line["text"])[0]
        found = match(needle, forms, used, expected)
        if not found:
            result.append((None, [], "")); continue
        k, (a, b), (c, d) = found
        used.add(k); expected = k + 1
        if b - a >= 0.9 * len(needle):  # the line holds it whole
            where = folded(texts[k])[1]
            lo, hi = where[c], where[d - 1] + 1
            result.append((k, [(k, lo, hi)], texts[k][lo:hi])); continue
        joint, starts = "", {}
        for j in (k - 1, k, k + 1):
            if 0 <= j < len(texts):
                starts[j] = len(joint); joint += texts[j] + " "
        form, where = folded(joint)
        near = fuzz.partial_ratio_alignment(needle, form)
        if near is None or near.dest_end <= near.dest_start:
            result.append((None, [], "")); continue
        lo, hi = where[near.dest_start], where[near.dest_end - 1] + 1
        segments = [(j, max(lo, s) - s, min(hi, s + len(texts[j])) - s) for j, s in starts.items()
                    if max(lo, s) < min(hi, s + len(texts[j]))]
        result.append((k, segments, joint[lo:hi]))
    return result


def text_errors(human, texts):
    """Edit operations from the gold's page text to the human transcription: each human line
    against the gold text its window covers (all of it when unaligned), plus every gold character
    no window covers. Order-free, so a reading-order difference costs nothing."""
    placed = windows(human, texts)
    errors = sum(Levenshtein.distance(plain(l["text"]), plain(text)) for l, (_, _, text) in zip(human, placed))
    covered = defaultdict(set)
    for _, segments, _ in placed:
        for j, s, e in segments:
            covered[j].update(range(s, e))
    errors += sum(1 for j, text in enumerate(texts) for i, ch in enumerate(text) if not ch.isspace() and i not in covered[j])
    return errors, placed


def score_page(human, gold, page):
    """One truth page against one gold: per human line rows, and (errors, raw errors, characters)."""
    lines = [l for l in gold["lines"] if l["page"] == page]
    final = [l.get("corrected", l["text"]) for l in lines]
    unit_of = {t: u for u, unit in enumerate(gold["units"]) for t in unit["lines"]}
    cover = defaultdict(list)  # line id -> [(start, end, typed index)]
    ids = {l["id"] for l in lines}
    for t, item in enumerate(gold["typed"]):
        for span in item["spans"]:
            if span["line_id"] in ids:
                cover[span["line_id"]].append((span["start"], span["end"], t))
    errors, placed = text_errors(human, final)
    raw_errors, _ = text_errors(human, [l["text"] for l in lines])
    rows = []
    for line, (k, segments, _) in zip(human, placed):
        row = {"region": line["region"], "block": line["block"], "ours": "unaligned", "unit": None}
        if k is not None:
            votes = Counter()
            for j, lo, hi in segments:
                for s, e, t in cover[lines[j]["id"]]:
                    votes[t] += max(0, min(e, hi) - max(s, lo))
            t = max(votes, key=votes.get) if votes and max(votes.values()) > 0 else None
            row.update(ours=gold["typed"][t]["region"] if t is not None else "untyped",
                       unit=unit_of.get(t) if t is not None else None)
        rows.append(row)
    return rows, (errors, raw_errors, sum(len(plain(l["text"])) for l in human))


def summarize(rows, texts):
    aligned = [r for r in rows if r["ours"] != "unaligned"]
    mapped = [r for r in aligned if r["region"] in MAP]
    right = sum(r["ours"] in MAP[r["region"]] for r in mapped)
    tp = fp = fn = 0
    for page_rows in texts["pages"]:
        for x, y in zip(page_rows, page_rows[1:]):
            if x["ours"] == "unaligned" or y["ours"] == "unaligned":
                continue
            human_cut = x["block"] != y["block"]
            our_cut = x["unit"] is None or y["unit"] is None or x["unit"] != y["unit"]
            tp += human_cut and our_cut; fp += our_cut and not human_cut; fn += human_cut and not our_cut
    chars = sum(c for _, _, c in texts["texts"])
    confusion = Counter((r["region"], r["ours"]) for r in rows)
    return {"pages": len(texts["pages"]), "human_lines": len(rows), "aligned": len(aligned),
            "aligned_share": round(len(aligned) / max(1, len(rows)), 4),
            "region_lines": len(mapped), "region_accuracy": round(right / max(1, len(mapped)), 4),
            "boundaries": {"tp": tp, "fp": fp, "fn": fn, "precision": round(tp / max(1, tp + fp), 4),
                           "recall": round(tp / max(1, tp + fn), 4), "f1": round(2 * tp / max(1, 2 * tp + fp + fn), 4)},
            "cer": round(sum(e for e, _, _ in texts["texts"]) / max(1, chars), 4),
            "cer_raw": round(sum(r for _, r, _ in texts["texts"]) / max(1, chars), 4),
            "human_chars": chars,
            "confusion": {f"{a} -> {b}": n for (a, b), n in sorted(confusion.items(), key=lambda kv: -kv[1])}}


def run_gold(sha: str, run: str):
    """The source's gold of one run in the gold store, or None."""
    found = [p for p in gold_store.structure_runs(gold_store.ROOT / sha) if p.name.rsplit("-", 1)[1] == run]
    return found[-1] / "gold.json.gz" if found else None


def score_run(run: str, documents, bundle: Path):
    rows, texts, per_doc = [], {"pages": [], "texts": []}, []
    for doc in documents:
        path = run_gold(doc["sha256"], run)
        if path is None:
            continue
        gold = load_gold(path)
        doc_rows, doc_texts = [], {"pages": [], "texts": []}
        for truth in doc["truth_pages"]:
            page_rows, counts = score_page(read_page(bundle / "data" / truth["xml"]), gold, truth["page"])
            for target in (rows, doc_rows):
                target += page_rows
            for target in (texts, doc_texts):
                target["pages"].append(page_rows); target["texts"].append(counts)
        summary = summarize(doc_rows, doc_texts)
        summary.pop("confusion")
        per_doc.append({"article": doc.get("article"), "sha256": doc["sha256"], **summary})
    return {"run": run, "documents": len(per_doc), **summarize(rows, texts), "per_document": per_doc}


def build_truth_store(out: Path, documents, bundle: Path, parsed: Path | None, limit: int):
    """A store whose golds are the truth itself (or the truth's regions on the parser's lines)."""
    for doc in documents[: limit or None]:
        lines, typed, units = [], [], []
        source = None
        if parsed:
            sys.path.insert(0, str(HERE.parent))
            import gold as gold_module
            found = sorted((parsed / "parsed" / doc["sha256"]).rglob(f"{doc['mode']}.json.gz"))
            if not found:
                print("no extraction", doc["sha256"]); continue
            exported = load_gold(found[-1])
            document = exported.get("document", exported)
            structure = document.get("structure_graph", document.get("structure", document))
            extracted = {line["id"]: line.get("text", "".join(s["text"] for s in line.get("spans", [])))
                         for page in document.get("extraction", document)["pages"] for line in page["lines"]}
            source = [{"id": i, "page": l["page"], "text": extracted[i]} for i, l in gold_module.source_lines(structure).items()]
        for truth in doc["truth_pages"]:
            human = read_page(bundle / "data" / truth["xml"])
            if source is None:
                block_unit = {}
                for n, line in enumerate(human):
                    ident = f"p{truth['page']}-{n}"
                    lines.append({"id": ident, "page": truth["page"], "text": line["text"]})
                    if line["block"] not in block_unit:
                        block_unit[line["block"]] = len(units); units.append({"lines": []})
                    units[block_unit[line["block"]]]["lines"].append(len(typed))
                    region = MAP.get(line["region"], ("text",))[0]
                    typed.append({"page": truth["page"], "region": region, "text": line["text"], "start": True,
                                  "spans": [{"line_id": ident, "start": 0, "end": len(line["text"])}]})
                continue
            # The parser's lines on this page, each typed as its best-matching human line, one unit
            # per run of lines matched to one human region.
            human_forms = [folded(l["text"])[0] for l in human]
            last, used, expected = None, set(), 0
            for line in (l for l in source if l["page"] == truth["page"]):
                lines.append(line)
                found = match(folded(line["text"])[0], human_forms, used, expected)
                if found:
                    used.add(found[0]); expected = found[0] + 1
                h = human[found[0]] if found else None
                region = MAP.get(h["region"], ("text",))[0] if h else "text"
                key = h["block"] if h else None
                if key is None or key != last:
                    units.append({"lines": []})
                last = key
                units[-1]["lines"].append(len(typed))
                typed.append({"page": truth["page"], "region": region, "text": line["text"], "start": True,
                              "spans": [{"line_id": line["id"], "start": 0, "end": len(line["text"])}]})
        job = out / doc["sha256"] / "structure" / "truth-truth"
        job.mkdir(parents=True, exist_ok=True)
        with gzip.open(job / "gold.json.gz", "wt", encoding="utf-8") as stream:
            json.dump({"schema_version": "truth-check", "source_sha256": doc["sha256"], "lines": lines,
                       "typed": typed, "units": units}, stream, ensure_ascii=False)
        print(job)


def table(results):
    head = f"{'run':<28} {'docs':>4} {'pages':>5} {'lines':>6} {'aligned':>7} {'region':>7} {'bnd P':>6} {'bnd R':>6} {'bnd F1':>6} {'CER':>6} {'CER raw':>7}"
    print(head)
    for r in results:
        b = r["boundaries"]
        print(f"{r['run']:<28}"
              f" {r['documents']:>4} {r['pages']:>5} {r['human_lines']:>6} {r['aligned_share']:>7.3f} {r['region_accuracy']:>7.3f}"
              f" {b['precision']:>6.3f} {b['recall']:>6.3f} {b['f1']:>6.3f} {r['cer']:>6.3f} {r['cer_raw']:>7.3f}")
    for r in results:
        print(f"\nrun {r['run']} confusion (journal -> ours, lines):")
        for pair, n in r["confusion"].items():
            print(f"  {n:>5}  {pair}")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("manifest", type=Path)
    p.add_argument("--runs", nargs="+", default=[gold_store.CURRENT_RUN], help="The gold store's runs to score (default: the current gold)")
    p.add_argument("--gold", type=Path, default=BUNDLE, help="The manual gold bundle (data/ of PageXML)")
    p.add_argument("--out", type=Path, help="Write the results JSON here")
    p.add_argument("--build-truth-store", type=Path, help="Write a store of golds made from the truth, then exit")
    p.add_argument("--parsed", type=Path, help="With --build-truth-store: the folder holding parsed/ (parser lines)")
    p.add_argument("--limit", type=int, default=0)
    a = p.parse_args()
    manifest = a.manifest
    documents = json.loads(manifest.read_text(encoding="utf-8"))["documents"]
    if a.build_truth_store:
        build_truth_store(a.build_truth_store, documents, a.gold, a.parsed, a.limit); return
    results = [score_run(run, documents, a.gold) for run in a.runs]
    table(results)
    if a.out:
        a.out.write_text(json.dumps({"manifest": str(manifest), "map": {k: list(v) for k, v in MAP.items()},
                                     "results": results}, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
