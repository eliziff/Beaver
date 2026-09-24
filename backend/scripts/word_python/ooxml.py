"""Trusted OOXML reading shared by inspect and verification. Never runs model code."""
from __future__ import annotations
import copy
import posixpath
import re
import zipfile
from urllib.parse import unquote, urlsplit

from lxml import etree

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
TAG_NS = 'urn:beaver:word-python'


def w(tag: str) -> str:
    return '{%s}%s' % (W_NS, tag)


MAX_FILE, MAX_PART, MAX_EXPANDED = 100 << 20, 64 << 20, 256 << 20
PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False, remove_blank_text=False)
PROPS = {w(t) for t in ('pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'sectPr', 'tblPrEx', 'sdtPr', 'numPr', 'pBdr', 'tblBorders', 'tcBorders', 'tblCellMar', 'tcMar', 'pgMar', 'pgSz', 'rFonts', 'spacing', 'ind', 'shd')}
RUN_WRAPPERS = {w('ins'), w('del'), w('moveFrom'), w('moveTo')}
CHANGE_TAGS = {w(t) for t in ('rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'tblGridChange', 'tblPrExChange', 'numberingChange')}
VOLATILE_ATTRS = re.compile(r'(?:^|})(?:rsid\w*|paraId|textId)$')
STORY_TYPES = ('/header', '/footer', '/footnotes', '/endnotes')
XMLNS = re.compile(r' xmlns(?::\w+)?="[^"]*"')   # dropped from XML shown to the model


def parse(data: bytes):
    if b'<!DOCTYPE' in data[:4096].upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DTD/entity declarations are forbidden')
    return etree.fromstring(data, PARSER)


def read_package(path) -> dict[str, bytes]:
    """Bounded package screening: refuses active content (macros, embedded objects, DTDs, active fields and links)."""
    import os
    if not 0 < os.path.getsize(path) <= MAX_FILE: raise ValueError('DOCX is empty or exceeds 100 MiB')
    parts: dict[str, bytes] = {}
    with zipfile.ZipFile(path) as archive:
        entries = [e for e in archive.infolist() if not e.is_dir()]
        if len(entries) > 10000 or sum(e.file_size for e in entries) > MAX_EXPANDED: raise ValueError('DOCX expansion limit exceeded')
        for entry in entries:
            name = entry.filename
            if (name in parts or name.startswith('/') or '\\' in name or entry.flag_bits & 1 or
                    any(p in ('', '.', '..') for p in name.split('/')) or entry.file_size > MAX_PART):
                raise ValueError('Unsafe, duplicate or oversized DOCX part: ' + name[:80])
            if any(p in name.lower() for p in ('/embeddings/', '/activex/', 'vbaproject')):
                raise ValueError('Macros and embedded objects are refused')
            parts[name] = archive.read(entry)
    if '[Content_Types].xml' not in parts: raise ValueError('Not an OPC package')
    instructions = []
    for name, data in parts.items():
        if not name.endswith(('.xml', '.rels')): continue
        root = parse(data)
        for node in root.iter(etree.Element):
            local = etree.QName(node).localname
            if local in ('altChunk', 'object', 'oleObject'): raise ValueError('Active document content is refused')
            if local in ('instrText', 'fldSimple'): instructions.append((node.get(w('instr')) or '') + (node.text or ''))
            if local == 'Relationship':
                target = node.get('Target', '')
                if node.get('TargetMode') == 'External':
                    if not node.get('Type', '').endswith('/hyperlink') or not re.match(r'^(https?:|mailto:|#)', target, re.I):
                        raise ValueError('Active external relationships are refused')
                    continue
                base = '' if name == '_rels/.rels' else name.rsplit('_rels/', 1)[0]
                split = urlsplit(unquote(target))
                resolved = posixpath.normpath(split.path[1:] if split.path.startswith('/') else posixpath.join(base, split.path))
                if split.scheme or split.netloc or resolved.startswith('..') or resolved not in parts:
                    raise ValueError('Unsafe or dangling internal relationship: ' + target[:80])
    if re.search(r'DDE|INCLUDETEXT|INCLUDEPICTURE|DATABASE|\bLINK\b', ''.join(instructions).upper()):
        raise ValueError('Active field instructions are refused')
    return parts


def relationships(parts, source: str) -> list[tuple[str, str, str]]:
    folder, base = posixpath.split(source)
    data = parts.get(posixpath.join(folder, '_rels', base + '.rels'))
    if data is None: return []
    out = []
    for rel in parse(data).iter('{%s}Relationship' % REL_NS):
        if rel.get('TargetMode') == 'External': continue
        target = rel.get('Target', '')
        path = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(folder, target))
        out.append((rel.get('Id'), rel.get('Type', ''), path))
    return out


def main_part(parts) -> str:
    for _, kind, path in relationships(parts, ''):
        if kind.endswith('/officeDocument'): return path
    raise ValueError('Not a Word document package')


def stories(parts) -> dict[str, str]:
    """Part name -> kind for the main document and every story it references."""
    main = main_part(parts)
    out = {main: 'document'}
    for _, kind, path in relationships(parts, main):
        for suffix in STORY_TYPES:
            if kind.endswith(suffix): out[path] = suffix[1:]
    return out


def related(parts, kind_suffix: str):
    main = main_part(parts)
    return next((p for _, k, p in relationships(parts, main) if k.endswith(kind_suffix)), None)


# ---- Revision projections -------------------------------------------------

def _unwrap(node):
    parent, index = node.getparent(), node.getparent().index(node)
    for child in reversed(list(node)): parent.insert(index, child)
    parent.remove(node)


def _mark(p, kinds):
    rpr = p.find(w('pPr') + '/' + w('rPr'))
    return None if rpr is None else next((c for c in rpr if c.tag in kinds), None)


def resolve(root, accept: bool):
    """Accept or reject every revision in place."""
    drop, keep = ((w('del'), w('moveFrom')), (w('ins'), w('moveTo'))) if accept else ((w('ins'), w('moveTo')), (w('del'), w('moveFrom')))
    inline = lambda n: n.getparent() is not None and n.getparent().tag not in (w('rPr'), w('trPr'), w('tcPr'))
    for node in [n for n in root.iter(*drop) if inline(n)]:
        if node.getparent() is not None: node.getparent().remove(node)
    for node in [n for n in root.iter(*keep) if inline(n)]:
        for t in node.iter(w('delText')): t.tag = w('t')
        for t in node.iter(w('delInstrText')): t.tag = w('instrText')
        _unwrap(node)
    for change in list(root.iter(*CHANGE_TAGS)):
        holder = change.getparent()
        if accept or change.tag == w('numberingChange'): holder.remove(change); continue
        inner = change[0] if len(change) else None
        kept = ({w('rPr'), w('sectPr')} if change.tag == w('pPrChange') else {w('headerReference'), w('footerReference')}
                if change.tag == w('sectPrChange') else RUN_WRAPPERS if change.tag == w('rPrChange') else set())
        kept = [c for c in holder if c.tag in kept]
        for child in list(holder): holder.remove(child)
        for child in (list(inner) if inner is not None else []) + kept: holder.append(child)
    for p in reversed(list(root.iter(w('p')))):
        mark = _mark(p, drop)
        if mark is not None:   # the paragraph mark goes away: content joins the next paragraph
            content = [c for c in p if c.tag != w('pPr')]
            following = p.getnext()
            if content and following is not None and following.tag == w('p'):
                anchor = 1 if following.find(w('pPr')) is not None else 0
                for offset, child in enumerate(content): following.insert(anchor + offset, child)
                p.getparent().remove(p)
            elif not content: p.getparent().remove(p)
            else: mark.getparent().remove(mark)
        mark = _mark(p, keep)
        if mark is not None: mark.getparent().remove(mark)
    for tr in list(root.iter(w('tr'))):
        trpr = tr.find(w('trPr'))
        if trpr is None: continue
        if any(trpr.find(t) is not None for t in drop): tr.getparent().remove(tr)
        for t in keep:
            if trpr.find(t) is not None: trpr.remove(trpr.find(t))
    for tbl in list(root.iter(w('tbl'))):
        if tbl.find(w('tr')) is None: tbl.getparent().remove(tbl)
    for tag in ('moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd'):
        for node in list(root.iter(w(tag))): node.getparent().remove(node)
    return root


def accepted_text(node) -> str:
    """Visible text after accepting all revisions (deleted text omitted)."""
    out = []
    for n in node.iter(w('t'), w('tab'), w('br'), w('cr'), w('noBreakHyphen'), w('footnoteReference')):
        if any(a.tag in (w('del'), w('moveFrom')) for a in n.iterancestors()): continue
        out.append(n.text or '' if n.tag == w('t') else '\t' if n.tag == w('tab') else '-' if n.tag == w('noBreakHyphen')
                   else '[^' + (n.get(w('id')) or '') + ']' if n.tag == w('footnoteReference') else '\n')
    return ''.join(out)


def revision_counts(root) -> dict[str, int]:
    counts = {}
    for node in root.iter(*RUN_WRAPPERS, *CHANGE_TAGS):
        name = etree.QName(node).localname
        parent = node.getparent()
        if name in ('ins', 'del') and parent is not None and parent.tag == w('rPr'): name += '-paragraph-mark'
        if name in ('ins', 'del') and parent is not None and parent.tag == w('trPr'): name += '-row'
        counts[name] = counts.get(name, 0) + 1
    return counts


# ---- Canonical structure for comparison and change summaries ---------------

def _clean(node):
    node = copy.deepcopy(node)
    for n in node.iter(etree.Element):
        for name in list(n.attrib):
            if VOLATILE_ATTRS.search(name) or name.startswith('{%s}' % TAG_NS): del n.attrib[name]
    return node


def canon(node) -> str:
    if node is None: return ''
    node = _clean(node)
    for n in reversed(list(node.iter(*PROPS))):   # an empty property container equals an absent one
        if not len(n) and not n.attrib:
            if n is node: return ''
            n.getparent().remove(n)
    for n in node.iter(etree.Element):
        if n.tag in PROPS: n[:] = sorted(n, key=lambda c: etree.tostring(c, method='c14n'))
    return etree.tostring(node, method='c14n').decode()


SKIP = {w('proofErr'), w('lastRenderedPageBreak'), w('commentRangeStart'), w('commentRangeEnd'), w('permStart'), w('permEnd')}
TEXTUAL = {w('t'): None, w('tab'): '\t', w('br'): '\n', w('cr'): '\n', w('noBreakHyphen'): '-'}


def _inline(p) -> list:
    items: list = []
    for child in p:
        if child.tag in SKIP or child.tag == w('pPr'): continue
        if child.tag == w('r'):
            body = [c for c in child if c.tag != w('rPr') and c.tag not in SKIP]
            if all(c.tag in TEXTUAL and (c.tag != w('br') or not c.get(w('type'))) for c in body):
                text = ''.join((c.text or '') if TEXTUAL[c.tag] is None else TEXTUAL[c.tag] for c in body)
                if not text: continue
                style = canon(child.find(w('rPr')))
                if items and items[-1][0] == 'r' and items[-1][1] == style: items[-1] = ('r', style, items[-1][2] + text)
                else: items.append(('r', style, text))
            elif not (len(body) == 1 and body[0].tag == w('commentReference')):
                run = _clean(child)
                for n in list(run):
                    if n.tag in SKIP: run.remove(n)
                items.append(('x', canon(run)))
        elif child.tag in (w('hyperlink'), w('smartTag'), w('customXml'), w('fldSimple')):
            items.append(('group', canon(etree.Element(child.tag, dict(child.attrib))), tuple(_inline(child))))
        elif child.tag == w('sdt'):
            content = child.find(w('sdtContent'))
            items.append(('sdt', canon(child.find(w('sdtPr'))), tuple(_inline(content)) if content is not None else ()))
        else: items.append(('x', canon(child)))
    return items


def blocks(container) -> list:
    """Order-preserving canonical blocks: paragraphs, tables, block controls, others."""
    out = []
    for child in container:
        if child.tag == w('p'):
            ppr = child.find(w('pPr'))
            out.append(('p', canon(ppr), tuple(_inline(child)), accepted_text(child)))
        elif child.tag == w('tbl'):
            rows = tuple((canon(tr.find(w('trPr'))), tuple((canon(tc.find(w('tcPr'))), tuple(blocks(tc))) for tc in tr.iter(w('tc'))))
                         for tr in child.findall(w('tr')))
            out.append(('tbl', canon(child.find(w('tblPr'))) + canon(child.find(w('tblGrid'))), rows, table_text(child)))
        elif child.tag == w('sdt'):
            content = child.find(w('sdtContent'))
            out.append(('sdt', canon(child.find(w('sdtPr'))), tuple(blocks(content)) if content is not None else (), ''))
        elif child.tag == w('sectPr'):
            out.append(('sectPr', canon(child), (), ''))
        elif child.tag not in SKIP and child.tag not in (w('bookmarkStart'), w('bookmarkEnd')):
            out.append(('x', canon(child), (), ''))
    return out


def table_text(tbl) -> str:
    return ' | '.join(accepted_text(tc).replace('\n', ' ')[:40] for tc in list(tbl.iter(w('tc')))[:6])


def story_root(root):
    """The block container of a story part: body, hdr/ftr, or the notes root."""
    body = root.find(w('body'))
    return body if body is not None else root


def note_blocks(root) -> dict[str, list]:
    return {n.get(w('id')): blocks(n) for n in root if n.tag in (w('footnote'), w('endnote'))}
