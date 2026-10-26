import unittest

from gold_inventory import corrected_lines, geometry


class GoldInventoryTests(unittest.TestCase):
    def test_corrected_transcript_keeps_glyphs_and_rejects_bad_old_text(self):
        gold = {'lines': [{'id': 'a', 'text': '(q) A sample.'}],
                'text_edits': [{'line_id': 'a', 'start': 1, 'end': 2, 'old': 'q', 'text': 'b'}]}
        _, text, explicit, error = next(corrected_lines(gold))
        self.assertEqual((text, explicit, error), ('(b) A sample.', True, None))
        gold['lines'][0]['corrected'] = '(b) A sample.'
        self.assertIsNone(next(corrected_lines(gold))[3])
        gold['lines'][0]['corrected'] = '(d) A sample.'
        self.assertEqual(next(corrected_lines(gold))[3], 'inconsistent_correction_encodings')
        del gold['lines'][0]['corrected']
        gold['text_edits'][0]['old'] = 'z'
        self.assertEqual(next(corrected_lines(gold))[3], 'invalid_text_edit')

    def test_display_markup_cannot_be_an_ocr_target(self):
        gold = {'lines': [{'id': 'a', 'text': 'A sample.[[r:8]]'}]}
        self.assertEqual(next(corrected_lines(gold))[3], 'invalid_or_display_target')

    def test_superseded_package_lines_are_already_corrected(self):
        gold = {'lines': [{'id': 'a', 'text': 'Example8.'}, {'id': 'b', 'text': '(c) Extra.'}],
                'source_text': {'a': 'ExampleB.', 'b': ''}}
        rows = list(corrected_lines(gold))
        self.assertEqual([(r[1], r[2], r[3]) for r in rows],
                         [('Example8.', True, None), ('(c) Extra.', True, None)])

    def test_package_normalized_box_and_stale_cache(self):
        line = {'id': 'a', 'page': 2, 'text': 'A sample.', 'box': [100, 200, 500, 250]}
        gold = {'pages': [{'page': 2, 'width_points': 600, 'height_points': 800}]}
        self.assertEqual(geometry(line, gold, {})[0], (60., 160., 300., 200.))
        del line['box']
        cached = {'a': {**line, 'text': 'Different text.', 'bbox': [60, 160, 300, 200]}}
        self.assertIsNone(geometry(line, gold, cached)[0])


if __name__ == '__main__':
    unittest.main()
