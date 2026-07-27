from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stage_docx_benchmark_corpus import sha256, stage


CONTENT_TYPES = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>
"""

DOCUMENT_XML = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Visible text</w:t></w:r><w:footnoteReference w:id="2"/></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>
"""

FOOTNOTES_XML = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="2"><w:p><w:ins><w:r><w:t>Citation</w:t></w:r></w:ins></w:p></w:footnote>
</w:footnotes>
"""


def write_docx(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("word/document.xml", DOCUMENT_XML)
        archive.writestr("word/footnotes.xml", FOOTNOTES_XML)


class StageDocxBenchmarkCorpusTests(unittest.TestCase):
    def test_deduplicates_profiles_and_privacy_screens(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            write_docx(source / "article.docx")
            write_docx(source / "article copy.docx")
            write_docx(source / "password vault.docx")
            write_docx(source / "article [Galley].docx")

            output = root / "private_sources"
            manifest_path = root / "private_manifest.json"
            jsonl_path = root / "private_manifest.jsonl"
            manifest = stage(
                inputs=[source],
                output_dir=output,
                manifest_path=manifest_path,
                manifest_jsonl_path=jsonl_path,
                source_root=source,
                allow_sensitive_names=False,
            )

            self.assertEqual(4, manifest["input_file_count"])
            self.assertEqual(1, manifest["unique_document_count"])
            self.assertEqual(1, manifest["duplicate_source_count"])
            self.assertEqual(2, manifest["skipped_count"])

            record = manifest["documents"][0]
            self.assertFalse(record["external_model_allowed"])
            features = record["features"]
            self.assertEqual(1, features["has_footnotes"])
            self.assertEqual(1, features["footnote_references"])
            self.assertEqual(1, features["tracked_insertions"])
            self.assertGreaterEqual(features["paragraphs"], 3)
            self.assertEqual(1, features["tables"])

            rows = [
                json.loads(line)
                for line in jsonl_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual([record], rows)
            copied = Path(record["copy_path"])
            self.assertTrue(copied.is_file())
            self.assertEqual(record["sha256"], sha256(copied))

            sensitive_manifest = stage(
                inputs=[source],
                output_dir=root / "sensitive_sources",
                manifest_path=root / "sensitive_manifest.json",
                manifest_jsonl_path=root / "sensitive_manifest.jsonl",
                source_root=source,
                allow_sensitive_names=True,
            )
            skipped_reasons = {
                item["reason"] for item in sensitive_manifest["skipped"]
            }
            self.assertFalse(
                any(reason.startswith("privacy exclusion") for reason in skipped_reasons)
            )
            self.assertIn(
                "downstream derivative exclusion: galley",
                skipped_reasons,
            )


if __name__ == "__main__":
    unittest.main()
