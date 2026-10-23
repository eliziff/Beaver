"""The scorer shares the authoring extraction cache; no model calls or builds."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import score_all
import gold


class NativeSessionTest(unittest.TestCase):
    def test_persistent_operations_match_single_requests_and_recover_after_error(self):
        binary = Path(os.environ.get('LEGAL_STRUCTURE_ADDON') or
                      score_all.ROOT / 'native/legal-structure-node/target/release/legal_structure_node.dll')
        if not binary.is_file(): self.skipTest('A built native addon is required')
        request = {'lines': [], 'groups': [], 'annotations': [], 'reading_order': [], 'continuations': {}}
        with patch.dict(os.environ, LEGAL_STRUCTURE_ADDON=str(binary.resolve())):
            try:
                expected = {}
                for command in ('--compose-structure', '--resolve-annotations'):
                    expected[command] = json.loads(subprocess.check_output(
                        ['node', str(score_all.HERE / 'extract.mjs'), command],
                        input=json.dumps(request), text=True, encoding='utf-8', timeout=30))
                    self.assertEqual(gold.native(command, request), expected[command])
                with self.assertRaisesRegex(ValueError, 'Unknown native operation'):
                    gold.native('--invented-operation', {})
                self.assertEqual(gold.native('--compose-structure', request), expected['--compose-structure'])
            finally:
                gold.close_native()


class ScoreProgressTest(unittest.TestCase):
    def test_reports_completion_before_slow_first_document_finishes(self):
        release = threading.Event()
        partial = threading.Event()
        real_write = score_all.write_json
        def write(path, value):
            real_write(path, value)
            if value['completed'] == 1: partial.set()
        def score(item):
            if item[0] == 'slow':
                if not release.wait(10): raise TimeoutError('Test did not release slow document')
            return {'run': item[0], 'metrics': {}}

        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            sources = {'slow': ('one', None), 'fast': ('two', None)}
            with patch.object(score_all, 'ProcessPoolExecutor', ThreadPoolExecutor), \
                    patch.object(score_all, 'score_one', score), \
                    patch.object(score_all, 'write_json', write), ThreadPoolExecutor(1) as caller:
                future = caller.submit(score_all.score_sources, sources, out, 2)
                try:
                    self.assertTrue(partial.wait(5))
                    progress = score_all.read_json(out / 'score/progress.json')
                    self.assertEqual(progress['completed'], 1)
                    self.assertEqual(progress['total'], 2)
                    self.assertFalse(future.done())
                finally:
                    release.set()
                self.assertEqual([r['run'] for r in future.result(timeout=5)], ['slow', 'fast'])
                self.assertEqual(score_all.read_json(out / 'score/progress.json')['completed'], 2)


class ScoreCacheTest(unittest.TestCase):
    def test_scoring_reuses_authored_extraction(self):
        binary = Path(os.environ.get('LEGAL_STRUCTURE_ADDON') or
                      score_all.ROOT / 'native/legal-structure-node/target/release/legal_structure_node.dll')
        if not binary.is_file():
            self.skipTest('A built native addon is required')
        import fitz

        with tempfile.TemporaryDirectory(prefix='legal-structure-cache-') as directory:
            root = Path(directory)
            pdf, out = root / 'invented.pdf', root / 'gold'
            with fitz.open() as document:
                page = document.new_page()
                page.insert_text((72, 72), 'Workshop schedule\n7. The blue parcel arrives on Tuesday.')
                document.save(pdf)
            sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
            job = out / 'v4' / sha
            job.mkdir(parents=True)
            with patch.dict(os.environ, LEGAL_STRUCTURE_ADDON=str(binary.resolve())):
                result = subprocess.check_output(
                    ['node', str(score_all.HERE / 'extract.mjs'), str(pdf), str(out / 'parsed'), 'digitalborn'],
                    text=True, encoding='utf-8', timeout=90)
                authored = Path(result.strip().splitlines()[-1])
                extractions = set(out.glob('**/parse-v1/extractions/*.json.gz'))
                self.assertTrue(extractions)
                produced, errors = score_all.extract_all(
                    [('digitalborn', job, {'source_sha256': sha})], out, 1, {sha: pdf})

                value = score_all.read_json(authored)
                lines = list(gold.source_lines(value['structure']).values())
                expected = {'schema_version': 'legal-structure-gold.v4', 'source_sha256': sha,
                            'lines': lines, 'notes': [], 'typed': [], 'units': []}
                for i, line in enumerate(lines):
                    expected['typed'].append({'region': 'heading' if i == 0 else 'text',
                                              'spans': gold.whole([line['id']], {line['id']: line}),
                                              'markers': [], 'references': []})
                    expected['units'].append({'lines': [i], 'parent': None if i == 0 else 0,
                                              'starts_document': False, 'ends_document': False})
                def single_request(command, request):
                    return json.loads(subprocess.check_output(
                        ['node', str(score_all.HERE / 'extract.mjs'), command],
                        input=json.dumps(request), text=True, encoding='utf-8', timeout=30))
                with patch.object(gold, 'native', single_request):
                    before = score_all.evaluate.compare(expected, value)
                try:
                    self.assertEqual(score_all.evaluate.compare(expected, value), before)
                finally:
                    gold.close_native()

            self.assertEqual(errors, {})
            candidate = Path(produced[str(job.relative_to(out))][0])
            self.assertEqual(score_all.read_json(candidate)['extraction'],
                             score_all.read_json(authored)['extraction'])
            self.assertEqual(set(out.glob('**/parse-v1/extractions/*.json.gz')), extractions,
                             'Scoring created a second extraction instead of reusing authoring output')


if __name__ == '__main__':
    unittest.main()
