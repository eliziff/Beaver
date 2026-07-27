import unittest

import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_fixtures_are_stable_and_have_all_ground_truth_fields(self):
        for fixture_id in benchmark.fixture_ids():
            fixture = benchmark.fixture_by_id(fixture_id)
            self.assertEqual(64, len(fixture["turns"]))
            self.assertEqual(set(benchmark.FIELDS), set(fixture["state"]))

    def test_perfect_prediction_hard_passes(self):
        fixture = benchmark.fixture_by_id(benchmark.fixture_ids()[0])
        score = benchmark.score_prediction(fixture["state"], dict(fixture["state"]))
        self.assertTrue(score["hard_pass"])
        self.assertEqual(1.0, score["score"])

    def test_exact_scorer_rejects_semantically_close_values(self):
        fixture = benchmark.fixture_by_id(benchmark.fixture_ids()[0])
        prediction = dict(fixture["state"])
        prediction["quote_exact"] = prediction["quote_exact"].replace("must", "should")
        prediction["tool_exit_code"] = "0"
        score = benchmark.score_prediction(fixture["state"], prediction)
        self.assertFalse(score["hard_pass"])
        self.assertEqual(len(benchmark.FIELDS) - 2, score["passed"])

    def test_capsule_has_bounded_tail(self):
        fixture = benchmark.fixture_by_id(benchmark.fixture_ids()[0])
        supplied = benchmark.arm_input(fixture, "structured_capsule")
        self.assertEqual(benchmark.TAIL_TURNS + 2, len(supplied))

    def test_ablation_removes_only_named_group(self):
        fixture = benchmark.fixture_by_id(benchmark.fixture_ids()[0])
        capsule = benchmark.exact_capsule(fixture, "no_tool_receipt_state")
        state = capsule["authoritative_state"]
        for field in benchmark.GROUPS["tool_receipts"]:
            self.assertNotIn(field, state)
        self.assertEqual(
            fixture["state"]["quote_exact"],
            state["quote_exact"],
        )


if __name__ == "__main__":
    unittest.main()
