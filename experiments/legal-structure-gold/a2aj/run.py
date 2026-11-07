"""Gold from Canadian judgments that A2AJ also holds: each PDF read once by the installed parser, its lines aligned
word by word with A2AJ's text of the same decision, the alignment kept as one record per PDF, and the gold each mode
reads off the records.

  python run.py pairs [--by-citation [COLLECTION ...]]
                                           PDFs paired with their A2AJ decision -> WORK/pairs.jsonl. A pair is the
                                           court's own item number on both (A2AJ's url_en is the item's page; the PDF
                                           is the item's document); --by-citation adds PDFs without one (of these
                                           corpus collections, or all), paired by the citation on their first pages and
                                           the words they share, and lists the rest with why -> WORK/unpaired.jsonl
  python run.py read [--part K/N] [--export DIR]
                                           the product's reading of each pair's PDF (legalpdf-read: extraction, and our
                                           recognition of scanned pages) -> WORK/read/<sha>.json; --part K/N takes every
                                           Nth pair from the Kth, --export DIR stages that part to read on another machine
  python run.py align [--only S ...] [--limit N]
                                           align every read pair without a current record -> WORK/records/<sha>.json.gz,
                                           on every core (the Rust aligner in aligner/, called through align.py)
  python run.py text-layer                 each line of a scan's records with its exact text -> WORK/text-layers/<sha>.json
  python run.py gold [--check] [--only S ...]
                                           structure gold (label.py, label source a2aj-align) of every record that passes
                                           the gates -> THE gold store (structure/a2aj-a), checked first against the
                                           store's own gold of the PDFs it already holds
  python run.py passages                   each numbered paragraph and quotation A2AJ reads, placed on the PDF's lines,
                                           and where the report's pages begin -> WORK/passages/<sha>.json
  python run.py report                     the records' alignment, refusals and each mode's output
  python run.py proof OUT [--lines N] [--paragraphs N] [--words N] [--seed N]
                                           proof sheets: lines and paragraphs cropped from their pages, A2AJ's text beside,
                                           and N words of each kind of pairing boxed in their lines, A2AJ's word above

A record is current while the aligner's own code (the aligner/ crate) and the PDF's reading are the ones that made it; a PDF is read once
(WORK/read) and its reading never repeated for a new alignment. WORK is A2AJ_GOLD_WORK, default E:/OpenLegalData/a2aj-gold.
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
GOLD_CODE = HERE.parent
REPO = GOLD_CODE.parents[1]
sys.path[:0] = [str(HERE), str(GOLD_CODE), str(REPO / "tools"), str(REPO / "experiments/legal_pdf_corpus")]
import align  # noqa: E402
import corpus_store  # noqa: E402
import gold_store  # noqa: E402

DATA = Path(os.environ["LOCALAPPDATA"]) / "OpenLegalData"
A2AJ = DATA / "providers/a2aj/a2aj.sqlite"
LISTING = DATA / "experiments/a2aj-structure/fix.nodes.jsonl"
WORK = Path(os.environ.get("A2AJ_GOLD_WORK", "E:/OpenLegalData/a2aj-gold"))
READER = REPO / "native/legal-structure-node/target/release/legalpdf-read.exe"
RUNTIME = REPO / "legal-pdf-parser/runtime"
LABEL_SOURCE = "a2aj-align"
GOLD_BATCH = "a2aj"  # the gold store's run folder, structure/a2aj-a; and the sources' yardstick
# The lines that print no text of a decision (what the gates measure unexplained lines against the rest of).
NONTEXT = ("furniture", "page_label", "running_head", "margin_letter", "no_words")
SYNTHETIC = ("rebuilt", "synth", "warmup", "e2e-", "sample", "debug", "test")
MAX_PAGES = 150
PLACED = 0.9        # a paragraph or quotation is placed when this share of its words is
CODE = align.CODE
# What a gold of this folder is made by besides its record (a gold made by it from the same reading is not made again).
LABEL_CODE = hashlib.sha256(b"".join(path.read_bytes() for path in (HERE / "run.py", HERE / "label.py", GOLD_CODE / "postcorrect.py",
                                                                    GOLD_CODE / "hierarchy.py"))).hexdigest()[:16]


# -- pairs ---------------------------------------------------------------------------------------------------------

def a2aj():
    db = sqlite3.connect(f"file:{A2AJ}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def a2aj_text(row, language):
    """A decision's text as the census read it: its JavaScript white space trimmed, so the listing's offsets hold."""
    text = row[f"unofficial_text_{language}"]
    return align.trimmed(text) if text else None


def item_of(url):
    """(site, item number) of a court's Decisia address: its item page or the item's document. The site is the
    address's first two folders (`nsc/nsca`, `scc-csc/scc-csc`): an item number is the site's, whichever host serves
    it (Nova Scotia's courts are at decisions.courts.ns.ca and at decisia.lexum.com)."""
    p = urlparse(url or "")
    m = re.match(r"/([^/]+/[^/]+)/[a-z]{2}/(?:item/)?(\d+)/(?:\d+/document\.do|index\.do)$", p.path)
    return (m.group(1), m.group(2)) if p.hostname and m else None


def local_pdfs():
    """(path, sha256, address, label, collection) of every local PDF: the corpus store's, and the app's provider-PDF
    receipts (no collection)."""
    corpus = sqlite3.connect(f"file:{DATA / 'corpus/corpus.sqlite'}?mode=ro", uri=True)
    for path, sha, url, label, collection in corpus.execute("select f.path, d.sha256, d.url, d.label, d.collection from documents d "
                                                            "join files f using (sha256) where lower(f.path) like '%.pdf'"):
        yield Path(path) if os.path.isabs(path) else corpus_store.HOME / path, sha, url, label, collection
    for base in ("apps/mike/launcher/data-20260904", "apps/mike/library-current", "apps/mike/library-v9"):
        for file in (DATA / base / "projections/v1/source-pdf").glob("*.json"):
            record = json.loads(file.read_text(encoding="utf-8"))
            sha = record.get("source_sha256", "")
            yield DATA / base / "projections/v1/content/pdf" / sha[:2] / f"{sha}.pdf", sha, record.get("canonical_url") or record.get("url"), None, None
    for file in (DATA / "cache/a2aj/pdf/requests").glob("*.json"):
        record = json.loads(file.read_text(encoding="utf-8"))
        sha = record.get("source_sha256", "")
        yield DATA / "cache/a2aj/pdf/blobs" / f"{sha}.pdf", sha, record.get("canonical_url") or record.get("url"), None, None


def mode_of(document):
    """ocr when at least half of six sampled pages are mostly one image or carry no text, else digitalborn."""
    import fitz
    n = len(document)
    sample = sorted({round(k * (n - 1) / 5) for k in range(6)}) if n > 1 else [0]
    scanned = 0
    for p in sample:
        page = document[p]
        area = page.rect.width * page.rect.height or 1
        big = max((abs(fitz.Rect(i["bbox"]) & page.rect) / area for i in page.get_image_info()), default=0)
        scanned += big >= 0.5 or len(page.get_text().strip()) < 20
    return "ocr" if scanned * 2 >= len(sample) else "digitalborn"


def engine(op, texts):
    """The engine's reading of each text (engine.mjs)."""
    run = subprocess.run(["node", str(HERE / "engine.mjs")], input=json.dumps({"op": op, "texts": texts}, ensure_ascii=False),
                         capture_output=True, encoding="utf-8")
    if run.returncode: raise RuntimeError(run.stderr[-2000:])
    return json.loads(run.stdout)


def shingles(text):
    words = [w for w, _, _ in align.words_of(text)]
    return {tuple(words[k:k + 4]) for k in range(len(words) - 3)}


def by_citation(pdfs, db):
    """({sha: A2AJ document id}, {sha: why not}) for PDFs without an item address: the A2AJ case a citation on their
    first two pages names (a neutral citation, or a report's: the Supreme Court Reports print no neutral one), of
    those, the one whose text (both its languages: a bilingual report prints both) holds most of the PDF's four-word
    runs, at least half of them."""
    import fitz
    firsts, why = {}, {}
    for path, sha, *_ in pdfs:
        try:
            with fitz.open(path) as document: firsts[sha] = (path, "\n".join(document[p].get_text() for p in range(min(2, len(document)))))
        except Exception as error: why[sha] = f"unreadable PDF: {str(error)[:80]}"
    shas = [s for s in firsts if firsts[s][1].strip()]
    why.update({s: "no text on its first pages (a scan without a text layer): no citation to read" for s in firsts if not firsts[s][1].strip()})
    found = engine("citations", [firsts[s][1] for s in shas]) if shas else []
    cited_of = {sha: list(dict.fromkeys(c["text"] for c in (cs if isinstance(cs, list) else []) if c.get("family") in ("neutral", "reporter")))
                for sha, cs in zip(shas, found)}
    texts = sorted({c for cs in cited_of.values() for c in cs})
    keys = dict(zip(texts, engine("keys", texts))) if texts else {}
    out = {}
    for sha in shas:
        ids = {i for c in cited_of[sha][:8] for key in (keys.get(c) if isinstance(keys.get(c), list) else [keys.get(c)])
               for (i,) in db.execute("select c.document_id from citation_lookup c join document d on d.id = c.document_id "
                                      "where c.citation_key = ? and d.doc_type = 'cases'", (key,))}
        if not ids:
            why[sha] = "cites no decision A2AJ holds on its first pages" if cited_of[sha] else "no citation on its first pages"
            continue
        with fitz.open(firsts[sha][0]) as document: own = shingles("\n".join(page.get_text() for page in document))
        def share(i):
            row = db.execute("select * from document where id = ?", (i,)).fetchone()
            return len(own & set().union(*(shingles(a2aj_text(row, lang) or "") for lang in ("en", "fr")))) / max(1, len(own))
        shares = {i: share(i) for i in ids}
        best = max(shares, key=shares.get)
        if shares[best] >= 0.5: out[sha] = best
        else: why[sha] = f"the A2AJ decisions it cites on its first pages share at most {shares[best]:.0%} of its words"
    return out, why


def pairs(args):
    """WORK/pairs.jsonl; and WORK/unpaired.jsonl: each PDF of the collections --by-citation names that pairs with no
    A2AJ decision, and why."""
    import fitz
    db = a2aj()
    by_item = {}
    for row in db.execute("select id, url_en, url_fr from document where doc_type = 'cases'"):
        for url in (row["url_en"], row["url_fr"]):
            if item_of(url): by_item.setdefault(item_of(url), row["id"])
    found, unpaired, considered, refused, why = {}, [], {}, Counter(), {}
    wanted = lambda collection: args.by_citation is not None and (not args.by_citation or collection in args.by_citation)
    for path, sha, url, label, collection in local_pdfs():
        if wanted(collection): considered.setdefault(sha, (path, url, label, collection))
        if sha in found or not path.is_file(): continue
        if any(word in (label or "").lower() for word in SYNTHETIC): refused["synthetic copy"] += 1; why[sha] = "a synthetic copy"; continue
        if item_of(url) in by_item: found[sha] = (path, by_item[item_of(url)], "item")
        elif wanted(collection): unpaired.append((path, sha, url, label, collection))
    if args.by_citation is not None:
        cited, not_cited = by_citation({p[1]: p for p in unpaired}.values(), db)
        why.update(not_cited)
        for sha, doc_id in cited.items():
            found.setdefault(sha, (next(p[0] for p in unpaired if p[1] == sha), doc_id, "citation"))
    rows, printed = [], {}
    for sha, (path, doc_id, route) in sorted(found.items()):
        row = db.execute("select * from document where id = ?", (doc_id,)).fetchone()
        try:
            document = fitz.open(path)
        except Exception:
            refused["the PDF does not open"] += 1; why[sha] = "the PDF does not open"; continue
        with document:
            if len(document) == 0: refused["no pages"] += 1; why[sha] = "the PDF has no pages"; continue
            if len(document) > MAX_PAGES: refused["over 150 pages"] += 1; why[sha] = "over 150 pages"; continue
            text = "\f".join(page.get_text() for page in document)
            # A re-saved or highlighted copy of a PDF prints the same text: one of them is the document.
            if text.strip() and printed.setdefault(hashlib.sha256(text.encode()).hexdigest(), sha) != sha:
                refused["copy of another PDF"] += 1; why[sha] = "a copy of another PDF"; continue
            pages, mode = len(document), mode_of(document)
        rows.append({"sha256": sha, "path": str(path), "pages": pages, "mode": mode, "route": route, "a2aj": doc_id,
                     "citation": row["citation_en"] or row["citation_fr"], "name": row["name_en"] or row["name_fr"],
                     "date": (row["document_date_en"] or row["document_date_fr"] or "")[:10], "court": row["dataset"],
                     "languages": [lang for lang in ("en", "fr") if a2aj_text(row, lang)]})
    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / "pairs.jsonl").open("w", encoding="utf-8") as out:
        for row in rows: out.write(json.dumps(row, ensure_ascii=False) + "\n")
    for row in rows: durable(row)
    corpus_store.register_a2aj_pairs(rows)
    if args.by_citation is not None:
        paired = {r["sha256"] for r in rows}
        with (WORK / "unpaired.jsonl").open("w", encoding="utf-8") as out:
            for sha, (path, url, label, collection) in sorted(considered.items()):
                if sha not in paired:
                    out.write(json.dumps({"sha256": sha, "path": str(path), "url": url, "label": label, "collection": collection,
                                          "why": why.get(sha, "no PDF file" if not path.is_file() else "no item address A2AJ holds")},
                                         ensure_ascii=False) + "\n")
    print(f"{len(rows)} pairs ({dict(Counter(r['route'] for r in rows))}; {dict(Counter(r['mode'] for r in rows))}); "
          f"refused {dict(refused)} -> {WORK / 'pairs.jsonl'}")


