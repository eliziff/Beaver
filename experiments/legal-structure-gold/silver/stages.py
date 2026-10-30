"""The export, label and sources stages of silver.py."""
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from silver import GOLD_CODE, HERE, LISTING, RUN, a2aj_db, a2aj_text, engine, work

SYNTHETIC = ("rebuilt", "synth", "warmup", "e2e-", "sample", "debug", "test")


def selected(args):
    """Accepted candidates, one PDF per distinct printed text (a highlighted or re-saved copy of
    the same PDF is the same document), without the test files the misc collection holds."""
    import fitz
    rows = [r for r in json.loads((work(args) / "candidates.json").read_text(encoding="utf-8"))["documents"] if "refused" not in r]
    rows = [r for r in rows if not any(word in (r["label"] or "").lower() for word in SYNTHETIC)]
    by_text = {}
    for r in sorted(rows, key=lambda r: ("highlight" in (r["label"] or "").lower(), r["collection"] != "a2aj-pdf-cache", r["sha256"])):
        with fitz.open(r["path"]) as document:
            key = hashlib.sha256("\f".join(page.get_text() for page in document).encode("utf-8")).hexdigest()
        by_text.setdefault(key, r)
    return sorted(by_text.values(), key=lambda r: r["sha256"])


def export_one(folder, r):
    import author
    try:
        lines, _, parser = author.extract(Path(r["path"]), r["mode"], folder, 1800)
        return {"sha256": r["sha256"], "lines": len(lines), "parser": parser}
    except Exception as exc:
        return {"sha256": r["sha256"], "error": str(exc)[-500:]}


def export(args):
    rows = selected(args)
    with ThreadPoolExecutor(min(2, args.jobs)) as pool:
        for result in pool.map(lambda r: export_one(work(args), r), rows): print(json.dumps(result), flush=True)


def listings(keys):
    """The census node listing of each key (`<document id>:<language>`)."""
    want, found = {'{"key":"' + k + '"': k for k in keys}, {}
    with open(LISTING, encoding="utf-8") as stream:
        for line in stream:
            head = line[:line.find(",")]
            if head in want: found[want[head]] = json.loads(line)["nodes"]
    return found


def code_hashes():
    from codex_runner.artifacts import digest
    return {p.name: digest(p) for p in (HERE / "silver.py", HERE / "stages.py", HERE / "label.py", HERE / "align.py",
                                        HERE / "engine.mjs", GOLD_CODE / "hierarchy.py")}


def build(folder, r, text, listing, outline, started):
    """The gold value and receipt of one PDF, or raises label.Refused."""
    import author
    import hierarchy
    import label
    lines, _, parser = author.extract(Path(r["path"]), r["mode"], folder, 1800)
    found = [p for p in (folder / "parsed" / r["sha256"] / parser["binary_sha256"]).glob(f"*/{r['mode']}.json.gz")
             if not p.parent.name.endswith("-layout")]
    geo, pages = label.geometry(max(found, key=lambda p: p.stat().st_mtime))
    doc = label.Labelled(lines, geo, pages, text, listing, outline)
    typed, unit_seg = doc.typed()
    units = [{"lines": members, "starts_document": False} for members in hierarchy.units(typed)]
    levels, kinds = label.heading_levels(doc, typed, units)
    for u, level in levels.items(): units[u]["level"] = level
    unit_of = {t: u for u, unit in enumerate(units) for t in unit["lines"]}
    first_typed = {}
    for t, s in unit_seg.items():
        if isinstance(s, int): first_typed.setdefault(s, t)
    notes = []
    for t, entry in enumerate(typed):
        for k, ref in enumerate(entry["references"]):
            note = first_typed.get(ref.pop("_note"))
            if note is None or typed[note]["region"] != "note": continue
            notes.append({"line": t, "marker": ref["label"].strip("[]()"), "reference": k, "note": unit_of[note]})
        entry.pop("_free", None)
    a2aj = r["a2aj"]
    regions = [typed[unit["lines"][0]]["region"] for unit in units]
    report = {"unanchored_lines": [], "unplaced_text": [], "kept_lines": [], "typed_differences": [],
              "lines_without_typed_text": doc.unfilled, "engine_split_lines": 0, "engine_merged_lines": 0}
    alignment = {**doc.stats, "label_decisions": dict(doc.decisions), "heading_kinds": kinds,
                 "headings": regions.count("heading"), "notes_paired": len(notes), "lines_without_typed_text": len(doc.unfilled),
                 "regions": {x: regions.count(x) for x in sorted(set(regions))}}
    value = {"schema_version": "legal-structure-gold.v4", "source_sha256": r["sha256"], "mode": r["mode"],
             "page_count": r["pages"], "parser": parser,
             "authoring": {"label_source": "a2aj-silver", "a2aj_document_id": a2aj["document_id"], "language": a2aj["language"],
                           "citation": a2aj["citation"], "dataset": a2aj["dataset"], "listing": LISTING.name, "code": code_hashes()},
             "label_source": "a2aj-silver",
             "lines": [{"id": line["id"], "page": line["page"], "text": line["text"]} for line in lines],
             "typed": typed, "units": units, "notes": notes, "report": report}
    receipt = {"source_sha256": r["sha256"], "mode": r["mode"], "status": "complete", "label_source": "a2aj-silver",
               "a2aj": {"document_id": a2aj["document_id"], "language": a2aj["language"], "citation": a2aj["citation"],
                        "dataset": a2aj["dataset"], "name": a2aj["name"]},
               "alignment": alignment, "pages": r["pages"], "units": len(units), "typed_lines": len(typed), "notes": len(notes),
               "report": {key: len(item) if isinstance(item, list) else item for key, item in report.items()},
               "code": code_hashes(), "started_at": started}
    return value, receipt


