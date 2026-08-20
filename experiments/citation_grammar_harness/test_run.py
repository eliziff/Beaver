import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("citation_harness", Path(__file__).with_name("run.py"))
assert SPEC and SPEC.loader
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


class CitationHarnessTests(unittest.TestCase):
    def test_split_is_stable_and_has_a_heldout_partition(self):
        first = [harness.split_name("en", f"2020 SCC {number}") for number in range(100)]
        second = [harness.split_name("en", f"2020 SCC {number}") for number in range(100)]
        self.assertEqual(first, second)
        self.assertGreater(first.count("heldout"), 10)
        self.assertLess(first.count("heldout"), 30)

    def test_occurrences_preserve_original_nbsp_offsets(self):
        text = "See 2019\u00a0SCC\u00a065 at para 4."
        spans = harness.occurrence_spans(text, "2019 SCC 65")
        self.assertEqual([text[start:end] for start, end in spans], ["2019\u00a0SCC\u00a065"])

    def test_first_occurrence_avoids_enumerating_repeated_citations(self):
        text = "2019 SCC 65 and 2019 SCC 65"
        self.assertEqual(harness.first_occurrence_span(text, "2019 SCC 65"), (0, 11))

    def test_span_hit_accepts_a_typed_span_inside_provider_gold(self):
        self.assertTrue(harness.span_hits([(8, 19, "cite.neutral")], [(4, 19)]))
        self.assertFalse(harness.span_hits([(0, 4, "cite.neutral")], [(4, 19)]))

    def test_failure_classes_keep_multitoken_dialects_visible(self):
        self.assertEqual(
            harness.citation_class("2020 Comp Trib 6"),
            "neutral-multitoken:Comp Trib",
        )


if __name__ == "__main__":
    unittest.main()
