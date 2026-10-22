"""The export, label and manifest stages of silver.py."""
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from silver import GOLD_CODE, HERE, LISTING, a2aj_db, a2aj_text, engine, work

SYNTHETIC = ("rebuilt", "synth", "warmup", "e2e-", "sample", "debug", "test")


def selected(gold):
    """Accepted candidates, one PDF per distinct printed text (a highlighted or re-saved copy of
    the same PDF is the same document), without the test files the misc collection holds."""
    import fitz
    rows = [r for r in json.loads((work(gold) / "candidates.json").read_text(encoding="utf-8"))["documents"] if "refused" not in r]
    rows = [r for r in rows if not any(word in (r["label"] or "").lower() for word in SYNTHETIC)]
    by_text = {}
    for r in sorted(rows, key=lambda r: ("highlight" in (r["label"] or "").lower(), r["collection"] != "a2aj-pdf-cache", r["sha256"])):
        with fitz.open(r["path"]) as document:
            key = hashlib.sha256("\f".join(page.get_text() for page in document).encode("utf-8")).hexdigest()
        by_text.setdefault(key, r)
    return sorted(by_text.values(), key=lambda r: r["sha256"])


def export_one(gold, r):
    import author
    try:
        lines, parser = author.extract(Path(r["path"]), r["mode"], gold, 1800)
        return {"sha256": r["sha256"], "lines": len(lines), "parser": parser}
    except Exception as exc:
        return {"sha256": r["sha256"], "error": str(exc)[-500:]}


def export(args):
    rows = selected(args.gold)
    with ThreadPoolExecutor(min(2, args.jobs)) as pool:
        for result in pool.map(lambda r: export_one(args.gold, r), rows): print(json.dumps(result), flush=True)


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


def build(gold, r, text, listing, outline, started):
    """The gold value and receipt of one PDF, or raises label.Refused."""
    import author
    import hierarchy
    import label
    lines, parser = author.extract(Path(r["path"]), r["mode"], gold, 1800)
    found = [p for p in (gold / "parsed" / r["sha256"] / parser["binary_sha256"]).glob(f"*/{r['mode']}.json.gz")
             if not p.parent.name.endswith("-layout")]
    geo, pages = label.geometry(max(found, key=lambda p: p.stat().st_mtime))
    doc = label.Labelled(lines, geo, pages, text, listing, outline)
    typed, unit_seg = doc.typed()
    units = [{"lines": members, "parent": None, "starts_document": False, "ends_document": False} for members in hierarchy.units(typed)]
    levels, kinds = label.heading_levels(doc, typed, units)
    for u, level in levels.items(): units[u]["level"] = level
    regions = [typed[unit["lines"][0]]["region"] for unit in units]
    texts = [" ".join(typed[unit["lines"][0]]["text"].split()) for unit in units]
    parents = hierarchy.assemble(regions, texts, [levels.get(u) for u in range(len(units))], [False] * len(units))
    for unit, parent in zip(units, parents): unit["parent"] = parent
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
    report = {"unanchored_lines": [], "unplaced_text": [], "kept_lines": [], "typed_differences": [],
              "lines_without_typed_text": doc.unfilled, "engine_split_lines": 0, "engine_merged_lines": 0}
    alignment = {**doc.stats, "label_decisions": dict(doc.decisions), "heading_kinds": kinds,
                 "headings": regions.count("heading"), "notes_paired": len(notes), "lines_without_typed_text": len(doc.unfilled),
                 "regions": {x: regions.count(x) for x in sorted(set(regions))}}
    value = {"schema_version": "legal-structure-gold.v4", "source_sha256": r["sha256"], "mode": r["mode"],
             "page_count": r["pages"], "parser": parser, "images": author.embedded_images(Path(r["path"])),
             "authoring": {"label_source": "a2aj-silver", "a2aj_document_id": a2aj["document_id"], "language": a2aj["language"],
                           "citation": a2aj["citation"], "dataset": a2aj["dataset"], "listing": LISTING.name, "code": code_hashes()},
             "label_source": "a2aj-silver",
             "lines": [{"id": line["id"], "page": line["page"], "text": line["text"]} for line in lines],
             "typed": typed, "units": units, "notes": notes, "text_edits": [], "report": report}
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


