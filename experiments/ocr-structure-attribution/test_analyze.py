"""Independently invented observations; no source-document or user-context fixtures."""
import unittest
from analyze import observe, folded, measure


class AttributionTest(unittest.TestCase):
    def test_structural_edits_include_added_digits_at_both_span_edges(self):
        for actual in ['11. The lantern glows.', '21. The lantern glows.']:
            self.assertEqual(observe('1. The lantern glows.',actual,0,2)['status'],'value')

    def test_delimiters_and_spaces_do_not_become_changed_values(self):
        self.assertEqual(observe('[84] A violet kite.', '|84| A violet kite.',0,4)['status'],'delimiter_or_symbol')
        self.assertEqual(observe('(iv) A violet kite.','(i v) A violet kite.',0,4)['status'],'spacing')
        self.assertEqual(observe('A bird7 rests.','A bird 7 rests.',6,7)['status'],'intact')

    def test_lost_mark_and_unicode_scalar_offsets(self):
        gold='A 🦉 rests7 beside a pond.'
        self.assertEqual(observe(gold,'A 🦉 rests beside a pond.',9,10)['status'],'missing')
        self.assertEqual(observe(gold,'A 🦉 rests? beside a pond.',9,10)['status'],'value')

    def test_printed_private_use_bullets_keep_their_positions(self):
        self.assertEqual(folded('\uf0b7 A kite.'),'• A kite.')
        self.assertEqual(observe('• A kite.','\uf0b7 A kite.',0,1)['status'],'intact')

    def test_missing_observation_is_not_counted_as_a_recognition_failure(self):
        piece={'corrected':'(a) Red boats.','start':0,'end':3}
        self.assertEqual(measure(piece,None),'unobserved')
        self.assertEqual(measure(piece,'A quite different line of text.'),'unaligned')

    def test_fragment_alignment_keeps_extra_digits_on_merged_printed_rows(self):
        piece={'corrected':'1. Orange kites fly.','start':0,'end':2}
        self.assertEqual(measure(piece,'11. Orange kites fly. More writing follows on this printed row.'),'value')
        piece={'corrected':'The bell rings13','start':14,'end':16}
        self.assertEqual(measure(piece,'The bell rings131 while a violet boat crosses the quiet pond.'),'value')
        self.assertEqual(measure(piece,'The bell rings13 while a violet boat crosses the quiet pond.'),'intact')


if __name__=='__main__':unittest.main()