def read_pairs(only=None):
    rows = [json.loads(line) for line in (WORK / "pairs.jsonl").open(encoding="utf-8")]
    return [r for r in rows if not only or any(r["sha256"].startswith(o) or r["citation"] == o for o in only)]


# -- records -------------------------------------------------------------------------------------------------------

def reading(sha):
    return WORK / "read" / f"{sha}.json"


def read(args):
    """The product's reading (legalpdf-read) of every pair without one, in this machine's part of them; --export DIR
    stages another machine's part instead: its PDFs, the list, the reader and its models, and read.cmd to run there,
    whose read/ folder is then copied into WORK/read."""
    import shutil
    k, n = map(int, args.part.split("/"))
    todo = [p for i, p in enumerate(read_pairs()) if i % n == k - 1 and not reading(p["sha256"]).is_file()]
    if args.export:
        stage = args.export
        (stage / "pdfs").mkdir(parents=True, exist_ok=True)
        for pair in todo: shutil.copyfile(pair["path"], stage / "pdfs" / f"{pair['sha256']}.pdf")
        (stage / "read.list").write_text("".join(f"{p['sha256']}\tpdfs\\{p['sha256']}.pdf\n" for p in todo), encoding="utf-8")
        shutil.copyfile(READER, stage / READER.name)
        for model in ("indra", "onnx"): shutil.copytree(RUNTIME / model, stage / "runtime" / model, dirs_exist_ok=True)
        (stage / "read.cmd").write_text(f"cd /d %~dp0\r\nset LEGALPDF_INDRA_MODEL_PACK=%~dp0runtime\\indra\r\n"
                                        f"set LEGALPDF_ONNXRUNTIME=%~dp0runtime\\onnx\\onnxruntime.dll\r\n"
                                        f"start /belownormal /wait {READER.name} read.list read\r\n", encoding="utf-8")
        # Started through WMI, the reading outlives the session that starts it (an ssh login).
        (stage / "start.ps1").write_text('$command = "cmd.exe /c `"`"$PSScriptRoot\\read.cmd`" > `"$PSScriptRoot\\read.log`" 2>&1`""\n'
                                         "$started = Invoke-CimMethod Win32_Process -MethodName Create -Arguments "
                                         "@{ CommandLine = $command; CurrentDirectory = $PSScriptRoot }\n"
                                         '"started process $($started.ProcessId) (return $($started.ReturnValue))"\n', encoding="utf-8")
        print(f"{len(todo)} PDFs staged in {stage}: copy it there and run start.ps1 (powershell -File), then copy its read\\ "
              f"into {WORK / 'read'}")
        return
    (WORK / "read.list").write_text("".join(f"{p['sha256']}\t{p['path']}\n" for p in todo), encoding="utf-8")
    env = {**os.environ, "LEGALPDF_INDRA_MODEL_PACK": str(RUNTIME / "indra"), "LEGALPDF_ONNXRUNTIME": str(RUNTIME / "onnx/onnxruntime.dll")}
    subprocess.run([str(READER), str(WORK / "read.list"), str(WORK / "read")], env=env, check=True,
                   creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS)


