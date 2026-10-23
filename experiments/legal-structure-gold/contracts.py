"""Find complete Canadian contract exhibits, verify their boundaries, and catalogue excerpts.

Uses the shared Codex runner; author.py remains the gold authoring entry point.
Private selection/call receipts go under --out; source bytes live in corpus_store.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from types import SimpleNamespace
import unicodedata
import uuid

import fitz

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT / "tools"), str(HERE.parent / "legal_pdf_corpus")]
from codex_runner.artifacts import atomic_json, digest, read_json  # noqa: E402
from codex_runner.calls import call  # noqa: E402
from author import POLICY  # noqa: E402
import corpus_store  # noqa: E402
from gold import low_priority  # noqa: E402

CANADA = {"ca", "ab", "bc", "sk", "mb", "on", "qc", "nb", "ns", "pe", "nl", "nt", "nu", "yt"}
FIELDS = {"first": {"type": "integer"}, "last": {"type": "integer"},
          **{name: {"type": "string"} for name in ("title", "kind", "parties", "date")}}
ITEM = {"type": "object", "properties": FIELDS, "required": list(FIELDS), "additionalProperties": False}
PROPOSALS = {"type": "object", "properties": {"contracts": {"type": "array", "items": ITEM}},
             "required": ["contracts"], "additionalProperties": False}
REVIEW = {"type": "object", "properties": {
    "complete_agreement": {"type": "boolean"}, "canadian_nexus": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["complete_agreement", "canadian_nexus", "reason"], "additionalProperties": False}
REVIEW_POLICY = "complete-canadian-agreement.v2"

FIND = """Locate distinct complete agreements in this Canadian legal record using its page index.
Give physical PDF first/last page numbers, title, specific agreement kind, parties and date (empty
when not printed). Include the entire agreement and its schedules; never select an arbitrary
excerpt from a longer agreement. Agreements may be 1 to 120 pages; favour shorter and varied
agreements, amendments, releases, assignments, guarantees, waivers and letter agreements.
Exclude pleadings, reports about contracts, correspondence merely discussing them, quotations,
unfilled templates, and incomplete agreements. Do not count each schedule as a new agreement.
Exclude administrative payment directions, court undertakings, policy acknowledgments and
unilateral declarations; a trust agreement with mutual operative obligations can qualify.
The index shows each page's opening and closing lines. Return no candidate when boundaries
cannot be established from it. Proposed boundaries will be checked against page images.
"""
CHECK = """Check whether the proposed page range contains one complete operative agreement,
including its schedules. Images show the opening, ending and adjacent pages, labelled in order.
Reject a mid-agreement start/end, a schedule selected alone, an empty template, pleadings or a
report discussing an agreement. Signing pages need not have handwriting, but the instrument
must contain operative terms and a complete ending. A short operative amendment, release,
guarantee, assignment, waiver or letter agreement can qualify. Where the images leave the
boundaries uncertain, return false. The agreement itself must show a Canadian connection:
Canadian contracting parties, Canadian property/services, or Canadian governing law. A Canadian
court filing alone does not qualify a foreign-property instrument or an unrelated foreign
agreement. State the printed Canadian connection, or leave canadian_nexus empty. Do not count
conveyance deeds, administrative registration covers, court orders, board resolutions or
unilateral changes to a plan/policy as agreements. Exclude administrative payment directions,
court undertakings, policy acknowledgments and unilateral declarations even when signed. An
operative mortgage or trust agreement with mutual operative obligations can qualify. Explain
the boundary evidence briefly. Return false when the instrument lacks a Canadian connection.
"""


def normalized(text):
    return " ".join(re.findall(r"\w+", unicodedata.normalize("NFKC", text).casefold()))


def source_rows():
    with closing(sqlite3.connect(corpus_store.DB.as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("""select f.sha256,f.path,f.pages,d.jurisdiction,d.label,d.url,d.provenance
            from files f join documents d using(sha256)
            where d.collection in ('court-record-exhibits','court-record-sources')
            and d.url is not null and f.path like '%.pdf' and f.pages between 2 and 2000
            order by d.sha256,d.id""").fetchall()
    unique = {}
    for row in rows:
        if row["jurisdiction"] in CANADA:
            unique.setdefault(row["sha256"], dict(row))
    return sorted(unique.values(), key=lambda row: hashlib.sha256(
        ("canadian-contracts-v1:" + row["sha256"]).encode()).hexdigest())


def page_index(document):
    result = []
    for n, page in enumerate(document, 1):
        lines = [" ".join(line.split()) for line in page.get_text().splitlines() if line.strip()]
        result.append(f"PAGE {n}\n" + "\n".join(lines[:9]) + "\n[...]\n" + "\n".join(lines[-6:]))
    index = "\n\n".join(result)
    if len(index) <= 650_000:
        return index
    # Large appeal records exceed the runner input limit; retain every page.
    budget = max(40, 600_000 // len(document) // 2)
    return "\n\n".join(f"PAGE {n}\n" + page.get_text()[:budget] + "\n[...]\n" + page.get_text()[-budget:]
                       for n, page in enumerate(document, 1))


def proposed(response, count):
    seen = set()
    for item in response["contracts"]:
        first, last = item["first"], item["last"]
        if not 1 <= first <= last <= count or last - first + 1 > 120:
            raise ValueError("An agreement must be a complete 1–120 page range within this source")
        if (first, last) in seen or not item["title"].strip() or not item["kind"].strip():
            raise ValueError("Repeated range or missing agreement identity")
        seen.add((first, last))
    return response["contracts"]


def render(document, page, directory):
    target = directory / f"page-{page:04}.png"
    if not target.exists():
        rect = document[page - 1].rect
        document[page - 1].get_pixmap(matrix=fitz.Matrix(1536 / max(rect.width, rect.height),
            1536 / max(rect.width, rect.height)), alpha=False).save(target)
    return target


def review_pages(item, count):
    first, last = item["first"], item["last"]
    pages = (set(range(first, last + 1)) if last - first < 8 else
             set(range(first, first + 3)) | set(range(last - 2, last + 1)))
    return sorted(pages | {max(1, first - 1), min(count, last + 1)})


def review(source, item, directory, args, run_id):
    pages = review_pages(item, source["pages"])
    images = [directory / f"page-{page:04}.png" for page in pages]
    prompt = f"origin: machine_test; run_id: {run_id}\n" + CHECK + "\nPROPOSAL\n" + json.dumps({key: item[key] for key in FIELDS}) + "\nIMAGE PAGES: " + str(pages)
    result = call(prompt, args.out / "review-schema.json", images,
                  directory / "calls" / f"review-{item['first']:04}-{item['last']:04}", args,
                  lambda value: value, policy=POLICY)
    return {**result, "policy": REVIEW_POLICY, "pages_shown": pages}


def recheck(selection, target, args):
    rows = [row for row in selection["documents"] if row["boundary_review"].get("policy") != REVIEW_POLICY]
    prepared = []
    for row in rows:
        source = selection["sources"].get(row["parent_sha256"])
        if source is None:
            assert row["sha256"] == row["parent_sha256"]
            source = {"sha256": row["sha256"], "path": str(Path(row["path"]).relative_to(corpus_store.HOME)),
                      "pages": row["pages"], "label": row["title"], "url": row["source_url"]}
        directory = args.out / source["sha256"]
        directory.mkdir(exist_ok=True)
        with fitz.open(corpus_store.HOME / source["path"]) as document:
            for page in review_pages(row, len(document)):
                render(document, page, directory)
        prepared.append((source, row, directory))
    with ThreadPoolExecutor(args.parallel) as pool:
        results = pool.map(lambda task: review(task[0], task[1], task[2], args, selection["run_id"]), prepared)
        for (_, row, _), result in zip(prepared, results):
            row["boundary_review"] = result
            if not result["complete_agreement"] or not result["canadian_nexus"].strip():
                selection["documents"] = [doc for doc in selection["documents"] if doc["sha256"] != row["sha256"]]
                selection.setdefault("excluded", []).append(row)
            atomic_json(target, selection)
            print(json.dumps({"rechecked": row["sha256"][:12], "accepted": result["complete_agreement"],
                              "total": len(selection["documents"])}), flush=True)
    kept = {row["sha256"] for row in selection["documents"]}
    for source in selection["sources"].values():
        source["accepted"] = [sha for sha in source["accepted"] if sha in kept]
    selection["review_policy"] = REVIEW_POLICY
    atomic_json(target, selection)


def excerpt(document, first, last):
    # Select from a copy: page copying omits document-level rendering state.
    with (fitz.open(document.name) if document.name else
          fitz.open(stream=document.tobytes(no_new_id=True), filetype="pdf")) as output:
        output.select(list(range(first - 1, last)))
        # The parent filing's tags reference removed pages and retain their resources.
        output.xref_set_key(output.pdf_catalog(), "StructTreeRoot", "null")
        # Object merging can change font rasterization even when text is unchanged.
        body = output.tobytes(garbage=2, deflate=True, no_new_id=True)
    with fitz.open(stream=body, filetype="pdf") as output:
        assert len(output) == last - first + 1
        for n, page in enumerate(output):
            source = document[first - 1 + n]
            assert source.rect == page.rect, f"Excerpt dimensions differ at source page {first + n}"
            assert source.get_text() == page.get_text(), f"Excerpt native text differs at source page {first + n}"
            before = source.get_pixmap(alpha=False)
            after = page.get_pixmap(alpha=False)
            assert before.width == after.width and before.height == after.height
            assert before.samples == after.samples, "Excerpt boundary rendering differs"
    return body


def store(source, item, check, selection):
    if any(old["parent_sha256"] == source["sha256"] and item["first"] <= old["last"]
           and item["last"] >= old["first"] for old in selection["documents"]):
        return None
    with fitz.open(corpus_store.HOME / source["path"]) as document:
        text = normalized("\n".join(document[n].get_text() for n in range(item["first"] - 1, item["last"])))
        content = hashlib.sha256(text.encode()).hexdigest() if len(text) > 200 else None
        identity = normalized(item["title"] + " " + item["parties"] + " " + item["date"])
        if any((content and content == old.get("text_sha256")) or
               (item["parties"] and item["date"] and identity == old.get("agreement_identity"))
               for old in selection["documents"]):
            return None
        body = ((corpus_store.HOME / source["path"]).read_bytes()
                if item["first"] == 1 and item["last"] == len(document)
                else excerpt(document, item["first"], item["last"]))
        scans = sum(any(fitz.Rect(image["bbox"]).get_area() >= page.rect.get_area() * .9
            and image["width"] * image["height"] > 40_000 for image in page.get_image_info())
            for page in (document[n] for n in range(item["first"] - 1, item["last"])))
    url = source["url"].split("#")[0] + f"#page={item['first']}&endpage={item['last']}"
    meta = {"collection": "canadian-contract-excerpts", "jurisdiction": source["jurisdiction"],
            "kind": "contract", "label": item["title"], "provenance": json.dumps({
                "origin": "machine_test", "run_id": selection["run_id"], "parent_sha256": source["sha256"],
                "source_url": source["url"], "source_pages": [item["first"], item["last"]],
                "derivation": "Unmodified complete PDF pages; boundary rasters and all extracted text preserved"})}
    with closing(corpus_store.connect()) as db, db:
        sha = corpus_store.add_file(db, body, "application/pdf", corpus_store.place(meta))
        corpus_store.note(db, sha, meta, url)
        if sha != source["sha256"]:
            db.execute("insert or ignore into gold_memberships values (?,?,?,?)",
                       ("canadian-contracts.v1", sha, source["sha256"], sha))
        relative = db.execute("select path from files where sha256=?", (sha,)).fetchone()[0]
    return {**item, "path": str(corpus_store.HOME / relative), "sha256": sha,
            "pages": item["last"] - item["first"] + 1, "mode": "ocr" if scans * 2 >= item["last"] - item["first"] + 1 else "digitalborn",
            "jurisdiction": source["jurisdiction"], "parent_sha256": source["sha256"], "source_url": source["url"],
            "text_sha256": content, "agreement_identity": identity, "boundary_review": check,
            "partition_status": "unassigned pending source/proceeding family and exposure review"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "benchmarks/local-data/legal-structure-gold/contracts")
    parser.add_argument("--target", type=int, default=100)
    parser.add_argument("--sources", type=int, default=30, help="New parent sources to inspect in this invocation")
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--recheck", action="store_true", help="Recheck prior candidates against the current boundary/scope policy")
    parser.add_argument("--revisit", action="store_true", help="Revisit productive parents for additional, including larger agreements")
    options = parser.parse_args()
    low_priority()
    args = SimpleNamespace(model="gpt-6.1-sol", effort="low", attempts=3, timeout=900,
                           max_calls=None, parallel=options.parallel, out=options.out.resolve())
    args.out.mkdir(parents=True, exist_ok=True)
    atomic_json(args.out / "find-schema.json", PROPOSALS)
    atomic_json(args.out / "review-schema.json", REVIEW)
    target = args.out / "manifest.json"
    selection = read_json(target) if target.exists() else {"origin": "machine_test", "run_id": str(uuid.uuid4()),
        "target": options.target, "documents": [], "sources": {}, "scope": "Actual complete Canadian legal-record agreements, 1–120 pages"}
    if options.recheck:
        recheck(selection, target, args)
        return
    if any(row["boundary_review"].get("policy") != REVIEW_POLICY for row in selection["documents"]):
        raise ValueError("Run --recheck before extending an older selection")
    sources = ([row for row in source_rows() if selection["sources"].get(row["sha256"], {}).get("candidates")]
               if options.revisit else [row for row in source_rows() if row["sha256"] not in selection["sources"]])
    for source in sources[:options.sources]:
        if len(selection["documents"]) >= options.target:
            break
        directory = args.out / source["sha256"]
        directory.mkdir(exist_ok=True)
        try:
            assert digest(corpus_store.HOME / source["path"]) == source["sha256"]
            with fitz.open(corpus_store.HOME / source["path"]) as document:
                assert len(document) == source["pages"]
                index = page_index(document)
                prompt = f"origin: machine_test; run_id: {selection['run_id']}\n" + FIND + f"\nSOURCE: {source['label']}\n" + index
                items = call(prompt, args.out / "find-schema.json", [], directory / "calls" / "find", args,
                             lambda value: proposed(value, len(document)), policy=POLICY)
                items = sorted(items, key=lambda item: item["last"] - item["first"])[:20 if options.revisit else 5]
                for page in sorted({page for item in items for page in review_pages(item, len(document))}):
                    render(document, page, directory)
            with ThreadPoolExecutor(args.parallel) as pool:
                checked = list(pool.map(lambda item: review(source, item, directory, args, selection["run_id"]), items))
            accepted = list(selection["sources"].get(source["sha256"], {}).get("accepted", []))
            for item, check in zip(items, checked):
                if check["complete_agreement"] and check["canadian_nexus"].strip() and len(selection["documents"]) < options.target:
                    try:
                        row = store(source, item, check, selection)
                    except AssertionError as error:
                        selection.setdefault("materialization_failures", []).append({**item,
                            "parent_sha256": source["sha256"], "error": str(error) or "Source preservation check failed",
                            "origin": "machine_test", "run_id": selection["run_id"]})
                        continue
                    if row:
                        selection["documents"].append(row)
                        accepted.append(row["sha256"])
            selection["sources"][source["sha256"]] = {**source, "candidates": items, "reviews": checked, "accepted": accepted}
            atomic_json(target, selection)
            (directory / "error.json").unlink(missing_ok=True)
            print(json.dumps({"source": source["sha256"][:12], "proposed": len(items), "accepted": len(accepted),
                              "total": len(selection["documents"]), "kinds": dict(Counter(row["kind"] for row in selection["documents"]))}), flush=True)
        except Exception as error:
            atomic_json(directory / "error.json", {"origin": "machine_test", "run_id": selection["run_id"], "error": str(error)[-1500:]})
            raise


if __name__ == "__main__":
    main()
