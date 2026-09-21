"""Serial corpus worker for the PDF project's source-ID composer."""
import argparse
import ctypes
import hashlib
import gzip
import json
import os
from pathlib import Path
import shutil
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "legal-pdf-parser" / "src"))
COMPOSER = HERE.parents[1] / "legal-pdf-parser" / "experiments" / "structure-composer"
sys.path.insert(0, str(COMPOSER))
from legalpdf.codex_repair import _atomic_json, _invoke


def low_priority():
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.nice(10)
    os.environ.update(OMP_NUM_THREADS="1", RAYON_NUM_THREADS="1")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    _atomic_json(path, value)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def prepare(pdf, evidence, expected):
    import fitz

    source_hash = digest(pdf)
    require(not expected.get("sha256") or expected["sha256"] == source_hash,
            f"Manifest SHA256 mismatch: {pdf}")
    evidence.mkdir()
    files = {}
    with fitz.open(pdf) as doc:
        require(not doc.needs_pass, "Encrypted PDF requires an unlocked source")
        require(len(doc) > 0, "Empty PDF")
        require(not expected.get("pages") or expected["pages"] == len(doc),
                f"Manifest page-count mismatch: {pdf}")
        for number, page in enumerate(doc, 1):
            def box(raw):
                rect = fitz.Rect(raw) * page.rotation_matrix
                rect = rect & page.rect
                if rect.is_empty:
                    return None
                return [round(v, 4) for v in (
                    1000 * rect.x0 / page.rect.width, 1000 * rect.y0 / page.rect.height,
                    1000 * rect.x1 / page.rect.width, 1000 * rect.y1 / page.rect.height)]

            atoms = []
            for block in page.get_text("dict", sort=False, flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]:
                for line in block.get("lines", []):
                    bounds = box(line["bbox"])
                    if bounds is None:
                        continue
                    spans = []
                    text = ""
                    for span in line["spans"]:
                        start = len(text)
                        text += span["text"]
                        spans.append({"start": start, "end": len(text), "text": span["text"],
                                      "bbox": box(span["bbox"]), "font": span["font"],
                                      "size": span["size"], "flags": span["flags"],
                                      "color": span["color"]})
                    atoms.append({"id": f"p{number:06}.a{len(atoms) + 1:06}",
                                  "text": text, "bbox": bounds, "spans": spans})
            stem = f"page-{number:06}"
            page.get_pixmap(dpi=144, alpha=False).save(evidence / f"{stem}.png")
            write_json(evidence / f"{stem}.json", {
                "page": number, "width_points": page.rect.width,
                "height_points": page.rect.height, "rotation": page.rotation,
                "cropbox": list(page.cropbox), "mediabox": list(page.mediabox),
                "image": f"{stem}.png", "atoms": atoms})
            for suffix in ("json", "png"):
                name = f"{stem}.{suffix}"
                files[name] = digest(evidence / name)
            print(f"Prepared page {number}/{len(doc)}", flush=True)
        write_json(evidence / "manifest.json", {"extractor": f"PyMuPDF {fitz.VersionBind}",
                                               "dpi": 144, "files": files})
        source = {"record": "source", "id": "source", "schema_version": "legal-structure-gold.v1",
                  "sha256": source_hash, "page_count": len(doc),
                  "evidence_sha256": digest(evidence / "manifest.json"),
                  "coordinates": "visible-page-top-left-1000", "offset_unit": "unicode_scalar"}
        write_json(evidence / "source.json", source)
    return source


def call(prompt, schema, images, work, args):
    from jsonschema import Draft202012Validator
    work.mkdir()
    prompt += "\nRESPONSE SCHEMA:\n" + json.dumps(schema, ensure_ascii=False)
    write_json(work / "response.schema.json", schema)
    (work / "prompt.txt").write_text(prompt, encoding="utf-8")
    result, usage, seconds = _invoke(prompt=prompt, schema_path=work / "response.schema.json",
                                    image_paths=images, model=args.model, effort=args.effort,
                                    work_dir=work, timeout_seconds=args.timeout)
    write_json(work / "receipt.json", {"model": args.model, "effort": args.effort,
                                      "usage": usage, "seconds": seconds,
                                      "schema_sha256": digest(work / "response.schema.json"),
                                      "prompt_sha256": digest(work / "prompt.txt")})
    Draft202012Validator(schema).validate(result)
    return result


