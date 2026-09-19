"""Real LibreOffice tests; never skipped or imported by the ordinary Vitest suite."""
from hashlib import sha256
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

WORKER = Path(__file__).resolve().parents[2] / 'scripts' / 'word_uno.py'
spec = importlib.util.spec_from_file_location('word_uno', WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'


def fixture(path):
    body = '''<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>UNO compound document</w:t></w:r></w:p>
<w:p><w:r><w:t>Opening paragraph stays unchanged.</w:t></w:r></w:p>
<w:p><w:r><w:t>Unicode 🦫 anchor and a source note.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>
<w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Fee</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t xml:space="preserve">Editorial history: </w:t></w:r><w:ins w:id="9" w:author="Counsel" w:date="2026-01-01T00:00:00Z"><w:r><w:t>retained insertion</w:t></w:r></w:ins><w:del w:id="10" w:author="Counsel" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>retained deletion</w:delText></w:r></w:del></w:p>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Commented passage stays.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:pPr></w:p>
<w:p><w:r><w:t>Second section stays.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'''
    parts = {
        'word/document.xml': f'<w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>{body}</w:body></w:document>',
        'word/styles.xml': f'<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style></w:styles>',
        'word/footnotes.xml': f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>Authority at paragraph 12.</w:t></w:r></w:p></w:footnote></w:footnotes>',
        'word/header1.xml': f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>UNCHANGED HEADER</w:t></w:r></w:p></w:hdr>',
        'word/footer1.xml': f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>',
        'word/comments.xml': f'<w:comments xmlns:w="{W}"><w:comment w:id="0" w:author="Counsel" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>Do not remove my note.</w:t></w:r></w:p></w:comment></w:comments>',
        '_rels/.rels': f'<Relationships xmlns="{R}"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': f'<Relationships xmlns="{R}">' + ''.join(
            f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>'
            for rid, kind, target in [('rStyle', 'styles', 'styles.xml'), ('rNote', 'footnotes', 'footnotes.xml'),
                                       ('rHeader', 'header', 'header1.xml'), ('rFooter', 'footer', 'footer1.xml'), ('rComment', 'comments', 'comments.xml')]) + '</Relationships>',
    }
    parts['[Content_Types].xml'] = f'<Types xmlns="{C}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ''.join(
        f'<Override PartName="/word/{file}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>'
        for file, kind in [('document.xml', 'document.main'), ('styles.xml', 'styles'),
                           ('footnotes.xml', 'footnotes'), ('header1.xml', 'header'), ('footer1.xml', 'footer'), ('comments.xml', 'comments')]) + '</Types>'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, '<?xml version="1.0" encoding="UTF-8"?>' + text)


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = shutil.which('soffice')
        if not cls.binary:
            raise RuntimeError('Install LibreOffice Writer; this integration suite never skips')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source.docx'
        self.output = Path(self.temp.name) / 'candidate.docx'
        fixture(self.source)
        self.original = self.source.read_bytes()
        self.snapshot = sha256(self.original).hexdigest()

    def run_edit(self, operations, **extra):
        return worker.run(self.source, self.output,
                          dict(action='preview', snapshot=self.snapshot, operations=operations, **extra), self.binary)

    def test_compound_edit_and_native_reopen(self):
        result = self.run_edit([
            {'target': 'footnote:0', 'replace': {'find': 'paragraph 12', 'text': 'paragraph 15'}},
            {'target': 'table:Table1', 'set': {'RepeatHeadline': True}},
            {'target': 'page-style:Standard', 'set': {'LeftMargin': 1905}},
        ])
        self.assertTrue(result['reopened'])
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(worker.package(self.source)[1], worker.package(self.output)[1])
        with zipfile.ZipFile(self.output) as z:
            xml = ET.fromstring(z.read('word/document.xml'))
            self.assertIsNotNone(xml.find('.//{' + W + '}tblHeader'))
            self.assertIn(b'paragraph 15', z.read('word/footnotes.xml'))
            self.assertEqual(len(xml.findall('.//{' + W + '}sectPr')), 2)
            self.assertIn(b'Do not remove my note.', z.read('word/comments.xml'))

    def test_no_change_control_preserves_text_and_review(self):
        result = self.run_edit([{'target': 'table:Table1', 'set': {'RepeatHeadline': False}}])
        self.assertTrue(result['reopened'])
        self.assertEqual(worker.package(self.source)[1], worker.package(self.output)[1])

    def test_inspection_properties_and_pagination(self):
        result = worker.run(self.source, None, {'action': 'inspect', 'family': 'paragraph', 'limit': 2}, self.binary)
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(result['next_offset'], 2)
        result = worker.run(self.source, None, {'action': 'describe', 'target': 'table:Table1', 'filter': 'RepeatHeadline'}, self.binary)
        self.assertEqual(result['items'][0]['name'], 'RepeatHeadline')
        self.assertTrue(result['items'][0]['writable'])
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_unicode_anchor(self):
        result = self.run_edit([{'target': 'paragraph:2', 'replace': {'find': 'anchor', 'text': 'exact selection'}}])
        self.assertTrue(result['reopened'])
        with zipfile.ZipFile(self.output) as z:
            self.assertIn('🦫 exact selection', z.read('word/document.xml').decode())

    def test_failed_batch_leaves_no_candidate(self):
        with self.assertRaisesRegex(ValueError, 'missing or ambiguous'):
            self.run_edit([{'target': 'footnote:0', 'replace': {'find': 'paragraph 12', 'text': 'paragraph 15'}},
                           {'target': 'paragraph:0', 'replace': {'find': 'not in source', 'text': 'x'}}])
        self.assertFalse(self.output.exists())
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_stale_snapshot_and_existing_output_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'Stale snapshot'):
            worker.run(self.source, self.output, {'action': 'preview', 'snapshot': '0' * 64}, self.binary)
        self.output.write_bytes(b'owned by another operation')
        with self.assertRaisesRegex(ValueError, 'new candidate path'):
            self.run_edit([])
        self.assertEqual(self.output.read_bytes(), b'owned by another operation')

    def test_unsafe_properties_and_active_packages_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'writable policy'):
            self.run_edit([{'target': 'paragraph:0', 'set': {'HyperLinkURL': 'file:///etc/passwd'}}])
        self.assertFalse(self.output.exists())
        with zipfile.ZipFile(self.source, 'a') as z:
            z.writestr('word/vbaProject.bin', b'never execute')
        with self.assertRaisesRegex(ValueError, 'Macros and embedded'):
            worker.package(self.source)


if __name__ == '__main__':
    unittest.main()
