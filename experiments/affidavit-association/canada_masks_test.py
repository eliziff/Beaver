import pathlib,tempfile,json,shutil,unittest,fitz
from canada_masks import apply

class FilingFolios(unittest.TestCase):
    def test_strips_correlated_ab_headers_and_preserves_substantive_reference(self):
        scratch=pathlib.Path('.tmp').resolve();scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='canada-folio-test-',dir=scratch) as folder:
            root=pathlib.Path(folder);assert root.is_relative_to(scratch);original=root/'source.pdf'
            with fitz.open() as doc:
                for i in range(3):
                    page=doc.new_page();page.insert_text((40,40),f'AB{120+i}');page.insert_text((40,300),'The registry reference AB121 remains substantive.')
                doc.save(original)
            record=root/'record';(record/'files').mkdir(parents=True);shutil.copyfile(original,record/'files/doc-unknown.pdf')
            (record/'source.json').write_text(json.dumps({'canonical_source_path':str(original)}));(record/'split.json').write_text(json.dumps({'exhibits':[{'label':'A','file':'doc-unknown.pdf','source_pages':[1,2,3]}]}))
            apply(record,original)
            with fitz.open(record/'files/doc-unknown.pdf') as doc:
                for page in doc:
                    self.assertIn('registry reference AB121',page.get_text())
                    self.assertFalse(any(w[4] in ['AB120','AB121','AB122'] and w[1]<80 for w in page.get_text('words')))
            with fitz.open(original) as doc:self.assertIn('AB120',doc[0].get_text())

if __name__=='__main__':unittest.main()
