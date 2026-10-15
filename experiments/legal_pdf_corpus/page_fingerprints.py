"""Prepare durable visual page evidence; export unreviewed duplicate candidates.

From the workspace root (explicit source preparation, no OCR or model calls)::

    python experiments/legal_pdf_corpus/page_fingerprints.py --selection benchmarks/local-data/legal-structure-gold/family-selection.json --prepare

Use --sha SHA [SHA ...] instead for explicit corpus sources. Omit --prepare to
export already prepared evidence through a read-only corpus connection.

The existing canonical corpus.sqlite owns page_visual_fingerprints, keyed by
source SHA256, one-based page and render-configuration SHA256. Rows retain raw
grayscale pixel SHA256, raster dimensions, 64-bit dHash, source page count and
full renderer/MuPDF/Pillow/config identity. Pixel equality means equality at
this configuration only. The default raster's longest edge is 256 pixels.

Preparation verifies source bytes, catalogue page count when known and cached
page counts; it rejects locked, non-PDF, empty and MuPDF-repaired sources. Each
missing page renders once, commits independently and discards its raster. A
failed run retains completed pages and can resume with the same configuration.

page_visual_diagnostics stores deduplicated warning/error bodies durably under
source/config/page (page 0 means document opening, validation or closing).
Warnings do not imply clean evidence and are retained even for failed pages.
Candidate exports expose diagnostic_sources and diagnostic details, alongside
missing/incomplete source coverage. Reruns do not erase earlier diagnostics.

Private page-visual-candidates.json contains exact raster groups and unreviewed
complete compact signature groups and neighbouring-signature relationships.
Neither grouping writes family membership nor marks any review complete. The
output remains inside benchmarks/local-data/legal-structure-gold and atomically
replaces the prior candidate file; no page images or scratch receipts persist.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from collections import defaultdict
import hashlib
import json
import os
import tempfile
from pathlib import Path
import re
import sqlite3

import corpus_store

PRIVATE = Path(__file__).resolve().parents[2] / "benchmarks/local-data/legal-structure-gold"


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def sources(shas, selection):
    if selection:
        value = json.loads(selection.read_text(encoding="utf-8-sig"))
        if value.get("schema_version") != "pdf-structure-gold-membership.v1":
            raise ValueError("Expected prepared corpus membership selection")
        shas = [member["sha256"] for member in value["members"]]
    result = sorted(set(shas))
    if not result or any(not re.fullmatch(r"[0-9a-f]{64}", sha) for sha in result):
        raise ValueError("Select explicit corpus SHA256 identities")
    return result


def configuration(edge):
    import fitz
    import PIL
    value = {"schema":"page-visual.v1", "renderer":"PyMuPDF", "version":fitz.VersionBind,
             "mupdf":fitz.VersionFitz, "pillow":PIL.__version__, "max_edge":edge,
             "colorspace":"gray", "alpha":False, "annotations":True,
             "rotation":"page", "antialias":8, "signature":"dhash-9x8-lanczos"}
    return value, hashlib.sha256(encoded(value).encode()).hexdigest()


def save_diagnostics(db, sha, config_sha, page, error=None):
    import fitz
    warnings = fitz.TOOLS.mupdf_warnings(reset=True)
    if warnings or error:
        value = {"warnings":warnings, "error":error}
        body = encoded(value)
        db.execute("insert into page_visual_diagnostics values (?,?,?,?,?,?) "
                   "on conflict(sha256,config_sha256,page,diagnostic_sha256) do nothing",
                   (sha,config_sha,page,hashlib.sha256(body.encode()).hexdigest(),body,corpus_store.now()))
        db.commit()


@contextmanager
def diagnostic_scope(db, sha, config_sha, page):
    error = None
    try:
        yield
    except Exception as exc:
        error = type(exc).__name__ + ": " + str(exc)
        raise
    finally:
        save_diagnostics(db, sha, config_sha, page, error)


def prepare(db, shas, config, config_sha):
    import fitz
    from PIL import Image
    fitz.TOOLS.set_aa_level(config["antialias"])
    for sha in shas:
        row = db.execute("select path,pages from files where sha256=?", (sha,)).fetchone()
        if row is None:
            raise ValueError("Source missing from canonical corpus: " + sha)
        path = (corpus_store.HOME / row[0]).resolve()
        if not path.is_relative_to(corpus_store.HOME.resolve()):
            raise ValueError("Corpus source path escapes canonical owner")
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != sha:
                raise ValueError("Corpus source bytes changed: " + sha)
        cached = list(db.execute(
            "select page,page_count from page_visual_fingerprints where sha256=? and config_sha256=?", (sha, config_sha)))
        existing = {r[0] for r in cached}
        fitz.TOOLS.reset_mupdf_warnings()
        with diagnostic_scope(db, sha, config_sha, 0), fitz.open(path) as document:
            if not document.is_pdf or document.needs_pass or not len(document):
                raise ValueError("Source must be an unlocked nonempty PDF")
            if getattr(document, "is_repaired", False):
                raise ValueError("PDF requires MuPDF structural repair")
            if row[1] is not None and row[1] != len(document):
                raise ValueError("Catalogue page count differs from immutable PDF")
            if any(total != len(document) or not 1 <= page <= len(document) for page,total in cached):
                raise ValueError("Cached visual evidence page count differs from immutable PDF")
            save_diagnostics(db, sha, config_sha, 0)
            for index in range(len(document)):
                if index + 1 in existing:
                    continue
                with diagnostic_scope(db, sha, config_sha, index + 1):
                    page = document[index]
                    edge = max(page.rect.width, page.rect.height)
                    if edge <= 0:
                        raise ValueError("Page has invalid dimensions")
                    scale = config["max_edge"] / edge
                    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY,
                                            alpha=False, annots=True)
                    pixels = pixmap.samples
                    raster_sha = hashlib.sha256(pixels).hexdigest()
                    image = Image.frombytes("L", (pixmap.width, pixmap.height), pixels)
                    small = image.resize((9, 8), Image.Resampling.LANCZOS)
                    values = list(small.getdata())
                    signature = 0
                    for y in range(8):
                        for x in range(8):
                            signature = (signature << 1) | int(values[y*9+x] > values[y*9+x+1])
                    db.execute("insert into page_visual_fingerprints values (?,?,?,?,?,?,?,?,?,?) "
                               "on conflict(sha256,page,config_sha256) do nothing",
                               (sha,index+1,config_sha,encoded(config),pixmap.width,pixmap.height,
                                raster_sha,f"{signature:016x}",len(document),corpus_store.now()))
                    db.commit()
                    del pixels, pixmap, image, small
        print(sha, flush=True)


def candidates(db, shas, config_sha):
    rasters = {}
    missing, incomplete, diagnostics = [], [], []
    count = 0
    for sha in shas:
        diagnostics.extend({"sha256":sha,"page":page,"diagnostic":json.loads(body)}
            for page,body in db.execute("select page,diagnostic_json from page_visual_diagnostics "
                                       "where sha256=? and config_sha256=? order by page,diagnostic_sha256", (sha,config_sha)))
        rows = db.execute("select page,width,height,raster_sha256,dhash,page_count from page_visual_fingerprints "
                          "where sha256=? and config_sha256=? order by page", (sha,config_sha))
        page_numbers = []
        expected_count = None
        for page,width,height,raster,signature,page_count in rows:
            page_numbers.append(page)
            if expected_count is not None and expected_count != page_count:
                raise ValueError("Cached page counts differ for one immutable source")
            expected_count = page_count
            count += 1
            key = (width,height,raster)
            group = rasters.setdefault(key, {"signature":signature,"pages":[]})
            if group["signature"] != signature:
                raise ValueError("Equal cached rasters have inconsistent signatures")
            group["pages"].append([sha,page])
        if not page_numbers:
            missing.append(sha)
        if expected_count is None or page_numbers != list(range(1,expected_count+1)):
            incomplete.append(sha)

    signatures = defaultdict(list)
    signature_sources = defaultdict(set)
    exact = []
    for (width,height,raster), group in sorted(rasters.items()):
        entry = {"width":width,"height":height,"raster_sha256":raster,"pages":group["pages"]}
        signature = group["signature"]
        signatures[signature].append(entry)
        sources = {page[0] for page in group["pages"]}
        signature_sources[signature].update(sources)
        if len(sources) > 1:
            exact.append(entry)

    # Within-signature Cartesian products are represented by group membership,
    # not expanded page pairs. Four disjoint 16-bit bands find every pair within
    # three changed bits: at least one band must remain identical.
    bands = defaultdict(list)
    neighbours = []
    for signature in sorted(signatures):
        bits = int(signature,16)
        seen = set()
        for band in range(4):
            bucket = (band,(bits >> (band*16)) & 65535)
            for other,other_bits in bands[bucket]:
                if other in seen:
                    continue
                seen.add(other)
                distance = (bits ^ other_bits).bit_count()
                if distance <= 3 and len(signature_sources[signature] | signature_sources[other]) > 1:
                    neighbours.append({"signatures":[other,signature],"dhash_distance":distance})
            bands[bucket].append((signature,bits))
    return {"schema_version":"page-visual-candidates.v2", "config_sha256":config_sha,
            "status":"unreviewed_candidates", "sources":shas,"fingerprinted_pages":count,
            "missing_sources":missing,"incomplete_sources":incomplete,
            "diagnostic_sources":sorted({item["sha256"] for item in diagnostics}),"diagnostics":diagnostics,
            "similarity_truncated":False,
            "exact_raster_groups":exact,
            "signature_groups":[{"signature":signature,"set_bit_count":int(signature,16).bit_count(),
                "cross_source":len(signature_sources[signature]) > 1,"rasters":signatures[signature]}
                for signature in sorted(signatures)],
            "neighbouring_signatures":neighbours,
            "meaning":"Signature groups retain every raster and source/page occurrence. Cross-source page pairs "
                      "within a signature have distance zero; neighbouring signatures encode all cross-source "
                      "pairs at distances one through three without expanding their Cartesian products. "
                      "Exact groups share raw pixels and dimensions at this render configuration only. "
                      "Dimensions and set-bit counts are review evidence, not exclusions or blankness labels. "
                      "Perceptual matches require review; neither establishes document-family membership."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--sha", nargs="+")
    inputs.add_argument("--selection", type=Path)
    parser.add_argument("--prepare", action="store_true", help="Render missing pages and persist corpus evidence")
    parser.add_argument("--max-edge", type=int, default=256)
    parser.add_argument("--output", type=Path, default=PRIVATE / "page-visual-candidates.json")
    args = parser.parse_args()
    if not 64 <= args.max_edge <= 1024:
        parser.error("max-edge must be 64..1024")
    output = args.output.resolve()
    if not output.is_relative_to(PRIVATE.resolve()):
        parser.error("Candidate export must remain in the private legal-structure-gold owner")
    shas = sources(args.sha or [], args.selection)
    config, config_sha = configuration(args.max_edge)
    if args.prepare:
        db = corpus_store.connect()
    else:
        db = sqlite3.connect(corpus_store.DB.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if args.prepare:
            prepare(db, shas, config, config_sha)
        result = candidates(db, shas, config_sha)
    finally:
        db.close()
    result["configuration"] = config
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=".page-visual-", suffix=".json", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(output)


if __name__ == "__main__":
    main()