def run(pdf, expected, args):
    job = args.out.resolve() / digest(pdf)
    job.mkdir(parents=True, exist_ok=False)
    evidence = job / "evidence"
    receipt = {"status": "preparing", "model": args.model, "effort": args.effort, "radius": 1,
               "discover_elements": args.discover_elements, "worker_sha256": digest(Path(__file__)),
               "composer_sha256": digest(COMPOSER / "composer.py"),
               "started_at": time.time()}
    write_json(job / "receipt.json", receipt)
    try:
        if args.evidence:
            source = read_json(args.evidence / "source.json")
            require(source["sha256"] == digest(pdf), "Evidence belongs to another PDF")
            evidence = args.evidence.resolve()
            manifest = evidence / "manifest.json"
            require(digest(manifest) == source["evidence_sha256"], "Evidence manifest changed")
            for name, sha in read_json(manifest)["files"].items():
                require(Path(name).name == name and digest(evidence / name) == sha, "Evidence changed")
        else:
            source = prepare(pdf, evidence, expected)
        pages = [read_json(evidence / f"page-{p:06}.json") for p in range(1, source["page_count"] + 1)]
        if args.structure:
            from composer import compose
            with (gzip.open(args.structure, "rt", encoding="utf-8") if args.structure.suffix == ".gz"
                  else args.structure.open(encoding="utf-8")) as stream:
                baseline = json.load(stream)
            structure = baseline.get("baseline", baseline.get("structure", baseline))
            require(structure["source_sha256"] == source["sha256"], "Structure belongs to another PDF")
            target = args.target_page
            require(target is None or 1 <= target <= len(pages), "Target page outside source")
            context = pages[max(0, target - 2):target + 1] if target else pages
            targets = [target] if target else [p["page"] for p in pages]
            def dispatch(prompt, schema, attempt):
                return call(prompt, schema, [evidence / p["image"] for p in context],
                            job / f"repair-{attempt + 1}", args)
            product = compose(structure, context, targets, dispatch, current=baseline.get("composition"))
            write_json(job / "repair-result.json", product)
            receipt.update(status="machine_proposed", baseline_sha256=digest(args.structure),
                           validation=product["validation"],
                           changed_blocks=len(product["patch"]["blocks"]),
                           annotations=len(product["patch"]["annotations"]))
            print(json.dumps(receipt, indent=2), flush=True)
            return
    except BaseException as error:
        receipt.update(status="failed", error=str(error))
        raise
    finally:
        receipt["finished_at"] = time.time()
        write_json(job / "receipt.json", receipt)


def main():
    low_priority()
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--pdf", type=Path)
    choice.add_argument("--manifest", type=Path)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--out", type=Path, default=Path("tmp/structure-composer"))
    parser.add_argument("--evidence", type=Path, help="Reuse immutable evidence for one PDF")
    parser.add_argument("--structure", type=Path, required=True,
                        help="Existing native structure JSON or corpus snapshot .json.gz to repair")
    parser.add_argument("--limit", type=int, default=1, help="0 selects the whole supplied manifest")
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--effort", default="high", choices=("low", "medium", "high", "xhigh", "max"))
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--target-page", type=int, help="Compose one physical page with r=1 neighbours for corpus iteration")
    parser.add_argument("--discover-elements", action="store_true",
                        help="Collect anchored observations about structures missing from the modules")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    require(args.limit >= 0 and args.timeout > 0, "Invalid limit/timeout")
    require(not args.discover_elements, "Discovery is disabled for sparse repair")
    rows = [{"path": str(args.pdf.resolve())}] if args.pdf else read_json(args.manifest)["documents"]
    rows = rows[:args.limit] if args.limit else rows
    require(bool(rows) and (not args.evidence or len(rows) == 1), "Evidence reuse requires one PDF")
    require(len(rows) == 1, "A pinned structure snapshot repairs one PDF at a time")
    selected = [(args.root / r["path"]).resolve() for r in rows]
    require(all(p.is_file() for p in selected), "Source PDF missing")
    print(json.dumps({"run": args.run, "pdfs": [str(p) for p in selected], "radius": 1,
                      "workers": 1, "model": args.model, "effort": args.effort,
                      "discover_elements": args.discover_elements}), flush=True)
    if args.run:
        executable = os.environ.get("CODEX_EXEC_COMMAND") or shutil.which("codex.cmd" if os.name == "nt" else "codex")
        require(bool(executable), "Codex not found")
        os.environ["CODEX_EXEC_COMMAND"] = executable
        for pdf, row in zip(selected, rows):
            run(pdf, row, args)


if __name__ == "__main__":
    main()