def record_path(sha):
    return WORK / "records" / f"{sha}.json.gz"


def load(sha):
    with gzip.open(record_path(sha), "rt", encoding="utf-8") as stream: return json.load(stream)


def read_digest(sha):
    return hashlib.sha256(reading(sha).read_bytes()).hexdigest()[:16]


def align_all(args):
    done = align.align_all(WORK, A2AJ, args.only, args.limit)
    print(f"{done['aligned']} aligned, {done['failed']} failed in {done['seconds']:.1f} s on {done['threads']} threads "
          f"(reading {done['reading_seconds']:.1f} s, aligning {done['aligning_seconds']:.1f} s over the threads, "
          f"writing {done['writing_seconds']:.1f} s)")


def records(aligned_only=True):
    for path in sorted((WORK / "records").glob("*.json.gz")):
        record = load(path.name[:64])
        if not aligned_only or not record["verdict"]["refused"]: yield record


def in_gold_store():
    """The sources of the gold store: never silver, and kept out of training data made here."""
    return {p.name for p in gold_store.ROOT.iterdir() if len(p.name) == 64} if gold_store.ROOT.is_dir() else set()


def durable(pair):
    """The PDF's path in the corpus home, as the corpus's files table has it: a PDF the corpus does not hold (the
    disposable A2AJ PDF cache's, the app library's) is stored there first (legal-pdf, judgment)."""
    with sqlite3.connect(f"file:{corpus_store.DB}?mode=ro", uri=True) as db:
        row = db.execute("select path from files where sha256 = ?", (pair["sha256"],)).fetchone()
    if row: return Path(row[0]).as_posix()
    meta = {"collection": "legal-pdf", "kind": "judgment", "jurisdiction": "ca", "label": pair["citation"],
            "provenance": f"{pair['path']}, paired with its A2AJ decision and stored for its {LABEL_SOURCE} structure gold"}
    db = corpus_store.connect()
    try:
        sha = corpus_store.add_file(db, Path(pair["path"]).read_bytes(), "application/pdf", corpus_store.place(meta))
        corpus_store.note(db, sha, meta)
        db.commit()
        (stored,) = db.execute("select path from files where sha256 = ?", (sha,)).fetchone()
    finally:
        db.close()
    return Path(stored).as_posix()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


