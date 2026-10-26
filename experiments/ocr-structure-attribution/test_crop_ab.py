"""Independent status examples; a candidate must not hide losses as unaligned readings."""
import unittest

from crop_ab import compare
from analyze import measure_detail, text_near


class CropComparisonTest(unittest.TestCase):
    def test_padded_neighbour_does_not_become_part_of_the_mark_reading(self):
        trace={'turns':0,'points_per_pixel':[1,1],'width':200,'height':100,
               'core_boxes':[[20,20,120,29],[20,30,120,40]],
               'lines':[{'bbox':[10,14,131,36],'text':'Unrelated earlier row.','kept':True},
                        {'bbox':[10,24,131,47],'text':'7 Quiet lanterns.','kept':True}]}
        self.assertEqual(text_near({'bbox':[20,27,120,39]},trace),'7 Quiet lanterns.')
        self.assertIsNone(text_near({'bbox':[20,20,120,39]},trace))

    def test_glyph_observation_keeps_an_added_digit_in_merged_line_context(self):
        observation = measure_detail({'corrected':'The bell rings13','start':14,'end':16},
                                    'The bell rings131 while a violet boat crosses the quiet pond.')
        self.assertEqual(observation['status'], 'value')
        self.assertEqual(observation['observed'].strip(), '131')

    def test_recovery_does_not_cancel_out_a_newly_unreadable_intact_mark(self):
        result = compare(['intact', 'value', 'intact', 'unaligned'],
                         ['missing', 'intact', 'unaligned', 'intact'])
        self.assertEqual(result['rescued'], 1)
        self.assertEqual(result['regressed'], 1)
        self.assertEqual(result['intact_to_unresolved'], 1)
        self.assertEqual(result['gained_alignment'], 1)
        self.assertEqual(result['baseline_intact'], result['candidate_intact'])


if __name__ == '__main__': unittest.main()
