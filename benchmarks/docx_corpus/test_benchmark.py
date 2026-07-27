from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark


def accepted_gold(
    case_id: str,
    text: str,
    parts: list[str],
    *,
    work_family_id: str | None = None,
    pstream_id: str | None = None,
) -> dict:
    return {
        "id": case_id,
        "footnote_text": text,
        "text_sha256": benchmark._text_sha(text),
        "expected_verbatim_parts": parts,
        "acceptable_partitions": [],
        "status": "accepted",
        "work_family_id": work_family_id or f"work-{case_id}",
        "pstream_id": pstream_id or f"upstream-{case_id}",
        "edition_role": benchmark.LEAST_EDITED_ROLE,
        "adjudication": {
            "provenance": "human",
            "reviewer_id": "test-reviewer",
            "guideline_version": "test-guideline-v1",
            "schema_version": benchmark.GOLD_ADJUDICATION_SCHEMA,
            "adjudicated_at": "2026-07-26T00:00:00Z",
        },
    }


class DocxCorpusBenchmarkTests(unittest.TestCase):
    def test_document_failure_is_atomic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            docx = Path(temporary) / "fixture.docx"
            benchmark._synthetic_docx(docx)
            real_split = benchmark.split_footnote
            calls = 0

            def flaky_split(text: str):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise RuntimeError("second note failed")
                return real_split(text)

            with patch.object(
                benchmark,
                "split_footnote",
                side_effect=flaky_split,
            ):
                result = benchmark._benchmark_document(
                    {
                        "id": "atomic",
                        "path": docx,
                        "sha256": benchmark._sha256(docx),
                        "bytes": docx.stat().st_size,
                        "features": {},
                    }
                )

            self.assertIn("second note failed", result["error"])
            self.assertEqual([], result["cases"])
            self.assertEqual([], result["conservative"])
            self.assertEqual([], result["recall_first"])

    def test_scan_fails_closed_on_document_error(self) -> None:
        local_docx = (
            benchmark.ROOT
            / "benchmarks"
            / "docx_corpus"
            / ".error-test.docx"
        )
        local_manifest = local_docx.with_suffix(".jsonl")
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "out"
            try:
                benchmark._synthetic_docx(local_docx)
                local_manifest.write_text(
                    json.dumps(
                        {
                            "id": "bad-hash",
                            "copy_path": str(
                                local_docx.relative_to(benchmark.ROOT)
                            ).replace("\\", "/"),
                            "sha256": "0" * 64,
                            "bytes": local_docx.stat().st_size,
                            "features": {},
                        }
                    )
                    + "\n",
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(RuntimeError, "1 document"):
                    benchmark.scan(local_manifest, output, workers=1)

                summary = json.loads(
                    (output / "summary.json").read_text(encoding="utf-8")
                )
                self.assertEqual(1, summary["document_errors"])
                self.assertEqual(
                    "",
                    (output / "cases.private.jsonl").read_text(
                        encoding="utf-8"
                    ),
                )
            finally:
                local_docx.unlink(missing_ok=True)
                local_manifest.unlink(missing_ok=True)

    def test_review_sample_is_protected_and_labeled_as_challenge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cases = root / "cases.jsonl"
            output = root / "review.jsonl"
            rows = [
                {
                    "id": f"case-{index}",
                    "document_id": f"doc-{index}",
                    "footnote_id": str(index),
                    "footnote_text": f"Authority {index}.",
                    "proposition": f"Proposition {index}.",
                    "text_sha256": benchmark._text_sha(
                        f"Authority {index}."
                    ),
                    "tags": [],
                    "conservative_eligible": eligible,
                }
                for index, eligible in ((1, True), (2, False))
            ]
            benchmark._write_jsonl(cases, rows)

            review = benchmark.sample_for_review(
                cases,
                output,
                sample_size=2,
                seed="test",
            )

            self.assertEqual(
                {"conservative_eligible", "conservative_abstention"},
                {row["sampling_stratum"] for row in review},
            )
            self.assertTrue(
                all(
                    row["sampling_design"] == "balanced_challenge"
                    for row in review
                )
            )
            with self.assertRaises(FileExistsError):
                benchmark.sample_for_review(
                    cases,
                    output,
                    sample_size=2,
                    seed="test",
                )

    def test_challenge_scores_disable_population_inference(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gold = root / "gold.jsonl"
            base = root / "base.jsonl"
            candidate = root / "candidate.jsonl"
            gold_rows = [accepted_gold("one", "A; B", ["A", "B"])]
            gold_rows[0].update(
                {
                    "sampling_design": "balanced_challenge",
                    "tags": ["challenge_conservative_eligible"],
                }
            )
            predictions = [
                {
                    "id": "one",
                    "status": "complete",
                    "actual_parts": ["A", "B"],
                }
            ]
            benchmark._write_jsonl(gold, gold_rows)
            benchmark._write_jsonl(base, predictions)
            benchmark._write_jsonl(candidate, predictions)

            result = benchmark.score(
                gold,
                [f"base={base}", f"candidate={candidate}"],
                root / "score.json",
                "base",
            )

            self.assertFalse(result["population_inference_valid"])
            self.assertIsNone(result["arms"]["base"]["strict_exact_95ci"])
            self.assertIsNone(
                result["paired_comparisons"]["candidate"][
                    "paired_sign_test_p"
                ]
            )

    def test_duplicate_prediction_ids_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gold = root / "gold.jsonl"
            predictions = root / "predictions.jsonl"
            benchmark._write_jsonl(
                gold,
                [accepted_gold("one", "A", ["A"])],
            )
            benchmark._write_jsonl(
                predictions,
                [
                    {
                        "id": "one",
                        "status": "complete",
                        "actual_parts": ["A"],
                    },
                    {
                        "id": "one",
                        "status": "complete",
                        "actual_parts": ["A"],
                    },
                ],
            )

            with self.assertRaisesRegex(ValueError, "unique"):
                benchmark.score(
                    gold,
                    [f"duplicate={predictions}"],
                    root / "score.json",
                    None,
                )

    def test_split_direction_respects_all_accepted_partition_counts(self) -> None:
        gold = [
            {
                "id": "one",
                "footnote_text": "A; B; C",
                "expected_verbatim_parts": ["A", "B", "C"],
                "acceptable_partitions": [["A; B", "C"]],
            }
        ]

        _summary, details = benchmark._score_arm(
            gold,
            {
                "one": {
                    "status": "complete",
                    "actual_parts": ["A", "B; C"],
                }
            },
        )
        self.assertEqual("boundary_mismatch", details["one"]["outcome"])

        _summary, details = benchmark._score_arm(
            gold,
            {
                "one": {
                    "status": "complete",
                    "actual_parts": ["A; B; C"],
                }
            },
        )
        self.assertEqual("under_split", details["one"]["outcome"])

    def test_only_human_accepted_status_is_scoreable(self) -> None:
        self.assertEqual({"accepted"}, benchmark.ACCEPTED_STATUSES)

    def test_accepted_gold_requires_human_adjudication_contract(self) -> None:
        row = accepted_gold("one", "A", ["A"])
        for field in (
            "reviewer_id",
            "guideline_version",
            "schema_version",
            "adjudicated_at",
        ):
            broken = {**row, "adjudication": dict(row["adjudication"])}
            broken["adjudication"][field] = ""
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, "adjudication"
            ):
                benchmark._validated_accepted_gold([broken])

        model_labeled = {**row, "adjudication": dict(row["adjudication"])}
        model_labeled["adjudication"]["provenance"] = "agent"
        with self.assertRaisesRegex(ValueError, "must be human"):
            benchmark._validated_accepted_gold([model_labeled])

        no_timezone = {**row, "adjudication": dict(row["adjudication"])}
        no_timezone["adjudication"]["adjudicated_at"] = "2026-07-26T00:00:00"
        with self.assertRaisesRegex(ValueError, "timezone"):
            benchmark._validated_accepted_gold([no_timezone])

    def test_accepted_gold_requires_integral_unique_content_fingerprints(self) -> None:
        first = accepted_gold("one", "A", ["A"])
        mismatched = {**first, "text_sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
            benchmark._validated_accepted_gold([mismatched])

        duplicate = accepted_gold("two", " A ", ["A"])
        with self.assertRaisesRegex(ValueError, "fingerprints must be unique"):
            benchmark._validated_accepted_gold([first, duplicate])

    def test_accepted_gold_requires_one_least_edited_pstream_per_work(self) -> None:
        first = accepted_gold(
            "one",
            "A",
            ["A"],
            work_family_id="same-work",
            pstream_id="upstream-a",
        )
        second = accepted_gold(
            "two",
            "B",
            ["B"],
            work_family_id="same-work",
            pstream_id="upstream-b",
        )
        with self.assertRaisesRegex(ValueError, "multiple pstreams"):
            benchmark._validated_accepted_gold([first, second])

        edited = {**first, "edition_role": "galley_edit"}
        with self.assertRaisesRegex(ValueError, "least_edited_upstream"):
            benchmark._validated_accepted_gold([edited])

    def test_prediction_ids_must_exactly_match_gold(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gold = root / "gold.jsonl"
            predictions = root / "predictions.jsonl"
            benchmark._write_jsonl(
                gold,
                [
                    accepted_gold("one", "A", ["A"]),
                    accepted_gold("two", "B", ["B"]),
                ],
            )
            for rows, expected in (
                (
                    [{"id": "one", "status": "complete", "actual_parts": ["A"]}],
                    "missing=.*two",
                ),
                (
                    [
                        {"id": "one", "status": "complete", "actual_parts": ["A"]},
                        {"id": "two", "status": "complete", "actual_parts": ["B"]},
                        {"id": "extra", "status": "complete", "actual_parts": ["C"]},
                    ],
                    "extra=.*extra",
                ),
            ):
                benchmark._write_jsonl(predictions, rows)
                with self.subTest(rows=rows), self.assertRaisesRegex(
                    ValueError, expected
                ):
                    benchmark.score(
                        gold,
                        [f"arm={predictions}"],
                        root / "score.json",
                        None,
                    )


if __name__ == "__main__":
    unittest.main()
