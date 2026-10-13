import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("harness", Path(__file__).with_name("harness.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class ComparisonTests(unittest.TestCase):
    def test_gate_rejects_missing_measurements_changed_outputs_and_slower_candidate(self):
        before = dict(input_sha256="fixed-input", request_count=3, repeats=3, samples=5, platform="same-machine",
                      responses=["a", "b", "c"], cold_s=1, warm_s=2, peak_bytes=100, wasm_bytes=200)
        self.assertEqual(harness.compare(before, before), [])
        candidate = dict(before, responses=["a", "changed", "c"], warm_s=3, wasm_bytes=None)
        self.assertEqual(harness.compare(before, candidate),
                         ["Response bytes changed", "Regression: warm_s 2 -> 3", "Unmeasured: wasm_bytes"])
        self.assertTrue(any("Incomparable" in item for item in
                            harness.compare(before, dict(before, input_sha256="different-input"))))


if __name__ == "__main__":
    unittest.main()
