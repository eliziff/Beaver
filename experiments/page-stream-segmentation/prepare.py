"""Prepare original-page training labels and a review queue, without model calls."""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
import json
import os
import re
import sys

from boundary_data import (ROOT, DEFAULT_OUT, annotation_labels, atomic_json, check_partitions,
                           combine_labels, corpus_home, digest, fingerprint, read_catalogue, read_json,
                           structure_labels, validate_pages, validate_sha)
from codex_runner.artifacts import atomic_write
import gold_store


class Families:
    def __init__(self):
        self.parent = {}

    def find(self, key):
        self.parent.setdefault(key, key)
        root = key
        while root != self.parent[root]:
            root = self.parent[root]
        while key != root:
            next_key = self.parent[key]
            self.parent[key] = root
            key = next_key
        return root

    def connect(self, members):
        roots = sorted({self.find(m) for m in members if m})
        for root in roots[1:]:
            self.parent[root] = roots[0]


def association_family(gold):
    family = gold.get("family")
    if isinstance(family, dict):
        family = family["identity"]
    return ["association-family:" + family.casefold()] if family else []


def prepare(args):
    home = args.home.resolve()
    with closing(read_catalogue(home)) as db:
        files = {r["sha256"]: dict(r) for r in db.execute("select sha256,path,pages from files")}
        memberships = defaultdict(set)
        for row in db.execute("select dataset,record_id,sha256,owner_sha256 from gold_memberships"):
            memberships[row["dataset"], row["record_id"]].update((row["sha256"], row["owner_sha256"]))
        medical = {r[0] for r in db.execute("select sha256 from documents where collection in (?,?)",
                    ("public-medical-legal-sources", "public-redacted-medical-samples"))}
    families, sources, inputs = Families(), {}, {}
    receipt_differences, unresolved_paths, recovered_page_counts = [], {}, {}
    for members in memberships.values():
        families.connect(members)

    def location(path):
        path = Path(os.path.abspath(path))
        for name, root in (("repository", ROOT), ("openlegaldata", home)):
            if path.is_relative_to(root):
                return {"storage": name, "path": path.relative_to(root).as_posix()}
        raise ValueError("Input must live in the repository or OpenLegalData store: " + str(path))

    def evidence(path):
        if path not in inputs:
            inputs[path] = {**location(path), "sha256": digest(path)}
        return inputs[path]

    def source(sha, kind, path, page_count=None):
        validate_sha(sha)
        row = files.get(sha)
        if row is None:
            unresolved_paths[sha] = "No catalogue lookup entry"
            return None
        pdf = Path(os.path.abspath(home / row["path"]))
        owner = location(pdf)
        count = row["pages"]
        if type(count) is not int or count < 1:
            if pdf.is_file():
                import fitz
                with fitz.open(pdf) as document:
                    count = len(document)
                recovered_page_counts[sha] = {"catalogue_pages": row["pages"], "pdf_pages": count}
                row["pages"] = count
            else:
                count = page_count
        if type(count) is not int or count < 1:
            unresolved_paths[sha] = "Source page count needs resolution"
            return None
        if not pdf.is_file():
            unresolved_paths[sha] = {**owner, "reason": "Not found at the recorded local path; labels remain usable"}
        if sha not in sources:
            families.find(sha)
            sources[sha] = {"sha256": sha, **owner, "page_count": count, "local_pdf": pdf.is_file(),
                            "kinds": set(), "evidence": [], "votes": [], "review_gaps": set(), "within_page": set()}
        result = sources[sha]
        result["kinds"].add(kind)
        if path and evidence(path) not in result["evidence"]:
            result["evidence"].append(evidence(path))
        return result

    def part(item, kind, path, include_edges=False):
        sha = item.get("sha256") or item.get("source_sha256")
        row = source(sha, kind, path)
        if row is None:
            return sha
        # Existing source maps sometimes list certificate pages separately.
        pages = sorted(set(item.get("pages") or []) | set(item.get("cover_pages") or []))
        validate_pages(pages, row["page_count"])
        # A separately mapped cover can supply context, not an unreviewed negative.
        row["votes"].append(annotation_labels(item, row["page_count"]) if "document_starts" in item else {})
        row["within_page"].update(start["page"] for start in item.get("document_starts", []) if isinstance(start, dict))
        row["review_gaps"].update(p for p in pages if p - 1 in pages)
        if include_edges:
            row["review_gaps"].update(p for p in pages if p > 1)
            row["review_gaps"].update(p + 1 for p in pages if p < row["page_count"])
        return sha

    for _, gold_path in gold_store.sources(gold_store.STRUCTURE):
        receipt_path = gold_path.with_name("receipt.json")
        receipt = read_json(receipt_path)
        if receipt.get("status") != "complete":
            continue
        gold = read_json(gold_path)
        if gold["source_sha256"] != receipt["source_sha256"]:
            raise ValueError("Structure gold source differs from its receipt")
        row = source(gold["source_sha256"], "structure", gold_path, gold["page_count"])
        if row is None:
            continue
        if row["page_count"] != gold["page_count"]:
            raise ValueError("Structure gold does not cover the original PDF")
        row["evidence"].append(evidence(receipt_path))
        actual_sha = evidence(gold_path)["sha256"]
        if actual_sha != receipt.get("gold_sha256"):
            receipt_differences.append({"sha256": row["sha256"], "current_gold_sha256": actual_sha,
                                       "authoring_gold_sha256": receipt.get("gold_sha256"),
                                       "recorded_postcorrections": len(gold.get("postcorrections", []))})
        labels, within = structure_labels(gold, receipt.get("pages_without_text", []))
        row["votes"].append(labels)
        row["within_page"].update(within)
        row["review_gaps"].update(range(2, row["page_count"] + 1))

    # Reuse accepted-inventory and original-page adapters; stripped model views
    # are never read. Their absence of an internal-start annotation is unknown.
    sys.path.insert(0, str(ROOT / "experiments/affidavit-association"))
    from data import accepted_gold, source_mapping
    from audit_expansion import referring_parts, source_parts
    for expansion in args.association:
        for path in accepted_gold(expansion, artifact="source-gold.json").values():
            gold = read_json(path)
            parts = referring_parts(gold) + [p for e in gold["exhibits"] for p in source_parts(e)]
            members = [part(p, "affidavit", path, True) for p in parts if p.get("pages")]
            families.connect(members + association_family(gold))
    for path in sorted(args.legacy.glob("*/gold.json")):
        metadata, split = path.with_name("source.json"), path.with_name("split.json")
        if not metadata.is_file() or not split.is_file():
            continue
        original, mapping = read_json(metadata), read_json(split)
        pieces = [{"pages": mapping.get("affidavit_pages", [])}]
        pieces += [p for e in mapping["exhibits"] for p in (e.get("source_files") or [e])]
        mapped = [source_mapping(original, p) for p in pieces]
        members = [part(p, "affidavit", split, True) for p in mapped if p.get("sha256") and p.get("pages")]
        gold = read_json(path)
        families.connect(members + association_family(gold))
        for sha in members:
            if sha in sources:
                sources[sha]["evidence"].append(evidence(metadata))

    if args.medical and args.medical.is_file():
        manifest = read_json(args.medical)
        for item in manifest["documents"]:
            first, last = item["source_pages"]  # This manifest stores an inclusive range.
            part({"sha256": item["parent_sha256"], "pages": list(range(first, last + 1))}, "medical", args.medical, True)
            families.connect((item["sha256"], item["parent_sha256"]))
    for sha in sorted(medical):
        row = source(sha, "medical-unreviewed", None)
        if row is not None:
            row["review_gaps"].update(range(2, row["page_count"] + 1))

    generated = sorted((args.out / "annotations").glob("*/gold.json"))
    for path in [*generated, *args.annotations]:
        receipt_path = path.with_name("receipt.json")
        if path in generated and receipt_path.is_file():
            evidence(receipt_path)
        for item in read_json(path)["sources"]:
            part(item, "page-boundary-annotation", path)

    groups, inherited = defaultdict(set), defaultdict(set)
    for key in families.parent:
        if re.fullmatch(r"[0-9a-f]{64}", key):
            groups[families.find(key)].add(key)
    # A family takes the gold store's partition (source.json) of its sources there.
    for key in families.parent:
        partition = gold_store.source(key).get("partition") if re.fullmatch(r"[0-9a-f]{64}", key) else None
        if partition:
            inherited[families.find(key)].add(partition)
    conflicts = []
    for row in sources.values():
        root = families.find(row["sha256"])
        splits = inherited[root]
        row["family_id"] = fingerprint(sorted(groups[root]))
        row["split"] = next(iter(splits)) if len(splits) == 1 else "unassigned"
        if len(splits) > 1:
            conflicts.append(row["family_id"])
        row["labels"], row["conflicting_gaps"] = combine_labels(row.pop("votes"))
        for field in ("kinds", "review_gaps", "within_page"):
            row[field] = sorted(row[field])
        row["review_gaps"] = sorted(set(row["review_gaps"]) - row["labels"].keys())
        row["evidence"] = sorted({fingerprint(v): v for v in row["evidence"]}.values(), key=lambda v: (v["storage"], v["path"]))
    ordered = sorted(sources.values(), key=lambda row: row["sha256"])
    check_partitions(ordered)
    report = {"sources": len(ordered), "pages": sum(r["page_count"] for r in ordered),
              "by_split": dict(Counter(r["split"] for r in ordered)),
              "known_gaps": sum(len(r["labels"]) for r in ordered),
              "positive_gaps": sum(sum(r["labels"].values()) for r in ordered),
              "review_gaps": sum(len(r["review_gaps"]) for r in ordered),
              "conflicting_gaps": sum(len(r["conflicting_gaps"]) for r in ordered),
              "within_page_sources": sum(bool(r["within_page"]) for r in ordered),
              "authoring_receipt_differences": receipt_differences,
              "unresolved_local_paths": unresolved_paths,
              "recovered_page_counts": recovered_page_counts,
              "partition_conflicts": sorted(set(conflicts)),
              "partition_status": "the gold store's partition (source.json) of each family's sources; a family without one is unassigned"}
    result = {"schema_version": "page-stream-dataset.v1", "sources": ordered, "report": report,
              "inputs": sorted(inputs.values(), key=lambda v: (v["storage"], v["path"]))}
    atomic_json(args.out / "dataset.json", result)
    atomic_json(args.out / "preparation.json", report)
    for split in ("train", "development", "test", "unassigned"):
        rows = ({"sha256": source["sha256"], "right_page": page, "label": label,
                 "family_id": source["family_id"], "split": split}
                for source in ordered if source["split"] == split for page, label in sorted(source["labels"].items()))
        atomic_write(args.out / f"gaps-{split}.jsonl", "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows).encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=corpus_home())
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--association", type=Path, nargs="*", default=[ROOT / ("benchmarks/local-data/affidavit-association/" + n)
                         for n in ("expansion", "expansion-2", "expansion-3")])
    parser.add_argument("--legacy", type=Path)
    parser.add_argument("--medical", type=Path)
    parser.add_argument("--annotations", type=Path, nargs="*", default=[])
    args = parser.parse_args()
    args.legacy = args.legacy or args.home / "benchmarks/court-record-exhibits/records"
    report = prepare(args)
    summary = {k: v for k, v in report.items() if k not in {
        "authoring_receipt_differences", "unresolved_local_paths", "recovered_page_counts", "partition_conflicts"}}
    summary.update(authoring_receipt_differences=len(report["authoring_receipt_differences"]),
                   unresolved_local_paths=len(report["unresolved_local_paths"]), recovered_page_counts=len(report["recovered_page_counts"]),
                   partition_conflict_families=len(report["partition_conflicts"]))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