# -- modes ---------------------------------------------------------------------------------------------------------

def text_layer(args):
    """The lines our recognizer read, each with its exact text: OCR training data (the line's crop, the words it prints)."""
    written, gold = 0, in_gold_store()
    for record in records():
        if record["pair"]["sha256"] in gold: continue
        lines = [{"id": l["id"], "page": l["page"], "bbox": l["bbox"], "ocr": l["text"], "exact": l["exact"] or l["text"],
                  "status": l["status"], "lang": l["lang"], "span": l["span"]} for l in record["lines"] if l["source"] == "ocr"]
        if not lines: continue
        matched = [l for l in lines if l["status"] != "unmatched"]
        errors = [(align.edit_distance(" ".join(l["ocr"].split()), " ".join(l["exact"].split())), len(" ".join(l["exact"].split())))
                  for l in matched]
        write(WORK / "text-layers" / f"{record['pair']['sha256']}.json",
              {"source_sha256": record["pair"]["sha256"], "pdf_path": record["pair"]["path"], "a2aj": record["pair"],
               "reading": record["reading"], "pages": record["pages"], "languages": record["verdict"]["by_language"],
               "lines": lines, "stats": {**Counter(l["status"] for l in lines),
               "ocr_char_agreement": round(1 - sum(e for e, _ in errors) / max(1, sum(n for _, n in errors)), 4)}})
        written += 1
    print(f"{written} text layers -> {WORK / 'text-layers'}")


