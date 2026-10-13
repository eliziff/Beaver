import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("harness", Path(__file__).with_name("harness.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class ComparisonTests(unittest.TestCase):
    def test_schema_envelope_translation_cannot_hide_citation_or_profile_changes(self):
        result = {"id": 0, "result": {"schemaVersion": 4,
                  "citations": [{"span": {"text": "2034 ONCA 712"}}],
                  "sourceParts": [{"text": "2034 ONCA 712", "jurisdictionPriority": ["ca"]}]}}
        normalized = json.loads(harness.schema4_response(json.dumps(result).encode()))
        self.assertEqual(normalized["result"]["schemaVersion"], 3)
        self.assertEqual(normalized["result"]["citations"], result["result"]["citations"])
        self.assertEqual(normalized["result"]["sourceParts"], [{"text": "2034 ONCA 712", "extendedUs": False}])
        result["result"]["citations"][0]["span"]["text"] = "changed"
        self.assertNotEqual(normalized, json.loads(harness.schema4_response(json.dumps(result).encode())))
        result["result"]["sourceParts"][0]["jurisdictionPriority"] = ["us"]
        with self.assertRaises(ValueError):
            harness.schema4_response(json.dumps(result).encode())

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
