"""Independent invented PDF/label fixtures; no genuine source text or case facts."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from boundary_data import (ROOT, annotation_labels, atomic_json, check_partitions, compact_scopes,
                           digest, fingerprint, measure, read_json, structure_labels)
from annotate import consensus, run, validate_response, windows
from prepare import gold_store, prepare
from score import decisions


def pdf(home, title="River basin observations", pages=4):
    import fitz
    home.mkdir(parents=True, exist_ok=True)
    path = home / "invented.pdf"
    with fitz.open() as document:
        for i in range(pages):
            page = document.new_page(width=280, height=360)
            page.insert_text((30, 50), f"{title}: observation sheet {i + 1}")
        document.save(path)
    sha = digest(path)
    final = home / f"{sha}.pdf"
    path.rename(final)
    return sha, final


def source(sha, count=4, labels=None, split="train"):
    return {"sha256": sha, "storage": "openlegaldata", "path": f"{sha}.pdf", "page_count": count, "family_id": fingerprint([sha]),
            "split": split, "labels": labels or {}, "kinds": ["medical"], "review_gaps": list(range(2, count + 1))}


def gold(sha, pages=(1, 2, 3, 4), starts=(3,)):
    return {"schema_version": "legal-structure-gold.v4", "source_sha256": sha, "page_count": max(pages),
            "typed": [{"page": page, "region": "text", "spans": [{"line_id": f"l{i}", "start": 0, "end": 3}]}
                      for i, page in enumerate(pages)],
            "units": [{"lines": [i], "starts_document": page in starts, "ends_document": False} for i, page in enumerate(pages)]}


class LabelTests(unittest.TestCase):
    def test_single_arm_comparison_reports_no_self_agreement(self):
        from pair_probe import summarize
        spec = {"arms": {"reviewer": ["test-model", "low"]}, "protocol": "invented",
                "cases": [{"case_id": "invented", "right_page": 2, "expected": 1,
                           "family_id": "invented-family", "cohort": "existing_gold"}]}
        results = [{"arm": "reviewer", "case_id": "invented", "status": "complete", "labels": {"2": 1}}]
        report = summarize(spec, results)
        self.assertEqual(set(report["arms"]), {"reviewer"})
        self.assertEqual(report["arms"]["reviewer"]["correct"], 1)
        self.assertEqual(report["paired"]["existing_gold"], {})

    def test_unknown_empty_and_sparse_annotations(self):
        self.assertEqual(annotation_labels({"pages": [3, 4, 7, 8]}, 8), {})
        self.assertEqual(annotation_labels({"pages": [3, 4, 7, 8], "document_starts": []}, 8), {4: 0, 8: 0})
        self.assertEqual(annotation_labels({"pages": [3, 4, 7, 8], "document_starts": [8]}, 8), {4: 0, 8: 1})
        for starts in ([3], [7], [False], [8, 4]):
            with self.assertRaises(ValueError):
                annotation_labels({"pages": [3, 4, 7, 8], "document_starts": starts}, 8)

    def test_structure_never_rounds_within_page_or_unread_text(self):
        value = gold("a" * 64, pages=(1, 2, 2, 3, 4), starts=(4,))
        value["units"][2]["starts_document"] = True
        labels, within = structure_labels(value)
        self.assertEqual(labels, {4: 1})
        self.assertEqual(within, [2])
        self.assertEqual(structure_labels(value, [4])[0], {})
        ordinary = gold("a" * 64, starts=())
        ordinary["units"][1]["ends_document"] = True
        self.assertNotIn(3, structure_labels(ordinary)[0])
        ordinary["units"][2]["starts_document"] = True
        self.assertEqual(structure_labels(ordinary)[0][3], 1)

    def test_blind_disagreement_stays_unknown_in_compact_gold(self):
        first = validate_response({"document_starts": [3, 5], "uncertain": []}, [2, 3, 4, 5])
        second = validate_response({"document_starts": [3, 4, 5], "uncertain": []}, [2, 3, 4, 5])
        agreed = consensus(first, second)
        scopes = compact_scopes("a" * 64, agreed)
        rebuilt = {p: v for scope in scopes for p, v in annotation_labels(scope, 5).items()}
        self.assertEqual(rebuilt, {2: 0, 3: 1, 5: 1})
        self.assertEqual(scopes[1]["pages"], [4, 5])
        self.assertEqual(windows([2, 3, 7], 8), [([2, 3], [1, 2, 3, 4]), ([7], [5, 6, 7, 8])])

    def test_exact_packet_requires_all_gold_and_predictions(self):
        full = source("a" * 64, labels={"2": 0, "3": 1, "4": 0})
        partial = source("b" * 64, labels={"3": 1})
        result = measure([full, partial], {full["sha256"]: {2: 0, 3: 1}, partial["sha256"]: {3: 1}})
        self.assertEqual(result["coverage"], 3 / 4)
        self.assertEqual(result["exact_packet_rate"], 0)
        self.assertEqual(result["counts"]["complete_gold_packets"], 1)
        result = measure([full], {full["sha256"]: {2: 1, 3: 0, 4: 0}})
        self.assertEqual(result["counts"]["false_splits"], 1)
        self.assertEqual(result["counts"]["missed_splits"], 1)
        self.assertEqual(result["document_f1_on_fully_predicted_packets"], 0)
        full["within_page"] = [2]
        result = measure([full], {full["sha256"]: {2: 0, 3: 1, 4: 0}})
        self.assertIsNone(result["exact_packet_rate"])
        self.assertEqual(result["counts"]["incomplete_gold_packets"], 1)
        self.assertEqual(decisions([{"sha256": "a", "probabilities": {"2": 0.1, "3": 0.5, "4": 0.9}}], 0.2, 0.8), {"a": {2: 0, 4: 1}})

    def test_source_map_adapters_preserve_optional_annotation(self):
        sys.path.insert(0, str(ROOT / "experiments/affidavit-association"))
        from data import source_mapping
        from audit_expansion import source_parts
        metadata = {"sha256": "a" * 64, "url": "https://example.org/invented-observations.pdf"}
        for value in (None, [], [4]):
            part = {"pages": [2, 3, 4]}
            if value is not None:
                part["document_starts"] = value
            mapped = source_mapping(metadata, part)
            expanded = source_parts(mapped)[0]
            self.assertEqual("document_starts" in expanded, value is not None)
            if value is not None:
                self.assertEqual(expanded["document_starts"], value)


class PipelineTests(unittest.TestCase):
    def test_offline_preparation_budget_resume_and_original_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sha, original = pdf(root / "home")
            dataset = root / "dataset.json"
            atomic_json(dataset, {"schema_version": "page-stream-dataset.v1", "sources": [source(sha)]})
            args = SimpleNamespace(dataset=dataset, out=root / "out", home=root / "home", execute=False,
                                   review=True,
                                   max_calls=None, limit=1, windows=1, attempts=2, timeout=1,
                                   sources=[], model="test-model", effort="low")
            replies = iter([{"document_starts": [3], "uncertain": []},
                            {"document_starts": [3], "uncertain": [2]}])

            def provider(**kwargs):
                value = next(replies)
                self.assertNotIn('"document_starts": [3]', kwargs["prompt"])
                atomic_json(kwargs["work_dir"] / "last-message.json", value)
                return value

            self.assertEqual(run(args, provider)["model_calls"], 0)
            job = args.out / "annotations" / sha
            self.assertFalse((job / "gold.json").exists())
            self.assertEqual(len(list((job / "calls").glob("*/*/request.json"))), 2)
            args.execute, args.max_calls = True, 1
            self.assertTrue(run(args, provider)["budget_exhausted"])
            self.assertFalse((job / "gold.json").exists())
            self.assertEqual(run(args, provider)["model_calls"], 1)
            accepted = read_json(job / "gold.json")["sources"]
            self.assertEqual(accepted, [{"sha256": sha, "pages": [2, 3, 4], "document_starts": [3]}])
            self.assertEqual(read_json(job / "receipt.json")["unknown_gaps"], [2])
            self.assertEqual(run(args, provider)["model_calls"], 0)
            corrected = read_json(job / "gold.json")
            corrected["sources"][0]["document_starts"] = []
            atomic_json(job / "gold.json", corrected)
            args.model, args.max_calls = "another-test-model", 2
            replies = iter([{"document_starts": [], "uncertain": []}] * 2)
            self.assertEqual(run(args, provider)["model_calls"], 2)
            self.assertEqual(read_json(job / "gold.json")["sources"],
                             [{"sha256": sha, "pages": [1, 2, 3, 4], "document_starts": []}])
            original.write_bytes(b"changed original")
            with self.assertRaisesRegex(ValueError, "path/hash"):
                run(args, provider)

    def test_single_author_uses_one_call_and_preserves_uncertainty(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sha, _ = pdf(root / "home")
            dataset = root / "dataset.json"
            atomic_json(dataset, {"schema_version": "page-stream-dataset.v1", "sources": [source(sha)]})
            args = SimpleNamespace(dataset=dataset, out=root / "out", home=root / "home", execute=True,
                                   review=False, max_calls=1, limit=1, windows=1, attempts=1, timeout=1,
                                   sources=[], model="test-model", effort="low")
            def provider(**kwargs):
                from jsonschema import Draft202012Validator, ValidationError
                validator = Draft202012Validator(read_json(kwargs["schema_path"]))
                with self.assertRaises(ValidationError):
                    validator.validate({"document_starts": [5], "uncertain": []})
                return {"document_starts": [3, 3], "uncertain": [2, 2]}
            result = run(args, provider)
            self.assertEqual(result["model_calls"], 1)
            self.assertEqual(result["windows_completed"], 1)
            job = args.out / "annotations" / sha
            self.assertEqual(read_json(job / "gold.json")["sources"],
                             [{"sha256": sha, "pages": [2, 3, 4], "document_starts": [3]}])
            self.assertEqual(read_json(job / "receipt.json")["review"], "single model author")

    def test_current_gold_historical_receipts_and_cross_partition_families(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            (home / "corpus").mkdir()
            a, _ = pdf(home, "River basin observations")
            b, _ = pdf(home, "Orchard irrigation log")
            c, _ = pdf(home / "synthetic", "Invented orchard appendix")
            with closing(sqlite3.connect(home / "corpus/corpus.sqlite")) as db, db:
                db.executescript("create table files(sha256 text,path text,pages integer);"
                                 "create table documents(sha256 text,collection text);"
                                 "create table gold_memberships(dataset text,record_id text,sha256 text,owner_sha256 text);")
                db.executemany("insert into files values(?,?,?)", [(a, f"known-remote-only/{a}.pdf", 4), (b, f"{b}.pdf", 0),
                                                                    (c, f"synthetic/{c}.pdf", 4)])
                db.execute("insert into gold_memberships values('invented','one',?,?)", (a, b))
            store, golds = home / "gold", []
            for sha, split in ((a, "train"), (b, "development")):
                atomic_json(store / sha / "source.json", {"partition": split})
                path = store / sha / "structure" / "invented-a" / "gold.json.gz"
                atomic_json(path, gold(sha))
                atomic_json(path.with_name("receipt.json"), {"status": "complete", "mode": "digitalborn", "source_sha256": sha,
                            "gold_sha256": digest(path) if sha == a else "0" * 64})
                golds.append((sha, path))
            args = SimpleNamespace(home=home, out=home / "out", association=[], legacy=home / "absent",
                                   medical=home / "absent.json", annotations=[])
            # The registry's lookup of the store's current golds; source.json is read from the store's folder.
            store_patch = mock.patch.multiple(gold_store, ROOT=store, sources=lambda kind: golds)
            store_patch.start()
            self.addCleanup(store_patch.stop)
            report = prepare(args)
            self.assertEqual(report["known_gaps"], 6)
            self.assertEqual(report["positive_gaps"], 2)
            self.assertEqual(len(report["authoring_receipt_differences"]), 1)
            self.assertEqual(report["recovered_page_counts"][b]["pdf_pages"], 4)
            self.assertEqual(set(report["unresolved_local_paths"]), {a})
            self.assertEqual(report["by_split"], {"unassigned": 2})
            self.assertEqual(len(report["partition_conflicts"]), 1)
            rows = read_json(args.out / "dataset.json")["sources"]
            self.assertEqual(rows[0]["family_id"], rows[1]["family_id"])
            rows[0]["split"] = "train"
            with self.assertRaisesRegex(ValueError, "crosses partitions"):
                check_partitions(rows)
            exported = [json.loads(line) for line in (args.out / "gaps-unassigned.jsonl").read_text().splitlines()]
            self.assertEqual(len(exported), 6)
            review = home / "review.json"
            atomic_json(review, {"sources": [{"sha256": c, "pages": [2, 3], "cover_pages": [1], "document_starts": []}]})
            args.annotations = [review]
            self.assertEqual(prepare(args)["known_gaps"], 7)
            revised = next(r for r in read_json(args.out / "dataset.json")["sources"] if r["sha256"] == c)
            self.assertEqual(revised["labels"], {"3": 0})

    def test_real_tree_training_excludes_unknown_gaps_and_test_file(self):
        from train_baseline import train
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            atomic_json(root / "features.json", ["invented_measurement"])
            sources = []
            for split, letters in (("train", "ab"), ("development", "cd")):
                rows = []
                for letter in letters:
                    sha = letter * 64
                    sources.append(source(sha, 40, {str(p): int(p % 4 == 0) for p in range(2, 40)}, split))
                    rows.append({"sha256": sha, "pages": list(range(40)), "features": [[float(p % 4)] for p in range(40)]})
                (root / f"rows-{split}.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
            (root / "rows-test.jsonl").write_text("must never be opened as training data")
            atomic_json(root / "dataset.json", {"sources": sources, "report": {"partition_status": "invented fixture"}})
            result = train(SimpleNamespace(dataset=root / "dataset.json", rows=root, out=root / "trained", rounds=3))
            self.assertEqual(result["train_gaps"], 76)
            self.assertEqual(result["development_gaps"], 76)
            self.assertEqual(result["counts"]["unknown_gaps"], 2)
            self.assertEqual(result["coverage"], 1)
            self.assertTrue((root / "trained/model.txt").is_file())


class ContextRescueTests(unittest.TestCase):
    def test_context_stays_inside_original_and_contains_the_requested_pair(self):
        from window_probe import page_window
        for count in (2, 3, 5, 20):
            for page in range(2, count + 1):
                for size in (2, 4, 8, 16):
                    visible = page_window(page, count, size)
                    self.assertEqual(len(visible), min(size, count))
                    self.assertTrue({page - 1, page} <= set(visible))
                    self.assertTrue(set(visible) <= set(range(1, count + 1)))

    def test_rescue_scores_new_control_errors_and_mixed_page_abstention(self):
        from context_rescue import ARMS, SIZES, summarize
        cases = [{"case_id": "invented-failure", "right_page": 2, "expected": 1, "group": "previous_mismatch"},
                 {"case_id": "invented-control", "right_page": 2, "expected": 0, "group": "successful_control"},
                 {"case_id": "invented-mixed", "right_page": 2, "expected": None, "group": "mixed_page"}]
        jobs, results, assignments = [], [], {}
        for case in cases:
            cid = case["case_id"]
            assignments[cid] = {str(size): {} for size in SIZES}
            for arm in ARMS:
                for size in (2, 4):
                    key = f"{cid}/{arm}/{size}"
                    jobs.append({"key": key, "pages": list(range(1, size + 1))})
                    value = 0 if size == 2 else (None if case["expected"] is None else 1)
                    results.append({"key": key, "status": "complete", "labels": {} if value is None else {2: value}})
                    for requested in SIZES:
                        if (requested == 2) == (size == 2):
                            assignments[cid][str(requested)][arm] = key
        report = summarize({"cases": cases, "jobs": jobs, "assignments": assignments, "sizes": [4],
                            "protocol": "Invented evidence"}, results)
        self.assertEqual(set(report["arms"]), {"luna-max/4", "sol-low/4"})
        arm = report["arms"]["luna-max/4"]
        self.assertEqual(arm["previous_mismatch"]["rescued_to_correct"], 1)
        self.assertEqual(arm["successful_control"]["wrong"], 1)
        self.assertEqual(arm["mixed_page"]["appropriate_abstention"], 1)


class PairProbeTests(unittest.TestCase):
    def test_balanced_selection_and_eight_disjoint_new_scopes(self):
        from collections import Counter
        from pair_probe import select_cases, select_new_scopes
        references = []
        for number in range(80):
            sha = fingerprint(["invented-reference", number])
            row = source(sha, 12, {"2": 0, "3": 1, "4": 0})
            row.update(evidence=[], kinds=["medical"] if number < 8 else ["affidavit"])
            references.append(row)
        chosen = select_cases(references, 64)
        self.assertEqual(Counter(r["expected"] for r in chosen), {0: 32, 1: 32})
        self.assertEqual(len({r["case_id"] for r in chosen}), 64)
        self.assertGreaterEqual(len({r["family_id"] for r in chosen}), 24)
        fresh = []
        for number in range(12):
            sha = fingerprint(["invented-new-scope", number])
            row = source(sha, 14)
            row.update(evidence=[], kinds=["medical"] if number < 6 else ["affidavit"])
            fresh.append(row)
        new = select_new_scopes(fresh, chosen)
        self.assertEqual(len(new), 64)
        self.assertEqual(set(Counter(r["sha256"] for r in new).values()), {8})
        self.assertTrue(all(r["expected"] is None for r in new))
        self.assertFalse({r["family_id"] for r in new} & {r["family_id"] for r in chosen})

    def test_uncertainty_failures_and_new_labels_are_not_accuracy_errors(self):
        from pair_probe import summarize
        cases = [{"case_id": "invented-known", "right_page": 2, "expected": 1,
                  "cohort": "existing_gold", "family_id": "invented-family"},
                 {"case_id": "invented-new", "right_page": 3, "expected": None,
                  "cohort": "new_scope", "family_id": "another-invented-family"}]
        rows = [{"arm": "luna-max", "case_id": "invented-known", "status": "complete", "labels": {}},
                {"arm": "sol-low", "case_id": "invented-known", "status": "failed"},
                *[{"arm": arm, "case_id": "invented-new", "status": "complete", "labels": {3: 1}}
                  for arm in ("luna-max", "sol-low")]]
        from pair_probe import ARMS
        report = summarize({"arms": ARMS, "cases": cases, "protocol": "Invented evidence"}, rows)
        self.assertEqual(report["arms"]["luna-max"]["uncertain"], 1)
        self.assertEqual(report["arms"]["luna-max"]["missed_splits"], 0)
        self.assertEqual(report["arms"]["sol-low"]["unfinished"], 1)
        self.assertEqual(report["paired"]["new_scope"], {"answered_by_both": 1, "agree": 1})
        self.assertEqual(report["differences"], [])


if __name__ == "__main__":
    unittest.main()