def listings(keys):
    """A2AJ's structure reading of each `<document id>:<language>` (the census listing)."""
    want, found = {'{"key":"' + k + '"': k for k in keys}, {}
    with open(LISTING, encoding="utf-8") as stream:
        for line in stream:
            head = line[:line.find(",")]
            if head in want: found[want[head]] = json.loads(line)["nodes"]
    return found


def nodes(listing):
    """(kind, label, start, end) of each node of a listing (labels may hold spaces; a note has two spans)."""
    out = []
    for item in listing.split(";"):
        m = re.match(r"^(\S+) (.*) (\d+)-(\d+) (\S+)$", item)
        if m: out.append((m.group(1), m.group(2), int(m.group(3)), int(m.group(4))))
    return out


def placed(record, language, text, start, end):
    """The PDF's lines that print [start, end) of a language's text: [line id, page, first, last offset] each, and the
    share of its words they place."""
    text_words = [a for _, a, _ in align.words_of(text, start) if a < end]
    on, at = {}, set()
    for line in record["lines"]:
        if line["lang"] != language: continue
        for begin, finish, a, _, _ in line["words"]:
            if start <= a < end:
                at.add(a)
                first, last, _ = on.get(line["id"], (begin, finish, line["page"]))
                on[line["id"]] = (min(first, begin), max(last, finish), line["page"])
    lines = [[i, page, a, b] for i, (a, b, page) in on.items()]
    return lines, round(len(at) / max(1, len(text_words)), 4)


def passages(args):
    """Each numbered paragraph and quotation of A2AJ's reading, in every language the PDF prints (a parallel report's
    two), with the PDF lines that print it (each unit's `lang`), and where the report's pages begin (page_breaks, in
    the main language)."""
    # One record in memory at a time (all 4,735 run past 6 GB): the listings of every pair's languages, read first.
    db = a2aj()
    found = listings({f"{p['a2aj']}:{language}" for p in read_pairs() for language in p["languages"]})
    written = Counter()
    for record in records():
        sha, main = record["pair"]["sha256"], record["verdict"]["main"]
        row = db.execute("select * from document where id = ?", (record["pair"]["a2aj"],)).fetchone()
        units = {"paragraph": [], "quote": []}
        for language in record["page_breaks"]:
            listing = found.get(f"{record['pair']['a2aj']}:{language}")
            if listing is None: written[f"no census listing ({language})"] += 1; continue
            text = a2aj_text(row, language)
            for kind, label, start, end in nodes(listing):
                if kind == "paragraph" and label.startswith("par") or kind == "quote":
                    lines, share = placed(record, language, text, start, end)
                    units[kind].append({"lang": language, "number": label[3:] if kind == "paragraph" else None, "span": [start, end],
                                        "text": text[start:end].strip(), "placed": share, "exact": share >= PLACED, "lines": lines})
        write(WORK / "passages" / f"{sha}.json", {"source_sha256": sha, "pdf_path": record["pair"]["path"],
              "citation": record["pair"]["citation"], "language": main, "languages": sorted(record["page_breaks"]),
              "paragraphs": units["paragraph"], "quotations": units["quote"], "page_breaks": record["page_breaks"].get(main, [])})
        written["written"] += 1
    print(f"passages: {dict(written)} -> {WORK / 'passages'}")


