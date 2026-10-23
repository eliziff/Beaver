import unittest
from collect_record_pages import checked_pages,checked_ranges,groups,eligible_pages,unindexed_image_pages
import fitz


class PageSelectionTests(unittest.TestCase):
    def test_scanned_exhibit_is_reviewed_even_when_text_index_only_has_a_short_stamp(self):
        with fitz.open() as pdf:
            scanned=pdf.new_page()
            # Independently invented solid image stands in for a scan; no corpus content.
            image=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,8,8),False)
            image.clear_with(255)
            scanned.insert_image(fitz.Rect(0,0,100,100),pixmap=image)
            scanned.insert_text((10,120),'Filed exhibit')
            text=pdf.new_page()
            text.insert_text((10,20),'An independently invented ordinary text document. '*4)
            self.assertEqual(unindexed_image_pages(pdf),[1])

    def test_public_clinical_pages_keep_identifier_provenance_without_excluding_public_records(self):
        rows=[{'page':1,'eligible':True,'visible_patient_identifiers':True},
              {'page':2,'eligible':True,'visible_patient_identifiers':False},
              {'page':3,'eligible':False,'visible_patient_identifiers':False}]
        self.assertEqual(eligible_pages(rows),[1,2])
        self.assertTrue(rows[0]['visible_patient_identifiers'])

    def test_review_cannot_omit_repeat_or_invent_physical_pages(self):
        self.assertEqual(checked_pages({'pages':[{'page':7},{'page':3}]},[3,7]),[{'page':7},{'page':3}])
        for pages in [[{'page':3}],[{'page':3},{'page':3}],[{'page':3},{'page':8}]]:
            with self.assertRaises(ValueError):checked_pages({'pages':pages},[3,7])

    def test_disjoint_eligible_pages_preserve_original_contiguous_ranges(self):
        self.assertEqual(groups([9,2,3,3,6,10]),[[2,3],[6],[9,10]])
        self.assertEqual(groups([]),[])
        for first,last in [(0,3),(5,4),(1,12)]:
            with self.assertRaises(ValueError):checked_ranges({'ranges':[{'first':first,'last':last}]},10)


if __name__=='__main__':unittest.main()
