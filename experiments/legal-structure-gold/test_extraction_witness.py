"""Independent OCR must remain bound to the actual source, pages and unique lines."""
from copy import deepcopy
import unittest

from author import witnessed_lines


def witness():
    return {'schema_version':'legal-structure-gold.extraction.v1', 'source_sha256':'invented-source',
            'page_count':2, 'method':{'provider':'invented-ocr'},
            'pages':[{'page':1,'lines':[{'id':'p1-l1','text':'An independently invented sentence.'}]},
                     {'page':2,'lines':[]}]}


class ExtractionWitness(unittest.TestCase):
    def test_accepts_bound_lines_and_a_blank_page(self):
        self.assertEqual(witnessed_lines(witness(),'invented-source',2),
                         [{'id':'p1-l1','page':1,'text':'An independently invented sentence.'}])

    def test_rejects_wrong_source_or_page_count(self):
        for source,pages in [('another-source',2),('invented-source',3)]:
            with self.subTest(source=source,pages=pages),self.assertRaises(ValueError):
                witnessed_lines(witness(),source,pages)

    def test_rejects_repeated_pages_and_duplicate_line_ids(self):
        repeated=witness();repeated['pages'][1]['page']=1
        duplicate=witness();duplicate['pages'][1]['lines']=deepcopy(duplicate['pages'][0]['lines'])
        for value in [repeated,duplicate]:
            with self.assertRaises(ValueError):witnessed_lines(value,'invented-source',2)

    def test_rejects_missing_text_or_method(self):
        empty=witness();empty['pages'][0]['lines'][0]['text']=' '
        missing=witness();missing['method']={}
        for value in [empty,missing]:
            with self.assertRaises(ValueError):witnessed_lines(value,'invented-source',2)


if __name__=='__main__':unittest.main()
