import unittest
import numpy as np

from ctc_focus import aligned_positions


class CtcFocusTests(unittest.TestCase):
    def test_repeated_glyphs_keep_separate_target_positions(self):
        labels = [1, 1]
        log_probs = np.log(np.array([[.01, .99], [.99, .01], [.01, .99]], dtype=np.float32))
        emissions = log_probs[:, [0, 1, 0, 1, 0]]
        np.testing.assert_array_equal(aligned_positions(emissions, labels), [0, -1, 1])

    def test_repeated_glyphs_cannot_be_forced_into_too_few_frames(self):
        with self.assertRaises(ValueError):
            aligned_positions(np.zeros((2, 5), dtype=np.float32), [1, 1])


if __name__ == '__main__':
    unittest.main()