def gate(record):
    """Why an aligned record makes no gold (None where it makes one): a language the PDF prints with under 97% of its
    words placed; unexplained lines over 2% of the lines that print text; a line the reader ran across both columns of
    a bilingual page (such a PDF waits to be read again); words placed out of order or elsewhere over 0.5% of those
    placed; or more than ten unexplained lines after A2AJ's last placed word (the PDF runs on into another case)."""
    verdict, lines = record["verdict"], record["lines"]
    if verdict["refused"]: return "alignment refused"
    if any(share < 0.97 for lang, share in verdict["coverage"].items() if lang not in verdict["not_printed"]):
        return "printed language placed under 97%"
    body = sum(1 for line in lines if line.get("why") not in NONTEXT)
    if verdict["unmatched"].get("unexplained", 0) > 0.02 * body: return "unexplained lines over 2%"
    if verdict["unmatched"].get("joined_columns"): return "lines joined across columns"
    astray = sum(n for runs in verdict["unplaced"].values() for why, n in runs.items() if why in ("out_of_order", "other", "on_joined_columns"))
    if astray > 0.005 * sum(len(line["words"]) for line in lines): return "words out of order over 0.5%"
    last = max((k for k, line in enumerate(lines) if line["words"]), default=-1)
    if sum(1 for line in lines[last + 1:] if line.get("why") == "unexplained") > 10: return "runs past A2AJ's last placed word"
    return None


def partition(pair):
    """The partition of a pair's decision, which every PDF of the decision shares: test, the Supreme Court's reports of
    the 1990s (scanned, and the digital ones of 1996-99); development, its reports of 1973 and 1986; train, the rest."""
    year = re.match(r"\[(\d{4})\]", pair["citation"] or "") or re.match(r"(\d{4})", pair["date"] or "")
    year = int(year.group(1)) if year else 0
    if pair["court"] == "SCC" and 1990 <= year <= 1999: return "test"
    if pair["court"] == "SCC" and year in (1973, 1986): return "development"
    return "train"


def agreement(value, stored):
    """On the lines this gold and the store's gold of the same PDF read alike: this gold's paragraph markers and the
    store's (same line, same number), and this gold's headings (their units' first lines) and the store's heading lines."""
    said = lambda g: {l["id"]: " ".join((l.get("corrected") or l["text"]).split()) for l in g["lines"]}
    ours, theirs = said(value), said(stored)
    shared = {i for i, t in ours.items() if theirs.get(i) == t}
    def markers(g, text):
        return {(m[0]["line_id"], text[m[0]["line_id"]][m[0]["start"]:m[0]["end"]].strip("[](). ")) for t in g["typed"]
                if t["region"] in ("text", "provision") for m in t["markers"] if m and m[0]["line_id"] in shared}
    raw = lambda g: {l["id"]: l.get("corrected") or l["text"] for l in g["lines"]}
    mine, gold_marks = markers(value, raw(value)), markers(stored, raw(stored))
    heads = {value["typed"][u["lines"][0]]["spans"][0]["line_id"] for u in value["units"] if value["typed"][u["lines"][0]]["region"] == "heading"}
    gold_heads = {s["line_id"] for t in stored["typed"] if t["region"] == "heading" for s in t["spans"]} & shared
    return Counter(lines=len(ours), shared=len(shared), markers=len(mine), markers_agreed=len(mine & gold_marks), markers_store=len(gold_marks),
                   headings=len(heads & shared), headings_agreed=len(heads & gold_heads), headings_store=len(gold_heads))


def outlines_of(pairs, db):
    """{(A2AJ document id, language): the case outline of its text} for these pairs, in one engine call."""
    keys, texts = [], []
    for pair in pairs:
        row = db.execute("select * from document where id = ?", (pair["a2aj"],)).fetchone()
        for lang in pair["languages"]:
            keys.append((pair["a2aj"], lang)); texts.append(a2aj_text(row, lang))
    return dict(zip(keys, engine("outline", texts))) if texts else {}


def convert(record, db, found, outlines):
    """(gold value, the languages it labels) of an aligned record (label.gold over each language the PDF prints), or
    raises label.Refused."""
    import label
    pair, verdict = record["pair"], record["verdict"]
    printed = sorted(lang for lang in verdict["coverage"] if lang not in verdict["not_printed"])
    missing = [lang for lang in printed if f"{pair['a2aj']}:{lang}" not in found]
    if missing: raise label.Refused(f"no census listing in {', '.join(missing)}")
    failed = [lang for lang in printed if not isinstance(outlines.get((pair["a2aj"], lang)), list)]
    if failed: raise label.Refused(f"no case outline in {', '.join(failed)}")
    row = db.execute("select * from document where id = ?", (pair["a2aj"],)).fetchone()
    sizes = {int(p): tuple(s) for p, s in record["pages"].items()}
    order = {record["lines"][i]["id"]: rank for rank, i in enumerate(align.column_order(record["lines"], record["pages"]))}
    texts = {lang: a2aj_text(row, lang) for lang in printed}
    typed, units, notes, report = label.gold(record, texts, {lang: align.start_of(text, lang) for lang, text in texts.items()},
                                             {lang: found[f"{pair['a2aj']}:{lang}"] for lang in printed},
                                             {lang: outlines[(pair["a2aj"], lang)] for lang in printed}, order,
                                             align.in_gutter(record["lines"], record["pages"]))
    authoring = {"label_source": LABEL_SOURCE, "a2aj_document_id": pair["a2aj"], "languages": printed, "citation": pair["citation"],
                 "dataset": pair["court"], "listing": LISTING.name, "alignment_code": record["code"], "document_starts": []}
    value = {"schema_version": "legal-structure-gold.v4", "source_sha256": pair["sha256"], "mode": pair["mode"], "page_count": pair["pages"],
             "parser": {"reading": record["reading"], "read_sha256": record["read"]}, "authoring": authoring, "label_source": LABEL_SOURCE,
             "lines": [{k: line[k] for k in ("id", "page", "text", "bbox")} for line in record["lines"]],
             "typed": typed, "units": units, "notes": notes, "report": report}
    import postcorrect
    postcorrect.apply(value, [{"lines": [l for l in record["lines"] if l["page"] == p], "height": sizes[p][1]} for p in sorted(sizes)])
    return value, printed


