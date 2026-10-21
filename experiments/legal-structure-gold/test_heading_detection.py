import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from heading_detection import context, counts, read_rows


class HeadingDetectionTest(unittest.TestCase):
    def test_unknown_alignment_and_neighbours_do_not_cross_documents(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rows-train.jsonl"
            records = []
            for sha, value, label in (("alpha", 1, None), ("beta", 8, [3, 1])):
                records.append({"sha256": sha, "split": "train", "mode": "digitalborn",
                                "ids": ["line@0"], "features": [[value, 99]],
                                "gold": [label], "tier0": [[1, 1]], "text": [["Garden tools"]]})
            path.write_text("\n".join(map(json.dumps, records)), encoding="utf-8")
            rows, _ = read_rows(path, ["size", "o_level"])
            np.testing.assert_array_equal(rows.target, [-1, 1])
            matrix = context(rows)
            np.testing.assert_array_equal(matrix[:, 0], [1, 8])
            self.assertTrue(np.isnan(matrix[:, 1:]).all())
            measured = counts(rows.target, np.asarray([True, True]))
            self.assertEqual((measured["expected"], measured["predicted"], measured["correct"]), (1, 1, 1))


if __name__ == "__main__":
    unittest.main()
