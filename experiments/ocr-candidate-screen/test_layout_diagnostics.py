import unittest

from layout_diagnostics import distance, match


class LayoutDiagnosticsTest(unittest.TestCase):
    def test_duplicate_predictions_cannot_inflate_line_recall(self):
        gold = [[0, 0, 80, 10], [0, 20, 80, 30]]
        self.assertEqual(len(match(gold, [gold[0], gold[0]])), 1)
        self.assertEqual(len(match(gold, [gold[1], gold[0]])), 2)

    def test_character_distance_counts_codepoints(self):
        self.assertEqual(distance("æon", "aon"), 1)


if __name__ == "__main__":
    unittest.main()
