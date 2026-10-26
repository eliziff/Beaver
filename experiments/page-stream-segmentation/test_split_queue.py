"""Invented queue identities; duplicate membership is not extra supervision."""
import unittest
from expand_split_queue import select
from expand_split_queue import resolve_rows
from pathlib import Path
import tempfile


class QueueTests(unittest.TestCase):
    def test_deduplicates_and_reuses_existing_complete_gold(self):
        a=dict(sha256='invented-a',pages=3,mode='ocr',split='train')
        b=dict(sha256='invented-b',pages=5,mode='ocr',split='development')
        all_rows,pending=select([a,b,a],{'invented-a'})
        self.assertEqual(all_rows,[a,b])
        self.assertEqual(pending,[b])
        with self.assertRaises(ValueError): select([a,{**a,'split':'test'}],set())

    def test_relative_manifest_path_is_resolved_from_its_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory); (base/'pages.pdf').write_bytes(b'invented placeholder')
            rows=resolve_rows([dict(sha256='invented',path='pages.pdf')],[base],{})
            self.assertEqual(Path(rows[0]['path']),base/'pages.pdf')


if __name__=='__main__': unittest.main()
