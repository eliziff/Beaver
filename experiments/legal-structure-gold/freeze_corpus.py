#!/usr/bin/env python3
"""Prepare private, deterministic source-family membership; never parse or score PDFs.

Reads the canonical catalogue without mutation. Selection is not gold authoring:
missing layout/family review remains explicit and prevents an evaluation freeze.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import gzip
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit, urlunsplit
from partitions import validate_partitions

GROUPS = ("judgments", "legislation", "compound", "bilingual_or_multicolumn")
KINDS = {
    "judgments": {"judgment", "ruling"},
    "legislation": {"legislation", "statute", "statute_compilation", "rules_or_regulations", "municipal_bylaw", "zoning_bylaw"},
    "compound": {"book-of-authorities", "affidavit-bundle", "hearing_bundle"},
}
DATASET = "legal-gold-package.v2"
SALT = "pdf-structure-gold-family-v1"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def read_catalogue(home):
    path = home / "corpus" / "corpus.sqlite"
    # Immutable avoids SQLite shared-memory writes; refuse an uncheckpointed WAL.
    wal = path.with_name(path.name + "-wal")
    if wal.exists() and wal.stat().st_size:
        raise ValueError("Catalogue has an active WAL; use a checkpointed read-only snapshot")
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    return db


def load_review(path, known):
    review = json.loads(path.read_text(encoding="utf-8")) if path else {}
    if set(review) - {"documents", "families", "exposed_sources", "exposure_review", "exposure_audit"}:
        raise ValueError("Unknown review fields")
    confirmed = set()
    audit = review.get("exposure_audit")
    if audit is not None:
        if (not isinstance(audit, dict)
                or set(audit) != {"path", "sha256", "status", "confirmed_sources", "evidence"}
                or not isinstance(audit["path"], str) or not audit["path"]
                or not isinstance(audit["sha256"], str)
                or audit["status"] != "partial_historical_audit_not_final_review"
                or type(audit["confirmed_sources"]) is not int or audit["confirmed_sources"] < 0
                or not isinstance(audit["evidence"], str) or not audit["evidence"]):
            raise ValueError("Exposure audit requires a bound partial-audit receipt")
        relative = Path(audit["path"])
        owner = path.resolve().parent
        receipt_path = (owner / relative).resolve()
        if relative.is_absolute() or not receipt_path.is_relative_to(owner):
            raise ValueError("Exposure audit path must remain relative to the review owner")
        receipt_bytes = receipt_path.read_bytes()
        if hashlib.sha256(receipt_bytes).hexdigest() != audit["sha256"]:
            raise ValueError("Exposure audit hash mismatch")
        receipt = json.loads(receipt_bytes)
        if (not isinstance(receipt, dict)
                or receipt.get("status") != audit["status"]
                or receipt.get("schema_version") != "legal-structure-gold.exposure-audit.v1"):
            raise ValueError("Exposure audit must identify a partial historical audit")
        confirmed = {row["sha256"] for row in receipt["confirmed_exposures"]}
        if len(confirmed) != audit["confirmed_sources"] or not confirmed <= set(review.get("exposed_sources", [])):
            raise ValueError("Reviewed exposure omits confirmed audit identities")
        # This receipt establishes known exposure only; it never supplies the
        # independently required complete exposure_review coverage assertion.
    for sha, row in review.get("documents", {}).items():
        if sha not in known or set(row) - {"groups", "evidence", "family_reviewed", "duplicate_pages_reviewed"}:
            raise ValueError("Unknown reviewed source or field")
        if set(row.get("groups", [])) - set(GROUPS) or not row.get("evidence"):
            raise ValueError("Reviewed source requires supported groups and evidence")
        if any(type(row[field]) is not bool for field in ("family_reviewed", "duplicate_pages_reviewed") if field in row):
            raise ValueError("Source review flags must be Booleans")
    for family in review.get("families", []):
        if set(family) != {"kind", "members", "evidence"} or not family["evidence"]:
            raise ValueError("Reviewed family requires kind, members and evidence")
        if family["kind"] not in {"source_version", "template", "proceeding", "duplicate_page"}:
            raise ValueError("Unknown family kind")
        if len(set(family["members"])) < 2 or not set(family["members"]) <= known:
            raise ValueError("Family references unknown or insufficient sources")
    if not set(review.get("exposed_sources", [])) <= known | confirmed:
        raise ValueError("Exposure references an unknown source without confirmed audit evidence")
    exposure = review.get("exposure_review")
    if exposure is not None:
        if (set(exposure) != {"sources", "evidence"} or not exposure["evidence"]
                or not isinstance(exposure["sources"], list) or not set(exposure["sources"]) <= known):
            raise ValueError("Exposure review requires known sources and evidence")
    return review


def prepare(db, home, review_path=None, selection=None):
    files = {r["sha256"]: dict(r) for r in db.execute("select sha256,path,pages,text_sha256 from files order by sha256")}
    review = load_review(review_path, set(files))
    sources = defaultdict(list)
    for row in db.execute("select sha256,kind,jurisdiction,url,final_url,provenance from documents order by sha256,url,collection"):
        if row["sha256"] in files:
            sources[row["sha256"]].append(dict(row))
    selected_gold = {}
    for row in db.execute("select r.sha256,r.mode,r.status,r.run_id,a.path,a.sha256 artifact_sha256 from gold_records r left join gold_artifacts a on a.run_id=r.run_id and a.role='gold' where r.dataset=? and r.status='complete' and r.mode in ('digitalborn','ocr') order by r.sha256", (DATASET,)):
        selected_gold[row["sha256"]] = dict(row)

    parent = {sha: sha for sha in files}
    evidence = []

    def find(sha):
        while parent[sha] != sha:
            parent[sha] = parent[parent[sha]]
            sha = parent[sha]
        return sha

    def connect(kind, key, members, detail=None):
        members = sorted(set(members) & files.keys())
        if len(members) < 2:
            return
        roots = sorted({find(sha) for sha in members})
        for other in roots[1:]:
            parent[other] = roots[0]
        evidence.append({"kind": kind, "key": key, "members": members, **({"detail": detail} if detail else {})})

    urls, texts = defaultdict(set), defaultdict(set)
    for sha, rows in sources.items():
        for row in rows:
            for field in ("url", "final_url"):
                url = row[field]
                if url:
                    parts = urlsplit(url)
                    urls[urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, parts.query, ""))].add(sha)
    for sha, row in files.items():
        if row["text_sha256"]:
            texts[row["text_sha256"]].add(sha)
    for key, members in sorted(urls.items()):
        connect("source_url", digest(key), members)
    forms = defaultdict(set)
    for row in db.execute("select f.jurisdiction,f.court,f.family,f.form_id,o.sha256 from legal_forms f join legal_form_observations o using(form_id) order by f.form_id,o.sha256"):
        forms[(row["jurisdiction"], row["court"], row["family"] or row["form_id"])].add(row["sha256"])
    for key, members in sorted(forms.items(), key=lambda item: str(item[0])):
        connect("form_template", digest(key), members)
    records = defaultdict(set)
    for row in db.execute("select dataset,record_id,sha256,owner_sha256 from gold_memberships order by dataset,record_id,sha256"):
        records[(row["dataset"], row["record_id"])].update((row["sha256"], row["owner_sha256"]))
    for key, members in sorted(records.items()):
        connect("record_source_membership", digest(key), members)

    # Text equality is a conservative leakage witness, not proof of visual equality.
    page_groups = defaultdict(list)
    page_counts = Counter()
    layout_candidates = defaultdict(list)
    english = {"the", "and", "of", "shall", "court", "section", "this", "that"}
    french = {"le", "la", "les", "des", "du", "une", "dans", "pour", "est", "qui", "que"}
    for row in db.execute("select sha256,page,text from pages order by sha256,page"):
        sha = row["sha256"]
        if sha not in files:
            continue
        text = " ".join((row["text"] or "").split())
        if len(text) >= 200:
            page_counts[sha] += 1
            key = hashlib.sha256(text.encode()).hexdigest()
            page_groups[key].append([sha, row["page"]])
        if (files[sha]["pages"] or 0) > 30:
            words = Counter(text.lower().split())
            en = sum(words[w] for w in english)
            fr = sum(words[w] for w in french)
            if en >= 30 and fr >= 30 and len(set(words) & english) >= 5 and len(set(words) & french) >= 5:
                layout_candidates[sha].append(row["page"])
    for key, members in sorted(texts.items()):
        connect("document_text", key, (sha for sha in members if page_counts[sha]))
    duplicates = []
    for key, pages in sorted(page_groups.items()):
        if len({sha for sha, _ in pages}) > 1:
            connect("normalized_page_text", key, (sha for sha, _ in pages))
            duplicates.append({"text_sha256": key, "pages": pages})
    for family in review.get("families", []):
        connect(family["kind"], digest(family), family["members"], family["evidence"])

    families = defaultdict(list)
    for sha in sorted(files):
        families[find(sha)].append(sha)
    family_ids = {sha: digest(members) for members in families.values() for sha in members}
    exposed = set(review.get("exposed_sources", []))
    # Historical annotation is not proof that a source was kept untouched.
    # Historical receipts may identify sources absent from this catalogue.
    # Preserve their exposure without inventing a current family connection.
    exposed_families = {family_ids[sha] for sha in exposed if sha in family_ids}
    splits = {}
    for members in families.values():
        ident = family_ids[members[0]]
        bucket = int(digest([SALT, ident])[:8], 16) % 10
        split = "development" if ident in exposed_families else "train" if bucket < 8 else "development" if bucket == 8 else "test"
        for sha in members:
            splits[sha] = split

    eligible = defaultdict(list)
    for sha, row in files.items():
        if not row["pages"] or row["pages"] <= 30 or not (home / row["path"]).is_file():
            continue
        kinds = {r["kind"] for r in sources[sha]}
        groups = {group for group, accepted in KINDS.items() if kinds & accepted}
        reviewed = review.get("documents", {}).get(sha, {})
        groups.update(reviewed.get("groups", []))
        mode = selected_gold.get(sha, {}).get("mode")
        if not mode:
            mode = "ocr" if "/non_digital/" in row["path"] else "digitalborn" if "/digitalborn/" in row["path"] else "unknown"
        for group in groups:
            eligible[group].append({"sha256": sha, "pages": row["pages"], "path": row["path"], "mode": mode,
                "family_id": family_ids[sha], "split": splits[sha],
                "evidence": reviewed.get("evidence") if group in reviewed.get("groups", []) else {"catalogue_kinds": sorted(kinds & KINDS[group])}})
    chosen, used = {}, set()
    # Scarce layout-reviewed sources are reserved first; every PDF counts once.
    for group in sorted(GROUPS, key=lambda group: (len(eligible[group]), group)):
        candidates = sorted(eligible[group], key=lambda row: (row["mode"] != "ocr", digest([SALT, group, row["sha256"]])))
        picked = []
        seen_families = set()
        for distinct in (True, False):
            for row in candidates:
                if len(picked) == 12:
                    break
                if row["sha256"] in used or distinct and row["family_id"] in seen_families:
                    continue
                picked.append(row)
                used.add(row["sha256"])
                seen_families.add(row["family_id"])
        chosen[group] = picked
    if selection is not None:
        if selection.get("schema_version") != "pdf-structure-gold-membership.v1" or selection.get("dataset") != DATASET:
            raise ValueError("Selection must name the canonical structural package cohort")
        members = [member["sha256"] for member in selection["members"]]
        if len(members) != len(set(members)) or not set(members) <= files.keys():
            raise ValueError("Selection has duplicate or unknown source identities")
        used = set()
        chosen = {}
        for group in GROUPS:
            current = {row["sha256"]: row for row in eligible[group]}
            chosen[group] = []
            for prior in selection["long_documents"][group]:
                sha = prior["sha256"]
                if sha not in current or sha not in members or sha in used:
                    raise ValueError("Selected long source is missing, no longer eligible, or repeated")
                used.add(sha)
                chosen[group].append(current[sha])
        members.sort()
    else:
        members = sorted(set(selected_gold) | used)
    missing_family_review = [sha for sha in members if not review.get("documents", {}).get(sha, {}).get("family_reviewed")]
    missing_page_review = [sha for sha in members if not review.get("documents", {}).get(sha, {}).get("duplicate_pages_reviewed")]
    membership = []
    for sha in members:
        gold = selected_gold.get(sha)
        membership.append({"sha256": sha, "family_id": family_ids[sha], "split": splits[sha],
            "pages": files[sha]["pages"], "indexed_substantive_pages": page_counts[sha],
            "selected_gold": gold if gold and gold["status"] == "complete" else None})
    blockers = []
    shortages = {group: 12-len(chosen[group]) for group in GROUPS if len(chosen[group]) < 12}
    if shortages:
        blockers.append("Long-document selection has group shortages")
    if any(not any(row["mode"] == "ocr" for row in chosen[group]) for group in GROUPS):
        blockers.append("Scan coverage is not established in every primary selection group")
    if missing_family_review:
        blockers.append("Source-version/template family coverage is not fully established")
    if missing_page_review:
        blockers.append("Visual duplicate-page coverage is not fully established, including scans")
    blockers.append("Revised structural gold and source-exposure audit are not frozen by manifest preparation")
    member_set = set(members)
    manifest = {
        "schema_version": "pdf-structure-gold-membership.v1", "status": "prepared_not_evaluation_frozen",
        "dataset": DATASET, "scope": "selected_complete_structure_packages_and_long_sources", "salt": SALT, "split_policy": {"train": 0.8, "development": 0.1, "test": 0.1, "unit": "connected_source_family"},
        "input_identity": digest({"files": list(files.values()), "sources": dict(sources), "selected_gold": selected_gold, "evidence": evidence, "review": review}),
        "members": membership, "families": [{"id": family_ids[v[0]], "members": v} for v in sorted(families.values()) if member_set.intersection(v)],
        "family_evidence": evidence, "exposed_sources": sorted(exposed), "duplicate_page_text_groups": duplicates,
        "long_documents": {group: chosen[group] for group in GROUPS},
        "layout_candidates_requiring_review": [{"sha256": sha, "pages": files[sha]["pages"], "mixed_language_pages": pages,
            "basis": "English/French lexical co-occurrence; not an established bilingual or multicolumn label"}
            for sha, pages in sorted(layout_candidates.items()) if len(pages) >= 3 and sha not in used],
        "shortages": shortages,
        "scans_by_group": {group: sum(r["mode"] == "ocr" for r in chosen[group]) for group in GROUPS},
        "family_review_missing": missing_family_review, "visual_duplicate_review_missing": missing_page_review,
        "blockers": blockers,
    }
    validate_partitions(manifest)
    return manifest


def freeze(manifest, home, review_path, selection_path):
    """Bind reviewed membership to current, fully re-authored canonical answers.

    This publishes input identities only. It does not train, score, invoke an
    author, mutate gold, or repair interrupted publications.
    """
    validate_partitions(manifest)
    import package
    from worker import current_structure_authoring

    if manifest["shortages"] or manifest["family_review_missing"] or manifest["visual_duplicate_review_missing"]:
        raise ValueError("Long-source selection and source-family/page reviews must be complete before freezing")
    if any(count == 0 for count in manifest["scans_by_group"].values()):
        raise ValueError("Every long-source group requires scan coverage")
    review = json.loads(review_path.read_text(encoding="utf-8"))
    if set(review.get("exposed_sources", [])) != set(manifest["exposed_sources"]):
        raise ValueError("Reviewed exposure identities changed after membership preparation")
    members = {member["sha256"] for member in manifest["members"]}
    exposure = review.get("exposure_review", {})
    if not exposure.get("evidence") or not members <= set(exposure.get("sources", [])):
        raise ValueError("Historical exposure review must explicitly cover every selected source")
    def file_hash(path):
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    with read_catalogue(home) as db:
        source_files = {row["sha256"]: row["path"] for row in db.execute("select sha256,path from files")}
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    prior_splits = {member["sha256"]: member["split"] for member in selection["members"]}
    if any(prior_splits[member["sha256"]] != member["split"] for member in manifest["members"]):
        raise ValueError("Family or exposure evidence changes a partition; explicitly revise the prepared selection before freezing")
    identities = []
    for member in manifest["members"]:
        selected = member["selected_gold"]
        if not selected or selected["status"] != "complete" or selected["sha256"] != member["sha256"]:
            raise ValueError("Every selected source requires complete canonical structural gold")
        path = Path(selected["path"])
        if not path.is_absolute():
            path = home / path
        selected["path"] = str(path.resolve())
        if file_hash(path) != selected["artifact_sha256"]:
            raise ValueError("Selected gold artifact changed before freezing")
        gold = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes())
        package.validate(gold)
        if gold["source_sha256"] != member["sha256"] or "legal_structure" not in gold["layers"]:
            raise ValueError("Frozen gold requires the selected source's structural layer")
        expected_pages = list(range(1, member["pages"] + 1))
        if sorted(page["page"] for page in gold["pages"]) != expected_pages:
            raise ValueError("Frozen structural gold must cover the complete source")
        job = path.parent
        if (job / "publication.json").exists():
            raise ValueError("Finish the selected gold publication before freezing")
        source = home / source_files[member["sha256"]]
        if file_hash(source) != member["sha256"]:
            raise ValueError("Canonical PDF differs from its source identity")
        proof = current_structure_authoring(job, gold, pdf=source)
        identities.append({"sha256": member["sha256"], "artifact_sha256": selected["artifact_sha256"],
            "structure_authoring_sha256": digest(proof),
            "text_identity": package.text_identity(gold)})
    frozen = {**manifest, "status": "evaluation_frozen", "blockers": [],
        "freeze": {"review_sha256": file_hash(review_path), "selection_sha256": file_hash(selection_path), "gold": identities,
                   "policy_sha256": file_hash(Path(__file__).resolve().parents[2] / "docs/roadmap/pdf-structure-gold.md")}}
    frozen["freeze"]["identity"] = digest(frozen)
    return frozen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("OPEN_LEGAL_DATA_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "OpenLegalData"))
    parser.add_argument("--review", type=Path, help="Private source-family and selection evidence JSON")
    parser.add_argument("--selection", type=Path, help="Retain the prepared source cohort and long-source group assignments while refreshing evidence")
    parser.add_argument("--freeze", action="store_true", help="Freeze reviewed membership and current revised structural gold; never train or score")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.freeze and (args.review is None or args.selection is None):
        parser.error("--freeze requires --selection and --review with complete family/page/exposure evidence")
    if args.output is None:
        args.output = Path(__file__).resolve().parents[2] / "benchmarks/local-data/legal-structure-gold" / ("family-frozen.json" if args.freeze else "family-selection.json")
    selection = json.loads(args.selection.read_text(encoding="utf-8")) if args.selection else None
    with read_catalogue(args.home.resolve()) as db:
        manifest = prepare(db, args.home.resolve(), args.review, selection)
    if args.freeze:
        manifest = freeze(manifest, args.home.resolve(), args.review, args.selection)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".part")
    try:
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.output)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({"status": manifest["status"], "members": len(manifest["members"]),
        "long_documents": {k: len(v) for k,v in manifest["long_documents"].items()},
        "scans_by_group": manifest["scans_by_group"], "shortages": manifest["shortages"],
        "layout_candidates": len(manifest["layout_candidates_requiring_review"]), "blockers": manifest["blockers"]}))


if __name__ == "__main__":
    main()
