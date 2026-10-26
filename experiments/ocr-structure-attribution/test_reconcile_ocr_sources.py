import unittest

from reconcile_ocr_sources import reconcile


class ReconcileSourcesTests(unittest.TestCase):
    def test_synthetic_identity_is_not_an_extra_pdf_or_ocr_example(self):
        source, variant = 'a'*64, 'b'*64
        parent = {'artifact_sha256': 'c'*64, 'source_sha256': source, 'collection': 'desktop-current-v4',
                  'kind': 'line_transcript', 'pixel_locator': {'missing': True}, 'geometry_locator': {},
                  'ocr_sha256': 'd'*64, 'notes': {}}
        derived = {**parent, 'artifact_sha256': 'e'*64, 'source_sha256': variant, 'notes': {}}
        snapshot = {'rows': [parent, derived], 'archives': [], 'counts': {'unique_source_pdfs': 2}}
        recovery = {'pixels': {source: {'asset': 'recovery.tar.gz', 'member': 'pdfs/source.pdf'}},
                    'archives': [{'name': 'recovery.tar.gz', 'sha256': 'f'*64}]}
        check = {'source_identity': variant, 'artifact_sha256': 'e'*64, 'synthetic_of': source,
                 'parent_artifact_sha256': 'c'*64, 'equal_corrected_targets': True}
        result = reconcile(snapshot, recovery, {'checks': [check]}, 'example/private-gold', 'sample')
        self.assertEqual(result['counts']['unique_source_pdfs'], 1)
        self.assertEqual(result['counts']['missing_pixel_sources'], 0)
        self.assertEqual(derived['qualification'], 'excluded_derivative')
        self.assertEqual(derived['source_sha256'], source)


if __name__ == '__main__':
    unittest.main()
