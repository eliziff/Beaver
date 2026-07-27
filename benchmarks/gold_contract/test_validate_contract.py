from __future__ import annotations

import unittest

import validate_contract as validator


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.index = validator.validate_contract(validator.load_json(validator.CONTRACT_PATH))

    def test_contract_is_complete_and_unique(self) -> None:
        self.assertGreater(len(self.index), 100)

    def test_accuracy_claim_is_rejected_for_not_scoreable_metric(self) -> None:
        aggregate = {
            "evidence": {
                "gold_sha256": "x",
                "scorer_sha256": "x",
                "corpus_manifest_sha256": "x",
                "admissible_statuses": ["accepted"],
                "duplicate_fingerprint_count": 0,
                "derivative_family_collision_count": 0,
                "pstream_policy": "one_least_edited_upstream_per_work_family",
                "sampling_design": "challenge",
            },
            "metrics": [
                {
                    "metric": "alr.supra.exact_link_accuracy",
                    "claim": "case_set_accuracy",
                    "value": 1.0,
                }
            ],
        }
        with self.assertRaisesRegex(validator.ContractError, "does not permit"):
            validator.validate_aggregate(aggregate, self.index)

    def test_not_scoreable_diagnostic_requires_literal_label(self) -> None:
        aggregate = {
            "evidence": {
                "gold_sha256": "x",
                "scorer_sha256": "x",
                "corpus_manifest_sha256": "x",
                "admissible_statuses": [],
                "duplicate_fingerprint_count": 0,
                "derivative_family_collision_count": 0,
                "pstream_policy": "one_least_edited_upstream_per_work_family",
                "sampling_design": "challenge",
            },
            "metrics": [
                {
                    "metric": "toa.discrepancy.match_score",
                    "claim": "descriptive",
                    "label": "accuracy",
                    "value": 0.99,
                }
            ],
        }
        with self.assertRaisesRegex(validator.ContractError, "labelled NOT SCOREABLE"):
            validator.validate_aggregate(aggregate, self.index)


if __name__ == "__main__":
    unittest.main()