def gold(args):
    """Structure gold of label source a2aj-align in THE gold store (structure/a2aj-a, source.json with the decision's
    partition), for each aligned record that passes gate() and whose PDF the store does not hold from another source;
    then the store registered (gold_store.py). The PDFs the store does hold are the check, first: on them this gold's
    paragraph markers must agree with the store's at 99% or more and its headings at 85% or more, or nothing is
    written. --check stops after it. WORK/gold-results.json lists each record's outcome."""
    import label
    from codex_runner.artifacts import atomic_json, digest
    db = a2aj()
    chosen = [p for p in read_pairs(args.only) if record_path(p["sha256"]).is_file()]
    found = listings({f"{p['a2aj']}:{lang}" for p in chosen for lang in p["languages"]})
    held = {sha: gold_store.source(sha) for sha in in_gold_store()}
    foreign = lambda sha: sha in held and held[sha].get("label_source") != LABEL_SOURCE  # the store holds it from another source
    stored = [p for p in chosen if foreign(p["sha256"])]
    total, outlines = Counter(), outlines_of(stored, db)
    for pair in stored:
        record = load(pair["sha256"])
        try: value, _ = convert(record, db, found, outlines)
        except label.Refused as refusal: print(f"check {pair['citation']}: refused, {refusal.reason}"); continue
        runs = gold_store.structure_runs(gold_store.ROOT / pair["sha256"])
        if not runs: continue
        seen = agreement(value, gold_store.read(runs[0] / "gold.json.gz"))
        total += seen
        print(f"check {pair['citation']:<16} gate {gate(record) or 'passes'}; {dict(seen)}", flush=True)
    markers, headings = total["markers_agreed"] / max(1, total["markers"]), total["headings_agreed"] / max(1, total["headings"])
    print(f"check: paragraph markers {total['markers_agreed']}/{total['markers']} = {markers:.1%} (store marks {total['markers_store']}); "
          f"headings {total['headings_agreed']}/{total['headings']} = {headings:.1%} (store's {total['headings_store']})", flush=True)
    if args.check or markers < 0.99 or headings < 0.85:
        print("nothing written" + ("" if args.check else ": the check is under 99% markers / 85% headings")); return
    results, outlines = [], {}
    for n, pair in enumerate(chosen, 1):
        sha = pair["sha256"]
        outcome = {"sha256": sha, "citation": pair["citation"], "court": pair["court"], "mode": pair["mode"], "pages": pair["pages"], "a2aj": pair["a2aj"]}
        if foreign(sha):
            results.append({**outcome, "refused": "in the gold store"}); continue
        run = gold_store.ROOT / sha / "structure" / f"{GOLD_BATCH}-{gold_store.CURRENT_RUN}"
        made = json.loads((run / "receipt.json").read_text(encoding="utf-8")) if (run / "receipt.json").is_file() else {}
        if made.get("label_code") == LABEL_CODE and made.get("read_sha256") == read_digest(sha):  # made by this labelling from this reading
            results.append({**outcome, **made["outcome"]}); continue
        record = load(sha)
        why = gate(record)
        if why: results.append({**outcome, "refused": why}); continue
        if (pair["a2aj"], pair["languages"][0]) not in outlines:  # the outlines of the next 25 pairs, in one engine call
            outlines = outlines_of([p for p in chosen[n - 1:] if not foreign(p["sha256"])][:25], db)
        try: value, printed = convert(record, db, found, outlines)
        except label.Refused as refusal: results.append({**outcome, "refused": "labelling: " + re.sub(r"\d+", "N", refusal.reason)}); continue
        folder = gold_store.ROOT / sha
        regions = Counter(value["typed"][unit["lines"][0]]["region"] for unit in value["units"])
        written = {"written": True, "partition": partition(pair), "languages": printed, "regions": dict(regions), "lines": len(value["lines"]),
                   "unlabelled_lines": len(value["report"]["unlabelled_lines"]), "notes": len(value["notes"])}
        atomic_json(run / "gold.json.gz", value)
        atomic_json(run / "receipt.json", {"source_sha256": sha, "mode": pair["mode"], "status": "complete", "label_source": LABEL_SOURCE,
                                           "label_code": LABEL_CODE, "read_sha256": read_digest(sha), "authoring": value["authoring"],
                                           "pages": pair["pages"], "units": len(value["units"]), "typed_lines": len(value["typed"]),
                                           "postcorrections": len(value["postcorrections"]), "outcome": written,
                                           "gold_sha256": digest(run / "gold.json.gz")})
        # A hold stays until its repair is in and gold_store.release takes it off.
        held = {"hold": hold} if (hold := gold_store.source(sha).get("hold")) else {}
        atomic_json(folder / "source.json", {"partition": partition(pair), "language_layout": "parallel" if len(printed) > 1 else printed[0],
                                             "genre_group": "judgment", "country": "ca", "yardstick": GOLD_BATCH, "label_source": LABEL_SOURCE,
                                             "pdf": durable(pair), **held})
        results.append({**outcome, **written})
        if len(results) % 50 == 0: print(f"{n}/{len(chosen)}: {sum(1 for r in results if r.get('written'))} written", flush=True)
    write(WORK / "gold-results.json", {"results": results})
    print(f"gold: {sum(1 for r in results if r.get('written'))} of {len(results)} written; "
          f"refused {dict(Counter(r['refused'] for r in results if 'refused' in r).most_common())}")
    print("registered", gold_store.register())


