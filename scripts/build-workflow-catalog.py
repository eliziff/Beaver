"""Build a reviewed, offline catalogue package from an exact workflow Git revision."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONTENT_TYPES = {".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                 ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown"}


def git(repo, *args):
    return subprocess.check_output(["git", "-c", f"safe.directory={repo.as_posix()}",
                                    "-C", str(repo), *args], text=True).strip()


def build(repo, revision, output, bundle=False):
    repo = repo.resolve()
    if git(repo, "rev-parse", "HEAD") != revision:
        raise ValueError("Checkout does not match the explicitly selected revision")
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Workflow source has uncommitted changes")
    subprocess.run([sys.executable, "-X", "utf8", str(repo / "workflow-schema/validate-workflows.py")], check=True)
    workflows = json.loads((ROOT / "scripts/workflow-catalog-layout.json").read_text(encoding="utf-8"))
    source = {}
    for collection in ("assistant-workflows", "tabular-review-workflows"):
        for skill in sorted((repo / collection).rglob("SKILL.md")):
            _, header, body = skill.read_text(encoding="utf-8").split("---", 2)
            data = yaml.safe_load(header)
            if data["metadata"]["mike-availability"] != "system":
                continue
            if data["name"] in source:
                raise ValueError(f"Duplicate source workflow: {data['name']}")
            source[data["name"]] = (skill, data, body.strip())
    assets, payloads, consumed = [], {}, set()
    for workflow in workflows:
        for variant in workflow["launcher"].get("variants", []):
            name = variant.pop("source", None)
            if name is None:
                continue  # Beaver-owned native launcher instructions.
            skill, data, body = source[name]
            consumed.add(name)
            meta = data["metadata"]
            variant.setdefault("label", meta["mike-display-name"])
            variant.setdefault("result", "Word draft" if name.endswith("-draft") else "Review")
            variant["description"] = data["description"]
            variant["execution"] = meta["mike-type"]
            variant["columns_config"] = None
            if variant["execution"] == "tabular":
                variant["columns_config"] = yaml.safe_load(
                    (skill.parent / "table-columns.yaml").read_text(encoding="utf-8"))["columns"]
            for folder in ("assets", "references"):
                for file in sorted((skill.parent / folder).rglob("*")):
                    if not file.is_file():
                        continue
                    if file.is_symlink() or not file.resolve().is_relative_to(repo):
                        raise ValueError("Workflow assets must stay inside the source checkout")
                    relative = file.relative_to(skill.parent).as_posix()
                    filename = f"{name}-{file.relative_to(skill.parent / folder).as_posix().replace('/', '-')}"
                    body = body.replace(relative, f"references/{filename}")
                    content = file.read_bytes()
                    digest = hashlib.sha256(content).hexdigest()
                    payloads[digest] = content
                    assets.append({"workflowId": workflow["id"], "variantId": variant["id"], "filename": filename,
                                   "sha256": digest, "sizeBytes": len(content),
                                   "contentType": CONTENT_TYPES.get(file.suffix.lower(), "application/octet-stream")})
            variant["skill_md"] = body
    if source.keys() - consumed:
        raise ValueError(f"Place new system recipes in workflow-catalog-layout.json: {sorted(source.keys() - consumed)}")
    snapshot = {"schemaVersion": 1, "sourceCommit": revision, "workflows": workflows, "assets": assets}
    output.mkdir(parents=True, exist_ok=True)
    (output / "assets").mkdir(exist_ok=True)
    (output / "catalogue.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    for digest, content in payloads.items():
        (output / "assets" / digest).write_bytes(content)
    if bundle:
        (ROOT / "backend/src/lib/systemWorkflows.json").write_text(
            json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
        (ROOT / "backend/src/lib/systemWorkflowAssets.json").write_text(
            json.dumps({digest: base64.b64encode(content).decode("ascii") for digest, content in payloads.items()},
                       separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"Built {len(workflows)} workflows and {len(assets)} references from {revision}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    parser.add_argument("revision")
    parser.add_argument("output", type=Path)
    parser.add_argument("--bundle", action="store_true", help="Also regenerate Beaver's bundled distribution")
    args = parser.parse_args()
    build(args.repository, args.revision, args.output, args.bundle)
