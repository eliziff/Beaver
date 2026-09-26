"""Outcome tests for the admission oracle, NOT evidence of SuperDoc fidelity."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import warnings
import xml.etree.ElementTree as ET
import zipfile

from audit import audit, package

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
C = "http://schemas.openxmlformats.org/package/2006/content-types"
BODY = (f'<w:document xmlns:w="{W}"><w:body><w:p>'
        '<w:bookmarkStart w:id="2" w:name="clause"/>'
        '<w:r><w:rPr><w:b/></w:rPr><w:t>Ordinary text.</w:t></w:r>'
        '<w:ins w:id="7" w:author="Counsel"><w:r><w:t>Human insertion.</w:t></w:r></w:ins>'
        '<w:bookmarkEnd w:id="2"/></w:p><w:sectPr/></w:body></w:document>')


def parts():
    return {
        "[Content_Types].xml": f'<Types xmlns="{C}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": f'<Relationships xmlns="{R}"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": BODY,
        "word/_rels/document.xml.rels": f'<Relationships xmlns="{R}"><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
        "word/header1.xml": f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>Protected header.</w:t></w:r></w:p></w:hdr>',
        "customXml/item1.xml": '<record xmlns="urn:beaver:fixture"><value>Exact binding data</value></record>',
        "word/media/opaque.bin": b"\x00\xff\x13do not change\x00",
    }


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.before = self.write("before.docx", parts())

    def write(self, name, entries):
        path = self.root / name
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for key, value in entries.items():
                archive.writestr(key, value)
        return path

    def test_noop_ignores_zip_metadata_attribute_order_and_element_indentation(self):
        changed = parts()
        changed["word/document.xml"] = BODY.replace('w:id="2" w:name="clause"', 'w:name="clause" w:id="2"').replace("<w:body>", "<w:body>\n  ")
        self.assertEqual(audit(self.before, self.write("after.docx", changed))["status"], "passed")

    def test_allowed_body_edit_needs_review_not_automatic_admission(self):
        changed = parts()
        changed["word/document.xml"] = BODY.replace("Ordinary text.", "Revised text.")
        report = audit(self.before, self.write("after.docx", changed), ("word/document.xml",))
        self.assertEqual(report["status"], "review_required")
        self.assertNotEqual(report["beforeSha256"], report["afterSha256"])
        self.assertEqual(report["failures"], [])

    def test_unrelated_damage_fails_even_inside_allowed_part(self):
        mutations = [
            ("word/header1.xml", lambda value: value.replace("Protected", "Changed")),
            ("customXml/item1.xml", lambda value: value.replace("Exact", "Wrong")),
            ("word/media/opaque.bin", lambda value: value + b"x"),
            ("word/document.xml", lambda value: value.replace('w:author="Counsel"', 'w:author="Agent"')),
            ("word/document.xml", lambda value: value.replace('<w:bookmarkStart w:id="2" w:name="clause"/>', "")),
            ("word/document.xml", lambda value: value.replace('<w:ins w:id="7" w:author="Counsel">', "").replace("</w:ins>", "")),
        ]
        for index, (name, modify) in enumerate(mutations):
            with self.subTest(part=name, index=index):
                changed = parts()
                changed[name] = modify(changed[name])
                self.assertEqual(audit(self.before, self.write(f"after-{index}.docx", changed), ("word/document.xml",))["status"], "failed")

    def test_noop_detects_run_formatting_changes(self):
        changed = parts()
        changed["word/document.xml"] = BODY.replace("<w:b/>", "<w:i/>")
        self.assertEqual(audit(self.before, self.write("after.docx", changed))["status"], "failed")

    def test_text_whitespace_is_not_normalized(self):
        changed = parts()
        changed["word/document.xml"] = BODY.replace("Ordinary text.", "Ordinary  text.")
        self.assertEqual(audit(self.before, self.write("after.docx", changed))["status"], "failed")

    def test_namespace_rebinding_in_extension_values_is_not_ignored(self):
        changed = parts()
        changed["word/document.xml"] = BODY.replace('<w:body>', '<w:body xmlns:x="urn:one" feature="x:flag">')
        first = self.write("ns-before.docx", changed)
        changed["word/document.xml"] = changed["word/document.xml"].replace("urn:one", "urn:two")
        self.assertEqual(audit(first, self.write("ns-after.docx", changed))["status"], "failed")

    def test_unknown_xml_payload_is_preserved_exactly(self):
        changed = parts()
        changed["customXml/item1.xml"] = changed["customXml/item1.xml"].replace("<value>", "\n  <value>")
        self.assertEqual(audit(self.before, self.write("after.docx", changed))["status"], "failed")

    def test_missing_parts_duplicate_relationships_and_dangling_targets(self):
        for index in range(3):
            changed = parts()
            if index == 0:
                del changed["word/header1.xml"]
            elif index == 1:
                changed["word/_rels/document.xml.rels"] = changed["word/_rels/document.xml.rels"].replace("</Relationships>", '<Relationship Id="r2" Type="x" Target="header1.xml"/></Relationships>')
            else:
                changed["word/_rels/document.xml.rels"] = changed["word/_rels/document.xml.rels"].replace('Target="header1.xml"', 'Target="absent.xml"')
            with self.subTest(index=index):
                self.assertEqual(audit(self.before, self.write(f"after-{index}.docx", changed))["status"], "failed")

    def test_external_relationships_are_inspected_without_fetching(self):
        changed = parts()
        changed["word/_rels/document.xml.rels"] = f'<Relationships xmlns="{R}"><Relationship Id="r2" Type="hyperlink" Target="https://invalid.example/secret" TargetMode="External"/></Relationships>'
        original = self.write("external.docx", changed)
        self.assertEqual(audit(original, original)["status"], "passed")

    def test_xml_entities_truncation_duplicate_and_traversal_parts_fail(self):
        for payload in [b"<!DOCTYPE x [<!ENTITY a 'x'>]><x>&a;</x>", "<!DOCTYPE x><x/>".encode("utf-16"), b"<unclosed>"]:
            changed = parts()
            changed["word/document.xml"] = payload
            with self.subTest(payload=payload), self.assertRaises((ValueError, ET.ParseError)):
                package(self.write("bad.docx", changed))
        for name in ["../escape.xml", "word\\document.xml", "word/document.xml"]:
            value = self.write("unsafe.docx", parts())
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with zipfile.ZipFile(value, "a") as archive:
                    archive.writestr(name, "<x/>")
            with self.subTest(name=name), self.assertRaises(ValueError):
                package(value)
        broken = self.root / "truncated.docx"
        broken.write_bytes(self.before.read_bytes()[:30])
        with self.assertRaises(zipfile.BadZipFile):
            package(broken)

    def test_cli_reports_failure_as_json_and_nonzero(self):
        bad = self.root / "bad.docx"
        bad.write_bytes(b"not a package")
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("audit.py")), str(self.before), str(bad)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["status"], "failed")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