def report(args):
    every = list(records(aligned_only=False))
    refused = Counter(re.sub(r"[\d.]+%", "N%", r["verdict"]["refused"]) for r in every if r["verdict"]["refused"])
    status, kinds, unmatched, missing, covered = Counter(), Counter(), Counter(), Counter(), {}
    for r in every:
        status.update(r["verdict"]["status"])
        unmatched.update(r["verdict"]["unmatched"])
        kinds.update(w[4] for line in r["lines"] for w in line["words"])
        for lang, whys in r["verdict"].get("unplaced", {}).items(): missing.update(whys)
        for lang, share in r["verdict"]["coverage"].items():
            if lang not in r["verdict"]["not_printed"]: covered.setdefault(lang, []).append(share)
    print(f"{len(every)} records ({sum(r['code'] != CODE for r in every)} made by other code than this): "
          f"{sum(1 for r in every if not r['verdict']['refused'])} aligned, refused {dict(refused)}")
    for lang, shares in sorted(covered.items()):
        shares.sort()
        print(f"  coverage of {lang} where printed: {len(shares)} records, median {shares[len(shares) // 2]}, lowest {shares[:5]}")
    print(f"  lines {dict(status)}; unmatched {dict(unmatched.most_common())}")
    print(f"  words {dict(kinds)}; unplaced {dict(missing.most_common())}")
    for folder in ("text-layers", "passages"):
        print(f"  {folder}: {len(list((WORK / folder).glob('*.json')))}")
    paragraphs = [p for f in (WORK / "passages").glob("*.json") for p in json.loads(f.read_text(encoding="utf-8"))["paragraphs"]]
    if paragraphs:
        print(f"  paragraphs placed exactly {sum(p['exact'] for p in paragraphs)} of {len(paragraphs)}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("pairs").add_argument("--by-citation", nargs="*", metavar="COLLECTION")
    r = sub.add_parser("read"); r.add_argument("--part", default="1/1"); r.add_argument("--export", type=Path)
    a = sub.add_parser("align"); a.add_argument("--only", nargs="*"); a.add_argument("--limit", type=int)
    sub.add_parser("text-layer")
    g = sub.add_parser("gold"); g.add_argument("--check", action="store_true"); g.add_argument("--only", nargs="*")
    sub.add_parser("passages")
    sub.add_parser("report")
    f = sub.add_parser("proof"); f.add_argument("out", type=Path)
    f.add_argument("--lines", type=int, default=24); f.add_argument("--paragraphs", type=int, default=12); f.add_argument("--seed", type=int, default=1)
    f.add_argument("--words", type=int, default=0, help="words of each kind of pairing")
    args = p.parse_args()
    if args.command == "proof":
        import functools
        import proof
        db = a2aj()
        text_of = functools.lru_cache(maxsize=64)(
            lambda doc, lang: a2aj_text(db.execute("select * from document where id = ?", (doc,)).fetchone(), lang))
        return proof.sheets(list(records()), args.out, args.lines, args.paragraphs, args.seed, WORK, args.words,
                            lambda record, lang: text_of(record["pair"]["a2aj"], lang))
    {"pairs": pairs, "read": read, "align": align_all, "text-layer": text_layer, "gold": gold, "passages": passages, "report": report}[args.command](args)


if __name__ == "__main__":
    main()
