"""Independent invented targets test the training-data and family boundaries."""
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image

from unittest import mock

from train_doc_split import selection
from merge_doc_split_gold import gold_store, merge, page_edge_runs


class TeacherSelectionTests(unittest.TestCase):
    def test_export_keeps_later_run_without_reintroducing_omitted_teacher_case(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base, gold = root/'teacher', root/'gold'
            base.mkdir()
            (base/'images').mkdir()
            gold.mkdir()
            sha = 'a'*64
            originals = gold/'annotations'/sha/'pages'
            originals.mkdir(parents=True)
            for page in range(1,11):
                Image.new('RGB',(4,4),(page,0,0)).save(originals/f'page-{page:06d}-4.png')
            inputs = {base/'teacher-training.json': {'cases':[{'sha256':sha,'family_id':'invented-family',
                'case_id':'omitted-panel','right_page':7,'label':0,'split':'train','images':[],'gold_panel':'invented'}]},
                base/'teacher-test.json': {'cases':[]}, base/'family-map.json': {},
                gold/'authoring-splits.json': {'sources':[{'sha256':sha,'pages':list(range(1,11)),
                    'document_starts':[1,4,9,{'page':7,'line':8}]}]},
                gold/'authoring-manifest-all.json': {'documents':[{'sha256':sha,'pages':10}]},
                gold/'reviewed.json': {'decisions':[]},
                root/'store'/sha/'source.json': {'partition':'train'}}
            for path, value in inputs.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value))
            with mock.patch.object(gold_store, 'ROOT', root/'store'):
                merge(base,gold)
            exported = selection(base/'training.json')
            self.assertEqual([[i['page'] for i in c['images']] for c in exported['cases']],[[1,2,3],[9,10]])
            self.assertEqual([c['targets'] for c in exported['cases']],[{'2':0,'3':0},{'10':0}])
            self.assertNotIn('within_page_gold',exported)

    def test_valid_runs_before_and_after_internal_split(self):
        targets, runs = page_edge_runs({'pages': list(range(1, 11)),
            'document_starts': [1, 4, 9, {'page': 7, 'line': 8}]}, 10)
        self.assertEqual(targets, {2: 0, 3: 0, 10: 0})
        self.assertEqual(runs, [[1, 3], [9, 10]])

    def test_internal_split_in_first_document_omits_entire_packet(self):
        self.assertEqual(page_edge_runs({'pages': [1, 2, 3],
            'document_starts': [1, {'page': 2, 'line': 8}]}, 3), ({}, []))

    def test_packet_without_internal_splits_is_unchanged(self):
        self.assertEqual(page_edge_runs({'pages': [1, 2, 3, 4],
            'document_starts': [1, 3]}, 4), ({2: 0, 3: 1, 4: 0}, [[1, 4]]))

    def test_multiple_internal_splits_and_incomplete_scope(self):
        self.assertEqual(page_edge_runs({'pages': [1, 2, 3, 4, 5, 6, 8, 9, 10],
            'document_starts': [1, 3, 5, 7, 9, {'page': 3, 'line': 2}, {'page': 5, 'line': 4}]}, 10),
            ({2: 0, 10: 0}, [[1, 2], [9, 10]]))

    def test_pdf_inventory_is_not_training_data(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'dataset.json'
            path.write_text(json.dumps({'sources': [{'sha256': 'a'*64, 'labels': {'2': 0}}]}))
            with self.assertRaisesRegex(ValueError, 'reviewed teacher-target'):
                selection(path)

    def test_related_packets_cannot_cross_partitions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'teacher.json'
            cases = [{'case_id': 'invented-' + str(i), 'family_id': 'invented-shipment',
                      'sha256': str(i)*64, 'split': split, 'targets': {'12': i},
                      'images': [{'page': 11}, {'page': 12}]} for i, split in enumerate(('train', 'development'))]
            path.write_text(json.dumps({'schema_version': 'doc-split-teacher.v2',
                                       'source_artifacts': {'invented-gold.json': 'b'*64}, 'cases': cases}))
            with self.assertRaisesRegex(ValueError, 'source family'):
                selection(path)


if __name__ == '__main__':
    unittest.main()