def durable(r, scratch):
    """A PDF from the disposable A2AJ PDF cache, stored in the corpus store (legal-pdf, judgment);
    returns its corpus path. Other PDFs are already corpus files."""
    import shutil
    import subprocess
    import sys
    if "\\cache\\" not in r["path"] and "/cache/" not in r["path"]: return r["path"]
    copy = scratch / Path(r["path"]).name
    shutil.copyfile(r["path"], copy)
    store = GOLD_CODE.parent / "legal_pdf_corpus" / "corpus_store.py"
    run = subprocess.run([sys.executable, str(store), "add", str(copy), "--kind", "judgment", "--collection", "legal-pdf",
                          "--jurisdiction", "ca", "--label", r["a2aj"]["citation"],
                          "--provenance", "A2AJ provider PDF cache (cache/a2aj/pdf/blobs), stored for the A2AJ silver structure gold"],
                         capture_output=True, encoding="utf-8")
    copy.unlink(missing_ok=True)
    if run.returncode: raise RuntimeError(run.stderr[-500:])
    status, sha, path = run.stdout.strip().splitlines()[-1].split("\t")
    if sha != r["sha256"]: raise RuntimeError(f"corpus store hashed {sha}, expected {r['sha256']}")
    return path


def sources(args):
    """Every written silver gold's source.json in the silver store: partition train, its groups
    (judgment, Canadian, the A2AJ text's language) and its PDF's corpus path."""
    import tempfile
    from codex_runner.artifacts import atomic_json
    results = json.loads((work(args) / "label-results.json").read_text(encoding="utf-8"))["results"]
    rows = {r["sha256"]: r for r in selected(args)}
    written = sorted(x["sha256"] for x in results if x.get("written") and (args.store / x["sha256"] / "structure" / RUN / "gold.json.gz").is_file())
    added = 0
    with tempfile.TemporaryDirectory() as scratch:
        for sha in written:
            if (args.store / sha / "source.json").is_file(): continue
            r = rows[sha]
            atomic_json(args.store / sha / "source.json", {
                "partition": "train", "language_layout": r["a2aj"]["language"], "genre_group": "judgment", "country": "ca",
                "yardstick": "main", "label_source": "a2aj-silver", "pdf": durable(r, Path(scratch))})
            added += 1
    print(f"{added} source.json written for {len(written)} written silver golds -> {args.store}")


def label_all(args):
    import label
    from codex_runner.artifacts import atomic_json, digest
    rows = [r for r in selected(args) if r["sha256"].startswith(args.sha or "")]
    db = a2aj_db()
    texts = {}
    for r in rows:
        row = db.execute("select * from document where id = ?", (r["a2aj"]["document_id"],)).fetchone()
        texts[r["sha256"]] = a2aj_text(row, r["a2aj"]["language"])
    found = listings({f"{r['a2aj']['document_id']}:{r['a2aj']['language']}" for r in rows})
    distinct = sorted(set(texts.values()))
    outlines = dict(zip(distinct, engine("outline", distinct)))
    results = []
    for r in rows:
        started = time.time()
        job = args.store / r["sha256"] / "structure" / RUN
        key = f"{r['a2aj']['document_id']}:{r['a2aj']['language']}"
        outcome = {"sha256": r["sha256"], "path": r["path"], "citation": r["a2aj"]["citation"], "a2aj": key, "pages": r["pages"]}
        if job.exists() and json.loads((job / "receipt.json").read_text(encoding="utf-8")).get("label_source") != "a2aj-silver" \
                if (job / "receipt.json").is_file() else job.exists():
            results.append({**outcome, "refused": "a job folder this run did not create exists"}); continue
        if key not in found:
            results.append({**outcome, "refused": "no census listing for the case"}); continue
        outline = outlines[texts[r["sha256"]]]
        if isinstance(outline, dict):
            results.append({**outcome, "refused": "case outline failed: " + str(outline.get("error"))[:200]}); continue
        try:
            value, receipt = build(work(args), r, texts[r["sha256"]], found[key], outline, started)
        except label.Refused as refusal:
            results.append({**outcome, "refused": refusal.reason, "alignment": refusal.stats}); continue
        if args.dry_run:
            results.append({**outcome, "written": False, "alignment": receipt["alignment"]}); continue
        atomic_json(job / "gold.json.gz", value)
        receipt.update(gold_sha256=digest(job / "gold.json.gz"), finished_at=time.time())
        (job / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=1), encoding="utf-8")
        results.append({**outcome, "written": True, "alignment": receipt["alignment"]})
    path = work(args) / (f"label-results-{args.sha}.json" if args.sha else "label-results.json")
    path.write_text(json.dumps({"results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{sum('refused' not in x for x in results)} of {len(results)} passed{' (dry run)' if args.dry_run else ''} -> {path}")
    for x in results:
        al = x.get("alignment", {})
        print(f"  {x['sha256'][:12]} {x['citation']:<18} {'ok' if 'refused' not in x else 'NO'} cov={al.get('coverage')} "
              f"par={al.get('paragraphs')} unm={al.get('unmatched_paragraphs')} {x.get('refused', '')}")
