import gzip
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from pack_ocr_gold import pack


class PackOcrGoldTests(unittest.TestCase):
    def test_structure_versions_share_one_ocr_view_and_keep_bound_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = 'e'*64
            artifacts = []
            for index in range(2):
                gold = {'source_sha256': source, 'schema_version': 'legal-structure-gold.v4', 'mode': 'ocr',
                        'lines': [{'id': 'line-a', 'page': 1, 'bbox': [10, 20, 170, 35],
                                   'text': 'The harbor.', 'corrected': 'The harbor7.'}],
                        'units': [{'depth': index}]}
                data = gzip.compress(json.dumps(gold).encode(), mtime=0)
                path = root/f'gold-{index}.json.gz'
                path.write_bytes(data)
                artifacts.append({'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(),
                                  'owner': 'invented', 'mode': 'ocr'})
            catalogue = root/'catalogue.json'
            catalogue.write_text(json.dumps({'runs': []}))
            config = {'owners': [{'name': 'invented', 'root': str(root)}], 'manifests': [],
                      'catalogue': str(catalogue), 'repository': 'example/private-gold',
                      'corpus_home': str(root), 'tag': 'invented-snapshot'}
            known = {'pdfs': {source: {'tag': 'old-snapshot', 'asset': 'source.tar.gz',
                                      'member': 'pdfs/'+source+'.pdf'}}}
            result = pack(config, artifacts, known, root/'out', 'test-gold')
            self.assertEqual(result['counts']['unique_ocr_views'], 1)
            self.assertEqual(result['counts']['artifact_files'], 2)
            self.assertEqual(result['counts']['missing_pixel_sources'], 0)
            self.assertEqual({r['corrected_line_count'] for r in result['rows']}, {1})
            archive = root/'out'/result['archives'][0]['name']
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), result['archives'][0]['sha256'])
            with tarfile.open(archive) as saved:
                for row in result['rows']:
                    data = saved.extractfile(row['gold_locator']['member']).read()
                    self.assertEqual(hashlib.sha256(data).hexdigest(), row['artifact_sha256'])


if __name__ == '__main__':
    unittest.main()
