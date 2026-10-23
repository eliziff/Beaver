import unittest
from unittest.mock import patch

import hierarchy
import evaluate


def answer(parents):
    return {"parents": parents, "starts": [], "ends": []}


class HierarchyTest(unittest.TestCase):
    def test_parent_can_follow_its_children_in_column_reading_order(self):
        value = answer([[1, 3], [2, 3], [4, 2]])
        self.assertEqual(hierarchy.checked([0, 1, 2, 3])(value), value)

    def test_parent_graph_rejects_cycles_self_links_and_unshown_rows(self):
        for parents in ([[1, 3], [3, 2], [2, 1]], [[2, 2]], [[1, 5]], [[5, 1]], [[2, 1], [2, 3]]):
            with self.subTest(parents=parents), self.assertRaises(ValueError):
                hierarchy.checked([0, 1, 2, 3])(answer(parents))

    def test_forward_ancestor_is_carried_into_following_windows(self):
        rows = [(1, "text", "A"), (1, "heading", "B"),
                (2, "text", "C"), (2, "text", "D")]
        links = {1: 2, 3: 2, 4: 3}

        def ask(shown, pages):
            return hierarchy.checked(shown)(answer([
                [n + 1, links[n + 1]] for n in shown if n + 1 in links]))

        with patch.object(hierarchy, "BUDGET", 20):
            parents, starts, ends = hierarchy.decide(rows, ask, {1: 1, 2: 10})
        self.assertEqual(parents, [2, 0, 2, 3])
        self.assertEqual((starts, ends), (set(), set()))

    def test_scorer_preserves_a_parent_later_in_reading_order(self):
        labels = [("entry", "A", "text"), ("heading", "B", "heading")]
        spans = [{"line_id": ident, "start": 0, "end": len(text)} for ident, text, _ in labels]
        value = {
            "schema_version": evaluate.V4, "source_sha256": "1" * 64,
            "lines": [{"id": ident, "page": 1, "text": text} for ident, text, _ in labels],
            "typed": [{"page": 1, "region": region, "text": text, "start": True,
                       "spans": [span], "markers": [], "references": []}
                      for (_, text, region), span in zip(labels, spans)],
            "units": [{"lines": [n], "parent": 1 if n == 0 else None,
                       "starts_document": False, "ends_document": False} for n in range(2)],
            "notes": [],
        }
        _, frame = evaluate.projected(value)
        self.assertEqual(frame["groups"][0]["attributes"]["parent"], evaluate.gold.span_anchor(spans[1]))


if __name__ == "__main__":
    unittest.main()