def manifest(args):
    """Add every written silver gold to cohort-manifest.json and provenance.json (additive; existing
    rows keep their order and gain label_source 'model'). Splits: one in three development, two in
    three train, in sha256 order, with every PDF of one decision in the split of its first."""
    import tempfile
    gold = args.gold
    results = json.loads((work(gold) / "label-results.json").read_text(encoding="utf-8"))["results"]
    rows = {r["sha256"]: r for r in selected(gold)}
    written = sorted(x["sha256"] for x in results if x.get("written") and (gold / "v4" / x["sha256"] / "gold.json.gz").is_file())
    split, n = {}, 0
    for sha in written:
        decision = rows[sha]["a2aj"]["document_id"]
        if decision not in split: split[decision] = "development" if n % 3 == 0 else "train"; n += 1
    manifest_path, provenance_path = gold / "cohort-manifest.json", gold / "provenance.json"
    cohort = json.loads(manifest_path.read_text(encoding="utf-8"))
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    known = {d["sha256"] for d in cohort["documents"]}
    for d in cohort["documents"]: d.setdefault("label_source", "model")
    for d in provenance["records"]: d.setdefault("label_source", "model")
    added = 0
    with tempfile.TemporaryDirectory() as scratch:
        for sha in written:
            if sha in known: continue
            r = rows[sha]
            path = durable(r, Path(scratch))
            receipt = json.loads((gold / "v4" / sha / "receipt.json").read_text(encoding="utf-8"))
            s = split[r["a2aj"]["document_id"]]
            cohort["documents"].append({"path": path, "mode": r["mode"], "split": s, "sha256": sha, "pages": r["pages"],
                                        "language_layout": r["a2aj"]["language"], "genre_group": "judgment", "country": "ca",
                                        "yardstick": "main", "label_source": "a2aj-silver"})
            provenance["records"].append({"sha256": sha, "split": s, "mode": r["mode"], "pages": r["pages"], "path": path,
                                          "collection": "silver-a2aj-2026-10-22", "country": "ca", "genre": "judgment",
                                          "source_family": r["a2aj"]["dataset"], "label_source": "a2aj-silver",
                                          "authoring": {"label_source": "a2aj-silver", "status": receipt["status"]},
                                          "a2aj": {k: r["a2aj"][k] for k in ("document_id", "language", "citation", "dataset")},
                                          "corpus_collection": r["collection"], "corpus_label": r["label"]})
            added += 1
    manifest_path.write_text(json.dumps(cohort, indent=1), encoding="utf-8")
    provenance_path.write_text(json.dumps(provenance, indent=1), encoding="utf-8")
    from collections import Counter
    new = [d for d in cohort["documents"] if d.get("label_source") == "a2aj-silver"]
    print(f"{added} silver rows added; manifest holds {len(new)} silver of {len(cohort['documents'])};",
          dict(Counter(d["split"] for d in new)))


def merge_groups(args):
    """groups.json gains the silver sources as groups.py detects them (here, where only this store's
    golds are read) without losing the sources detected elsewhere; existing sources get
    label_source "model". Then run groups.py apply GOLD/groups.json GOLD/cohort-manifest.json --sqlite."""
    import subprocess
    import sys
    import tempfile
    gold = args.gold
    with tempfile.TemporaryDirectory() as scratch:
        out = Path(scratch) / "groups.json"
        subprocess.run([sys.executable, str(GOLD_CODE / "groups.py"), "detect", str(gold), str(gold / "provenance.json"), "--out", str(out)], check=True)
        found = json.loads(out.read_text(encoding="utf-8"))["sources"]
    current = json.loads((gold / "groups.json").read_text(encoding="utf-8"))
    for g in current["sources"].values(): g.setdefault("label_source", "model")
    added = [sha for sha, g in found.items() if g["label_source"] == "a2aj-silver" and sha not in current["sources"]]
    for sha in added: current["sources"][sha] = found[sha]
    (gold / "groups.json").write_text(json.dumps(current, indent=1), encoding="utf-8")
    print(f"{len(added)} silver sources added; groups.json holds {len(current['sources'])}")


def label_all(args):
    import label
    from codex_runner.artifacts import atomic_json, digest
    gold = args.gold
    rows = [r for r in selected(gold) if r["sha256"].startswith(args.sha or "")]
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
        job = gold / "v4" / r["sha256"]
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
            value, receipt = build(gold, r, texts[r["sha256"]], found[key], outline, started)
        except label.Refused as refusal:
            results.append({**outcome, "refused": refusal.reason, "alignment": refusal.stats}); continue
        if args.dry_run:
            results.append({**outcome, "written": False, "alignment": receipt["alignment"]}); continue
        atomic_json(job / "gold.json.gz", value)
        receipt.update(gold_sha256=digest(job / "gold.json.gz"), finished_at=time.time())
        (job / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=1), encoding="utf-8")
        results.append({**outcome, "written": True, "alignment": receipt["alignment"]})
    path = work(gold) / (f"label-results-{args.sha}.json" if args.sha else "label-results.json")
    path.write_text(json.dumps({"results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{sum('refused' not in x for x in results)} of {len(results)} passed{' (dry run)' if args.dry_run else ''} -> {path}")
    for x in results:
        al = x.get("alignment", {})
        print(f"  {x['sha256'][:12]} {x['citation']:<18} {'ok' if 'refused' not in x else 'NO'} cov={al.get('coverage')} "
              f"par={al.get('paragraphs')} unm={al.get('unmatched_paragraphs')} {x.get('refused', '')}")
