#!/usr/bin/env python3
"""Conservative DOCX package audit. No engine, network, extraction, or Office runtime.

A passing body-text test is NOT a preservation test. Changed XML is reported for
review, never waived merely because its part was expected to change. This is an
experiment oracle, not a production serializer or a general OOXML validator.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile

MAX_FILE = 100 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_PART = 64 * 1024 * 1024
MAX_ENTRIES = 10_000
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
# These nodes must survive unrelated textual edits even inside a touched part.
REVIEW_NODES = {f"{{{WORD_NS}}}{name}" for name in (
    "ins", "del", "moveFrom", "moveTo", "pPrChange", "rPrChange", "tblPrChange",
    "trPrChange", "tcPrChange", "sectPrChange", "comment", "commentRangeStart",
    "commentRangeEnd", "commentReference", "bookmarkStart", "bookmarkEnd", "dataBinding",
)}


def digest(value: bytes) -> str:
    return sha256(value).hexdigest()


def xml_root(data: bytes) -> ET.Element:
    # Includes UTF-16/32 spellings. Do not process DTDs or entity declarations.
    if re.search(rb"<!\s*(DOCTYPE|ENTITY)\b", data.replace(b"\x00", b""), re.I):
        raise ValueError("DTD/entity declarations are not accepted")
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
    return ET.fromstring(data, parser=parser)


def xml_signature(data: bytes) -> object:
    """Ignore attribute order/element-only indentation, not text/run boundaries.

    Retain namespace declarations too: QName-valued attributes and extension
    markup can depend on bindings unused by element names. Prefix-only changes
    may therefore require review rather than being incorrectly called harmless.
    """
    root = xml_root(data)
    namespaces = []
    started = False
    for event, value in ET.iterparse(io.BytesIO(data), events=("start-ns", "start")):
        if event == "start":
            started = True
        elif started:
            # Do not erase locally scoped QName bindings while normalizing XML.
            return ("scoped_namespaces", digest(data))
        else:
            namespaces.append(value)
    namespaces.sort()

    def node(value: ET.Element, inherited: bool = False) -> object:
        preserve = value.attrib.get(XML_SPACE, "preserve" if inherited else "default") == "preserve"
        tag = value.tag if isinstance(value.tag, str) else value.tag.__name__
        text = value.text or ""
        if len(value) and not preserve and not text.strip():
            text = ""
        children = []
        for child in value:
            tail = child.tail or ""
            children.append((node(child, preserve), tail if preserve or tail.strip() else ""))
        return (tag, sorted(value.attrib.items()), text, children)

    return (namespaces, node(root))


def review_nodes(data: bytes) -> Counter:
    result: Counter = Counter()
    for node in xml_root(data).iter():
        if node.tag in REVIEW_NODES:
            # Strip indentation after the protected node, not its content.
            node.tail = None
            signature = xml_signature(ET.tostring(node, encoding="utf-8"))
            result[json.dumps(signature, ensure_ascii=False, sort_keys=True)] += 1
    return result


def package(path: Path) -> tuple[dict[str, bytes], str]:
    with path.open("rb") as source:
        raw = source.read(MAX_FILE + 1)
    if not 0 < len(raw) <= MAX_FILE:
        raise ValueError("package is empty or exceeds the input limit")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise ValueError("package exceeds expanded limits")
        names: set[str] = set()
        output: dict[str, bytes] = {}
        for entry in infos:
            name = entry.filename
            parts = PurePosixPath(name)
            if (name in names or "\\" in name or parts.is_absolute()
                    or any(p in ("", ".", "..") for p in name.rstrip("/").split("/"))):
                raise ValueError("duplicate or unsafe package part")
            names.add(name)
            if entry.flag_bits & 1 or entry.file_size > MAX_PART:
                raise ValueError("encrypted or oversized package part")
            if not entry.is_dir():
                output[name] = archive.read(entry)  # ZIP CRC is checked by zipfile.
    for required in ("[Content_Types].xml", "_rels/.rels", "word/document.xml"):
        if required not in output:
            raise ValueError(f"missing required part: {required}")
    for name, data in output.items():
        if name.endswith((".xml", ".rels")):
            xml_root(data)
    return output, digest(raw)


def relationship_errors(parts: dict[str, bytes]) -> list[str]:
    errors = []
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        root = xml_root(data)
        if root.tag != f"{{{REL_NS}}}Relationships":
            errors.append(f"invalid relationship root: {name}")
            continue
        if name == "_rels/.rels":
            folder = ""
        else:
            relpath = PurePosixPath(name)
            if relpath.parent.name != "_rels":
                errors.append(f"invalid relationship location: {name}")
                continue
            owner = str(relpath.parent.parent / relpath.name[:-5])
            if owner not in parts:
                errors.append(f"missing relationship owner: {name}")
            folder = str(PurePosixPath(owner).parent)
        seen = set()
        for rel in root:
            if rel.tag != f"{{{REL_NS}}}Relationship":
                continue
            rid, target = rel.get("Id"), rel.get("Target")
            if not rid or rid in seen or not target or not rel.get("Type"):
                errors.append(f"invalid or duplicate relationship: {name}")
                continue
            seen.add(rid)
            if rel.get("TargetMode") == "External":
                continue  # Inspect only; never fetch external relationships.
            if rel.get("TargetMode") not in (None, "Internal"):
                errors.append(f"invalid relationship mode: {name}:{rid}")
                continue
            uri = urlsplit(target)
            decoded = unquote(uri.path)
            resolved = posixpath.normpath(decoded.lstrip("/") if decoded.startswith("/")
                                          else posixpath.join(folder, decoded))
            if uri.scheme or uri.netloc or "\\" in decoded or resolved.startswith("../") or resolved not in parts:
                errors.append(f"dangling/unsafe relationship: {name}:{rid}")
    types = xml_root(parts["[Content_Types].xml"])
    if types.tag != f"{{{CT_NS}}}Types":
        errors.append("invalid content-types root")
    for item in types:
        if item.tag == f"{{{CT_NS}}}Override" and unquote(item.get("PartName", "")).lstrip("/") not in parts:
            errors.append("content-type override names a missing part")
    return sorted(set(errors))


def audit(before: Path, after: Path, allowed_xml: tuple[str, ...] = ()) -> dict:
    """Compare real files; no receipt can override a missing or damaged artifact."""
    (left, before_hash), (right, after_hash) = package(before), package(after)
    errors = [f"invalid input: {e}" for e in relationship_errors(left)] + relationship_errors(right)
    changes = []
    for name in sorted(left.keys() | right.keys()):
        a, b = left.get(name), right.get(name)
        if a == b:
            continue
        if a is None or b is None:
            disposition = "added" if a is None else "removed"
            errors.append(f"part {disposition}: {name}")
        elif name.endswith((".xml", ".rels")):
            known = name == "[Content_Types].xml" or name.endswith(".rels") or bool(re.fullmatch(
                r"word/(document|styles|numbering|settings|fontTable|webSettings|footnotes|endnotes|comments|header\d*|footer\d*)\.xml", name))
            if known and xml_signature(a) == xml_signature(b):
                continue
            disposition = "review_required" if name in allowed_xml else "unexpected_xml_change"
            if disposition != "review_required":
                errors.append(f"unexpected XML change: {name}")
            if name.startswith("word/") and (review_nodes(a) - review_nodes(b)):
                errors.append(f"pre-existing review/anchor/binding content changed: {name}")
        else:
            disposition = "opaque_changed"
            errors.append(f"opaque part changed: {name}")
        changes.append({"part": name, "disposition": disposition,
                        "beforeSha256": digest(a) if a is not None else None,
                        "afterSha256": digest(b) if b is not None else None})
    return {"status": "failed" if errors else "review_required" if changes else "passed",
            "beforeSha256": before_hash, "afterSha256": after_hash,
            "failures": errors, "changes": changes}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--allow-xml", action="append", default=[],
                        help="A changed part requires review; it is not automatically permitted.")
    args = parser.parse_args()
    try:
        result = audit(args.before, args.after, tuple(args.allow_xml))
    except (OSError, ValueError, ET.ParseError, zipfile.BadZipFile, RuntimeError) as error:
        result = {"status": "failed", "failures": [str(error)], "changes": []}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return {"passed": 0, "failed": 1, "review_required": 2}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
