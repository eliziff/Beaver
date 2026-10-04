#!/usr/bin/env python3
"""Write every accepted split-gold footnote into one private DOCX.

The Python split benchmark (Free 324/405) scores footnotes one at a time. To
put the same 405 texts through each app's real document path, this writes them
as footnotes 1..N of a plain DOCX (one body sentence per note) and records
which gold row each footnote number carries. Output stays in the ignored suite
folder because the texts come from private submissions.
"""
from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from suite import SPLIT_GOLD as GOLD, SUITE
NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def run(text: str) -> str:
    return f'<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def main() -> int:
    rows = [json.loads(line) for line in GOLD.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    rows = [row for row in rows if str(row.get("status") or "").lower() not in {"needs_review", "provisional"}]
    body, notes, mapping = [], [], []
    for number, row in enumerate(rows, start=1):
        body.append(
            f'<w:p>{run(f"Benchmark sentence {number}.")}'
            f'<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr>'
            f'<w:footnoteReference w:id="{number}"/></w:r></w:p>'
        )
        notes.append(
            f'<w:footnote w:id="{number}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>'
            f'{run(" " + str(row.get("footnote_text") or ""))}</w:p></w:footnote>'
        )
        mapping.append({"footnote": number, "id": row["id"], "source_doc": row.get("source_doc", ""),
                        "gold_footnote_number": str(row.get("footnote_number") or "")})
    separators = (
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
    )
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
            '</Types>'
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>'
        ),
        "word/_rels/document.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'
            '</Relationships>'
        ),
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{"".join(body)}</w:body></w:document>',
        "word/footnotes.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes {NS}>{separators}{"".join(notes)}</w:footnotes>',
    }
    target = SUITE / "inputs" / "split-gold" / "split-gold-footnotes.docx"
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, xml in parts.items():
            archive.writestr(name, xml)
    (target.parent / "split-gold-map.json").write_text(json.dumps({
        "gold": str(GOLD),
        "gold_sha256": hashlib.sha256(GOLD.read_bytes()).hexdigest(),
        "docx_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "footnotes": mapping,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(rows)} gold footnotes -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
