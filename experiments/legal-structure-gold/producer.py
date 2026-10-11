"""Existing Kraken/PPDoc tools to the gold worker's declared OCR evidence."""
from argparse import Namespace
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import sys
import time

import ocr


def prepare(pdf, destination, config_path):
    """Return a rich extraction manifest; runtime paths belong to config_path."""
    import fitz
    from codex_runner.artifacts import atomic_json, digest, fingerprint, read_json

    pdf, config_path = Path(pdf).resolve(), Path(config_path).resolve()
    config = read_json(config_path)
    route = config["layout_source"]
    ocr.require(route in {"kraken", "ppdoc"}, "Unknown producer layout source")
    source = digest(pdf)
    olj = (config_path.parent / config["olj_root"]).resolve()
    postprocessor = olj / "tools/ocr/layout_regioning/ppdoc/postprocess_ppdoc_detection_json.py"
    old = config.get("reuse", {}).get(source, {}).get(route)
    if old:
        path = (config_path.parent / old["manifest"]).resolve()
        ocr.require(digest(path) == old["sha256"] and all(digest(path.parent / name) == sha for name, sha in old["files"].items()), "Cached producer artifacts changed")
        supplied = read_json(path)
        producer = supplied["ocr"]["producer"]
        ocr.require(producer["layout_source"] == route and all(producer[name+"_sha256"] == config["kraken"][name+"_sha256"] for name in ("recognizer", "segmenter")), "Cached producer models differ")
        ocr.require(supplied["ocr"]["ontology"] == config["ontology"], "Cached producer ontology differs")
        if route == "ppdoc":
            ocr.require(producer["ppdoc_source_model"]["model"]["sha256"] == config["ppdoc"]["model_sha256"], "Cached PPDoc model differs")
            ocr.require(producer["ppdoc_model_manifest_sha256"] == config["ppdoc"]["manifest_sha256"] and producer["ppdoc_postprocessor_sha256"] == digest(postprocessor), "Cached PPDoc configuration differs")
        ocr.load(pdf, supplied, path.parent)
        return path

    spec = importlib.util.spec_from_file_location("gold_remote_process", olj / "tools/ocr/shared/remote_process.py")
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    remote_powershell, ps_quote, run_process, scp_base = (getattr(helpers, name) for name in ("remote_powershell", "ps_quote", "run_process", "scp_base"))

    ontology_path = olj / "tools/ocr/layout_regioning/core/ppdoc_ontology_contract.py"
    ontology = config["ontology"]
    ocr.require(digest(ontology_path) == ontology["sha256"], "Producer ontology source changed")
    dpi = config.get("dpi", 300)
    ocr.require(type(dpi) is int and dpi >= 72, "Invalid producer DPI")
    stage_key = fingerprint({"source": source, "kraken": config["kraken"], "ppdoc": config.get("ppdoc"), "dpi": dpi,
                             "adapter": digest(Path(__file__)), "renderer": fitz.VersionBind})[:16]
    out = Path(destination).resolve() / source / stage_key
    out.mkdir(parents=True, exist_ok=True)
    args = Namespace(ssh_host=config["ssh_host"], connect_timeout=15)
    remote = PureWindowsPath(config["remote_root"]) / source / stage_key
    wsl = PurePosixPath(config["wsl_root"]) / source / stage_key
    timeout = int(config.get("timeout_seconds", 300))
    ocr.require(timeout > 0, "Invalid producer timeout")
    identity = fingerprint({"source": source, "config": config, "adapter": digest(Path(__file__)),
                            "ontology": digest(ontology_path), "postprocessor": digest(postprocessor) if route == "ppdoc" else None,
                            "renderer": fitz.VersionBind})
    manifest_path = out / f"extraction-{route}.json"
    receipt_path = out / f"producer-{route}.json"
    if receipt_path.is_file():
        saved = read_json(receipt_path)
        if saved.get("identity") == identity and saved.get("status") == "complete":
            ocr.require(all((out / name).is_file() and digest(out / name) == sha for name, sha in saved["files"].items()), "Producer cache artifact changed")
            ocr.load(pdf, read_json(manifest_path), out)
            return manifest_path
    receipt = {"source_sha256": source, "identity": identity, "config_sha256": digest(config_path),
               "producer_code_sha256": digest(Path(__file__)), "started_at": datetime.now(timezone.utc).isoformat(),
               "status": "running", "steps": []}
    atomic_json(receipt_path, receipt)

    def record(name, command, result, started):
        (out / (name + ".log")).write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
        receipt["steps"].append({"name": name, "command": command, "seconds": round(time.monotonic()-started, 3), "returncode": result.returncode})
        atomic_json(receipt_path, receipt)
        print(f"Producer {name}: {result.returncode}", flush=True)
        if result.returncode:
            raise RuntimeError(f"Producer {name} failed; see {out / (name + '.log')}")
        return result.stdout.strip()

    def remote_step(name, script):
        started = time.monotonic()
        return record(name, script, remote_powershell(args, "$ProgressPreference='SilentlyContinue'\n"+script, encoded=True, timeout=timeout+30, check=False), started)

    def transfer(local, distant, download=False):
        command = scp_base(args) + ([f"{args.ssh_host}:{distant}", str(local)] if download else [str(local), f"{args.ssh_host}:{distant}"])
        started = time.monotonic()
        record(("download-" if download else "upload-")+Path(local).name, command, run_process(command, timeout=timeout, check=False), started)

    def wsl_step(name, argv):
        return remote_step(name, "& wsl -- timeout --signal=TERM --kill-after=10s " + str(timeout) + "s " + " ".join(ps_quote(str(v)) for v in argv) + "\nexit $LASTEXITCODE")

    try:
        remote_step("mkdir", "New-Item -ItemType Directory -Force -Path " + ps_quote(str(remote)) + " | Out-Null")
        kraken = config["kraken"]
        models = {}
        for name in ("recognizer", "segmenter"):
            actual = wsl_step("hash-"+name, ["sha256sum", "--", kraken[name]]).split()[0]
            ocr.require(actual == kraken[name+"_sha256"], f"Remote {name} model differs")
            models[name+"_sha256"] = actual
        version = wsl_step("kraken-version", [kraken["executable"], "--version"])
        pages = []
        with fitz.open(pdf) as document:
            for number, page in enumerate(document, 1):
                image = out / f"page-{number:06}.png"
                page.get_pixmap(dpi=dpi, alpha=False).save(image)
                transfer(image, (remote / image.name).as_posix())
                transferred = wsl_step(f"image-hash-{number:06}", ["sha256sum", "--", wsl/image.name]).split()[0]
                ocr.require(transferred == digest(image), "Remote producer image changed")
                xml = image.with_suffix(".xml")
                page_receipt = out / f"kraken-{number:06}.json"
                if page_receipt.is_file():
                    previous = read_json(page_receipt)
                    ocr.require(previous["image_sha256"] == digest(image) and previous["pagexml_sha256"] == digest(xml), "Kraken page cache changed")
                else:
                    wsl_step(f"kraken-{number:06}", [kraken["executable"], "--device", kraken.get("device", "cuda:0"), "--threads", "1", "--raise-on-error", "--no-subline-segmentation", "--pagexml", "-i", wsl/image.name, wsl/xml.name, "segment", "--baseline", "--model", kraken["segmenter"], "ocr", "--model", kraken["recognizer"], "--num-line-workers", "0"])
                    transfer(xml, (remote / xml.name).as_posix(), True)
                    atomic_json(page_receipt, {"image_sha256": digest(image), "pagexml_sha256": digest(xml)})
                pages.append({"page": number, "dpi": dpi, "image": image.name, "pagexml": xml.name})
        producer = {"layout_source": route, "kraken_version": version, **models,
                    "producer_code_sha256": receipt["producer_code_sha256"]}
        if route == "ppdoc":
            ppdoc = config["ppdoc"]
            for name, expected in (("model.onnx", ppdoc["model_sha256"]), ("manifest.json", ppdoc["manifest_sha256"])):
                actual = remote_step("hash-ppdoc-"+name, "(Get-FileHash -Algorithm SHA256 -LiteralPath "+ps_quote(str(PureWindowsPath(ppdoc["model_pack"])/name))+").Hash.ToLowerInvariant()")
                ocr.require(actual == expected, "Remote PPDoc model differs")
            model_path = out / "ppdoc-model.json"
            transfer(model_path, (PureWindowsPath(ppdoc["model_pack"])/"manifest.json").as_posix(), True)
            image_list = out / "images.txt"
            image_list.write_text("\n".join(str(remote/p["image"]) for p in pages)+"\n", encoding="utf-8")
            transfer(image_list, (remote/image_list.name).as_posix())
            argv = [ppdoc["executable"], "infer", "--model-pack", ppdoc["model_pack"], "--device", "cpu", "--providers", "CPUExecutionProvider", "--strict-device", "--threads", "1", "--image-backend", "opencv", "--image-dir", str(remote), "--image-list", str(remote/image_list.name), "--output-dir", str(remote/"ppdoc_raw"), "--output-layout", "flat", "--batch-size", "1", "--threshold", "0.1", "--no-check-dpi", "--no-resume"]
            code = "import subprocess,sys; p=subprocess.Popen(sys.argv[1:]);\ntry: p.wait(timeout="+str(timeout)+")\nexcept subprocess.TimeoutExpired:\n subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F']); raise\nsys.exit(p.returncode)"
            remote_step("ppdoc", "& "+" ".join(ps_quote(str(v)) for v in [ppdoc["python"], "-c", code, *argv])+"\nexit $LASTEXITCODE")
            (out/"ppdoc_raw").mkdir(exist_ok=True)
            for page in pages:
                name = Path(page["image"]).with_suffix(".json").name
                transfer(out/"ppdoc_raw"/name, (remote/"ppdoc_raw"/name).as_posix(), True)
            page_list = out/"pages.txt"
            page_list.write_text("\n".join(str(out/p["pagexml"]) for p in pages)+"\n", encoding="utf-8")
            context = out/"pages.jsonl"
            context.write_text("".join(json.dumps({"pagexml":str(out/p["pagexml"]),"article_key":source,"pdf_page":p["page"],"article_page_index":p["page"]-1,"article_page_count":len(pages)})+"\n" for p in pages),encoding="utf-8")
            command = [sys.executable, str(postprocessor), "--test-list", str(page_list), "--page-manifest-jsonl", str(context), "--detection-json-dir", str(out/"ppdoc_raw"), "--run-id", "gold-input", "--output-root", str(out/"postprocess"), "--diagnostic-no-sqlite", "--replace-output"]
            started = time.monotonic()
            record("postprocess", command, run_process(command, timeout=timeout, check=False), started)
            for page in pages:
                page["ppdoc_postprocessed"] = "postprocess/gold-input/raw_layout_json/"+Path(page["image"]).with_suffix(".json").name
            producer.update(ppdoc_source_model=read_json(model_path), ppdoc_model_manifest_sha256=digest(model_path), ppdoc_postprocessor_sha256=digest(postprocessor))
        atomic_json(manifest_path, {"source_sha256":source,"ocr":{"ontology":ontology,"producer":producer},"pages":pages})
        ocr.load(pdf, read_json(manifest_path), out)
        artifacts = [manifest_path, *(out/p[k] for p in pages for k in ("image","pagexml","ppdoc_postprocessed") if k in p)]
        receipt.update(status="complete", files={p.relative_to(out).as_posix():digest(p) for p in artifacts})
        return manifest_path
    except BaseException as exc:
        receipt.update(status="failed", error=str(exc))
        raise
    finally:
        receipt["finished_at"] = datetime.now(timezone.utc).isoformat()
        atomic_json(receipt_path, receipt)
