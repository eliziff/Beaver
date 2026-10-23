"""Invented raster text must survive a misplaced native filing-overlay removal."""
import unittest
import fitz
from us_native_headers import remove_overlays,image_hashes


class OverlayTests(unittest.TestCase):
    def test_midpage_native_overlay_keeps_date_and_overlapped_scan(self):
        with fitz.open() as body,fitz.open() as doc:
            b=body.new_page(width=620,height=780)
            b.insert_text((35,205),'Valve inspection notes remain complete below this transparent overlay.',fontsize=10)
            scan=b.get_pixmap(alpha=False)
            p=doc.new_page(width=620,height=780)
            p.insert_image(p.rect,stream=scan.tobytes('png'))
            p.insert_text((35,205),'Case 4:23-cv-812 Document 43-2 Filed 04/12/23 Page 2 of 6',fontsize=10,color=(0,0,1))
            images=image_hashes(doc,p)
            result=remove_overlays(doc,[0])
            self.assertEqual(len(result),1)
            self.assertEqual(image_hashes(doc,p),images)
            self.assertIn('Filed 04/12/23',p.get_text())
            self.assertNotIn('Document 43-2',p.get_text())
            clip=fitz.Rect(30,190,180,212)
            self.assertEqual(p.get_pixmap(clip=clip,alpha=False).samples,b.get_pixmap(clip=clip,alpha=False).samples)

    def test_does_not_remove_a_substantive_case_reference(self):
        with fitz.open() as doc:
            p=doc.new_page()
            p.insert_text((40,200),'The Case Analysis document describes a revised inspection schedule.')
            self.assertEqual(remove_overlays(doc,[0]),[])
            self.assertIn('revised inspection schedule',p.get_text())

    def test_identifying_stamp_after_running_paginator_was_removed(self):
        with fitz.open() as doc:
            p=doc.new_page()
            p.insert_text((40,205),'Case 4:23-cv-812 Document 43-2 Filed 04/12/23 Page',fontsize=10)
            self.assertEqual(len(remove_overlays(doc,[0])),1)
            self.assertNotIn('Document 43-2',p.get_text())
            self.assertIn('Filed 04/12/23',p.get_text())


if __name__=='__main__':
    unittest.main()
