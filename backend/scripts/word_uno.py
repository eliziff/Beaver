#!/usr/bin/env python3
"""Bounded Writer property batches. No eval, arbitrary UNO calls, or network listener.

Only document-local targets and allowlisted property families are writable. This is
not a sandbox for Python scripts: hostile input still needs OS process isolation.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
from hashlib import sha256
import json
import os
import posixpath
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile

import uno

MAX_FILE = 100 * 1024 * 1024
MAX_XML = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
FAMILIES = ('paragraph', 'table', 'footnote', 'endnote', 'frame',
            'page-style', 'paragraph-style', 'character-style')
STYLE_FAMILIES = {'page-style': 'PageStyles', 'paragraph-style': 'ParagraphStyles',
                  'character-style': 'CharacterStyles'}
# An explicit policy, not a mirror of UNO. In particular URLs, events, links,
# interop grab-bags, interface/any values and external resources are not writable.
PROPERTY_NAMES = {
    'table': {'BackColor', 'BackTransparent', 'Width', 'RelativeWidth',
              'IsWidthRelative', 'LeftMargin', 'RightMargin', 'TopMargin',
              'BottomMargin', 'HoriOrient', 'RepeatHeadline', 'HeaderRowCount',
              'Split', 'KeepTogether', 'TableColumnSeparators'},
    'cell': {'BackColor', 'BackTransparent', 'VertOrient', 'NumberFormat'},
    'page-style': {'Width', 'Height', 'IsLandscape', 'LeftMargin', 'RightMargin',
                   'TopMargin', 'BottomMargin', 'HeaderIsOn', 'FooterIsOn',
                   'HeaderHeight', 'FooterHeight', 'HeaderBodyDistance',
                   'FooterBodyDistance', 'FirstPageNumber'},
}
TEXT_PROPERTIES = re.compile(r'^(Char(?:Weight|Posture|Height|FontName|Color|BackColor|'
    r'Underline|UnderlineColor|UnderlineHasColor|Strikeout|CaseMap|Escapement|'
    r'EscapementHeight|Kerning|AutoKerning|Locale)|Para(?:Adjust|LeftMargin|RightMargin|'
    r'FirstLineIndent|TopMargin|BottomMargin|KeepTogether|Split|Widows|Orphans|'
    r'LineSpacing|TabStops|StyleName|BackColor)|BreakType)$')
STRUCTS = {'com.sun.star.style.LineSpacing', 'com.sun.star.style.TabStop',
           'com.sun.star.text.TableColumnSeparator', 'com.sun.star.lang.Locale'}


def props(**values):
    result = []
    for key, value in values.items():
        item = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
        item.Name, item.Value = key, value
        result.append(item)
    return tuple(result)


def package(path):
    """Bounded active-content screening and preservation witnesses, not a schema validator."""
    if not 0 < path.stat().st_size <= MAX_FILE:
        raise ValueError('DOCX is empty or exceeds 100 MiB')
    hashes, protected, internal, paragraphs = {}, Counter(), [], Counter()
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len(entries) > 10000 or sum(e.file_size for e in entries) > MAX_EXPANDED:
            raise ValueError('DOCX expansion limit exceeded')
        for entry in entries:
            name = entry.filename
            if (name in hashes or name.startswith('/') or '\\' in name or
                    any(p in ('', '.', '..') for p in name.split('/')) or entry.flag_bits & 1):
                raise ValueError('Unsafe or duplicate DOCX part')
            if entry.file_size > MAX_XML:
                raise ValueError('DOCX part exceeds limit')
            lower = name.lower()
            if any(p in lower for p in ('/embeddings/', '/activex/', 'vbaproject')):
                raise ValueError('Macros and embedded objects are not supported by this worker')
            data = archive.read(entry)
            if name.endswith(('.xml', '.rels')):
                folded = data.replace(b'\0', b'').upper()
                if b'<!DOCTYPE' in folded or b'<!ENTITY' in folded:
                    raise ValueError('DTD/entity declarations are forbidden')
            hashes[name] = sha256(data).hexdigest()
            if (not name.endswith(('.xml', '.rels')) and
                    not name.startswith('docProps/thumbnail.')):
                protected[('opaque', name, hashes[name])] += 1
            if name.startswith('customXml/'):
                # Ignore only the declaration and outer whitespace. Do not
                # normalize unknown element content, prefixes or QName values.
                clean = re.sub(rb'^\s*<\?xml[^?]*\?>', b'', data).strip()
                if name.endswith('.rels'):
                    clean = ET.canonicalize(clean, strip_text=True).encode()
                protected[('custom-xml', name, sha256(clean).hexdigest())] += 1
            if not name.endswith(('.xml', '.rels')):
                continue
            root = ET.fromstring(data)
            kind = 'header' if root.tag == W + 'hdr' else 'footer' if root.tag == W + 'ftr' else 'flow'
            def pagination(code):
                normalized = code.strip().upper()
                return normalized if normalized in ('PAGE', 'NUMPAGES', 'SECTIONPAGES') else None
            def page_field(code):
                key = ('pagination-field', kind, code)
                if kind == 'flow':
                    protected[key] += 1
                else:
                    protected[key] = 1  # Identical inherited header/footer copies.
            def paragraph_text(node, fields):
                if node.tag in (W + 'del', W + 'moveFrom'):
                    return ''
                if node.tag == W + 'fldSimple' and pagination(node.get(W + 'instr', '')):
                    page_field(pagination(node.get(W + 'instr', '')))
                    return ''
                if node.tag == W + 'fldChar':
                    event = node.get(W + 'fldCharType')
                    if event == 'begin':
                        fields.append({'code': '', 'result': False})
                    elif fields and event == 'separate':
                        fields[-1]['result'] = True
                        if pagination(fields[-1]['code']):
                            page_field(pagination(fields[-1]['code']))
                    elif fields and event == 'end':
                        fields.pop()
                    return ''
                if node.tag == W + 'instrText' and fields:
                    fields[-1]['code'] += node.text or ''
                    return ''
                if node.tag == W + 't':
                    # Pagination caches are layout output, not authored prose.
                    return '' if any(f['result'] and pagination(f['code']) for f in fields) else node.text or ''
                if node.tag == W + 'tab':
                    return '\t'
                if node.tag in (W + 'br', W + 'cr'):
                    return '\n'
                return ''.join(paragraph_text(child, fields) for child in node if child.tag != W + 'p')
            for paragraph in root.iter(W + 'p'):
                text = paragraph_text(paragraph, [])
                if text:
                    if kind == 'flow':
                        paragraphs[(kind, text)] += 1
                    else:
                        paragraphs[(kind, text)] = 1  # Export may duplicate identical inherited header parts.
            instructions = []
            for node in root.iter():
                local = node.tag.rsplit('}', 1)[-1]
                if local in ('altChunk', 'object', 'oleObject'):
                    raise ValueError('Active document content is forbidden')
                if local == 'Relationship' and node.get('TargetMode') != 'External':
                    parent = '' if name == '_rels/.rels' else name.rsplit('/_rels/', 1)[0]
                    target = urlsplit(unquote(node.get('Target', '')))
                    resolved = posixpath.normpath(posixpath.join(parent, target.path))
                    if target.scheme or target.netloc or target.query or resolved.startswith(('../', '/')) or resolved == '..' or '\\' in resolved:
                        raise ValueError('Unsafe internal relationship')
                    if target.path:
                        internal.append(resolved)
                if local == 'Relationship' and node.get('TargetMode') == 'External':
                    if (not node.get('Type', '').endswith('/hyperlink') or
                            not re.match(r'^(https?:|mailto:)', node.get('Target', ''), re.I)):
                        raise ValueError('Active external relationships are forbidden')
                if local in ('instrText', 'fldSimple'):
                    instructions.append(node.get(W + 'instr', '') + (node.text or ''))
                if node.tag in {W + t for t in ('ins', 'del', 'moveFrom', 'moveTo', 'comment')}:
                    text = ''.join(n.text or '' for n in node.iter()
                                   if n.tag in (W + 't', W + 'delText', W + 'instrText'))
                    protected[(local, node.get(W + 'author', ''), text)] += 1
                if node.tag == W + 'dataBinding':
                    protected[('binding', tuple(sorted(node.attrib.items())))] += 1
            if re.search(r'DDE|INCLUDETEXT|INCLUDEPICTURE|DATABASE|\bLINK\b',
                         ''.join(instructions).upper()):
                raise ValueError('Active field instructions are forbidden')
    if any(target not in hashes for target in internal):
        raise ValueError('Dangling internal relationship')
    if 'word/document.xml' not in hashes or '[Content_Types].xml' not in hashes:
        raise ValueError('Not a Word document package')
    return hashes, protected, paragraphs


@contextmanager
def writer(binary):
    """Own exactly one private profile/process; never attach to the user's office."""
    with tempfile.TemporaryDirectory(prefix='beaver-uno-') as directory:
        pipe = 'beaver_' + os.urandom(16).hex()
        own_group = os.name != 'nt' and os.environ.get('BEAVER_UNO_OWNED_GROUP') != '1'
        process = subprocess.Popen([
            binary, '-env:UserInstallation=' + Path(directory, 'profile').as_uri(),
            '--headless', '--norestore', '--nodefault', '--nofirststartwizard',
            '--accept=pipe,name=' + pipe + ';urp;StarOffice.ComponentContext'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=own_group)
        desktop = None
        try:
            context = uno.getComponentContext()
            resolver = context.ServiceManager.createInstanceWithContext(
                'com.sun.star.bridge.UnoUrlResolver', context)
            deadline = time.monotonic() + 20
            while True:
                try:
                    remote = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
                    break
                except Exception:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('Private LibreOffice instance did not become ready')
                    time.sleep(0.05)
            desktop = remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
            provider = remote.ServiceManager.createInstanceWithContext(
                'com.sun.star.configuration.ConfigurationProvider', remote)
            product = provider.createInstanceWithArguments(
                'com.sun.star.configuration.ConfigurationAccess', props(nodepath='/org.openoffice.Setup/Product'))
            yield desktop, product.getByName('ooSetupVersionAboutBox')
        finally:
            if desktop is not None:
                try:
                    desktop.terminate()
                except Exception:
                    pass
            if process.poll() is None:
                if not own_group:
                    process.terminate()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if not own_group:
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def load(desktop, path):
    doc = desktop.loadComponentFromURL(path.resolve().as_uri(), '_blank', 0, props(
        Hidden=True, ReadOnly=False, MacroExecutionMode=4, UpdateDocMode=0))
    if doc is None or not doc.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('LibreOffice did not load a Writer document')
    doc.RecordChanges = False  # Direct candidate edits, never advertised as tracked.
    return doc


def collection(doc, family):
    if family in STYLE_FAMILIES:
        values = doc.StyleFamilies.getByName(STYLE_FAMILIES[family])
        return [(name, values.getByName(name)) for name in values.ElementNames]
    if family in ('table', 'frame'):
        values = doc.TextTables if family == 'table' else doc.TextFrames
        return [(name, values.getByName(name)) for name in values.ElementNames]
    if family in ('footnote', 'endnote'):
        values = doc.Footnotes if family == 'footnote' else doc.Endnotes
        return [(str(i), values.getByIndex(i)) for i in range(values.Count)]
    if family == 'paragraph':
        cursor, result = doc.Text.createEnumeration(), []
        while cursor.hasMoreElements():
            node = cursor.nextElement()
            if node.supportsService('com.sun.star.text.Paragraph'):
                result.append((str(len(result)), node))
        return result
    raise ValueError('Unknown target family')


def resolve(doc, target):
    family, sep, name = target.partition(':')
    if not sep:
        raise ValueError('Use a target returned by inspect')
    if family == 'cell':
        table, _, cell = name.partition('/')
        return doc.TextTables.getByName(unquote(table)).getCellByName(unquote(cell))
    if family in ('header', 'footer'):
        page = doc.StyleFamilies.getByName('PageStyles').getByName(unquote(name))
        return page.getPropertyValue('HeaderText' if family == 'header' else 'FooterText')
    for key, node in collection(doc, family):
        if key == unquote(name):
            return node
    raise ValueError('Target does not exist in this snapshot')


def encode(value, depth=0):
    if depth > 4:
        return {'type': 'unexpanded'}
    if value is None or isinstance(value, (str, bool, int, float)):
        return value[:2000] if isinstance(value, str) else value
    if isinstance(value, uno.Enum):
        return {'enum': value.typeName, 'value': value.value}
    if isinstance(value, (tuple, list)):
        return [encode(v, depth + 1) for v in value[:100]]
    name = getattr(value, 'typeName', None)
    if name in STRUCTS:
        return {'struct': name, 'fields': {k: encode(getattr(value, k), depth + 1)
                for k in dir(value) if not k.startswith('_') and k != 'typeName'}}
    return {'type': name or 'interface', 'expanded': False}


def decode(value):
    if isinstance(value, str) and len(value) > 2000:
        raise ValueError('Property string exceeds 2000 characters')
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, list) and len(value) <= 100:
        return tuple(decode(v) for v in value)
    if isinstance(value, dict) and set(value) == {'enum', 'value'}:
        if value['enum'] not in ('com.sun.star.style.BreakType', 'com.sun.star.awt.FontSlant'):
            raise ValueError('Enum type is not writable')
        return uno.Enum(value['enum'], value['value'])
    if isinstance(value, dict) and set(value) == {'struct', 'fields'} and value['struct'] in STRUCTS:
        result = uno.createUnoStruct(value['struct'])
        for key, item in value['fields'].items():
            if key.startswith('_') or not hasattr(result, key):
                raise ValueError('Unknown struct field')
            setattr(result, key, decode(item))
        return result
    raise ValueError('Use scalar values or supported UNO enum/struct values')


def writable(target, name):
    family = target.split(':', 1)[0]
    return name in PROPERTY_NAMES.get(family, set()) or (
        family in ('paragraph', 'paragraph-style', 'character-style', 'cell', 'footnote', 'endnote',
                   'header', 'footer', 'frame') and TEXT_PROPERTIES.fullmatch(name) is not None)


def property_object(node, name):
    # Notes/header text expose paragraph/run formatting through their full text cursor.
    if hasattr(node, 'getPropertySetInfo') and node.getPropertySetInfo().hasPropertyByName(name):
        return node
    cursor = node.createTextCursor()
    cursor.gotoStart(False)
    cursor.gotoEnd(True)
    return cursor


def bounded(request, key, default, maximum):
    value = request.get(key, default)
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError(key + ' is outside the supported range')
    return value


def inspect(doc, request):
    offset = bounded(request, 'offset', 0, 100000)
    limit = bounded(request, 'limit', 20, 100)
    if not limit:
        raise ValueError('limit must be positive')
    target = request.get('target')
    if target:
        node = resolve(doc, target)
        if request.get('action') == 'describe':
            info = node.getPropertySetInfo() if hasattr(node, 'getPropertySetInfo') else node.createTextCursor().getPropertySetInfo()
            selected = [p for p in info.Properties if request.get('filter', '').lower() in p.Name.lower()]
            rows = []
            for prop in selected[offset:offset + limit]:
                row = {'name': prop.Name, 'type': prop.Type.typeName,
                       'writable': writable(target, prop.Name) and not prop.Attributes & 16}
                try:
                    row['value'] = encode(property_object(node, prop.Name).getPropertyValue(prop.Name))
                except Exception:
                    row['unavailable'] = True
                rows.append(row)
            return {'target': target, 'items': rows, 'total': len(selected),
                    'next_offset': offset + len(rows) if offset + len(rows) < len(selected) else None}
        text = getattr(node, 'String', '')
        result = {'target': target, 'text': text[offset:offset + limit * 100], 'total_chars': len(text)}
        result['next_offset'] = offset + len(result['text']) if offset + len(result['text']) < len(text) else None
        if target.startswith('table:'):
            cells = node.getCellNames()
            result.update(cells=[{'target': 'cell:' + target.split(':', 1)[1] + '/' + quote(c, safe=''),
                                  'text': node.getCellByName(c).String[:200]} for c in cells[offset:offset + limit]],
                          total_cells=len(cells), next_offset=offset + limit if offset + limit < len(cells) else None)
        return result
    family = request.get('family', 'paragraph')
    selected = collection(doc, family)
    rows = [{'target': family + ':' + quote(key, safe=''), 'text': getattr(node, 'String', '')[:300]}
            for key, node in selected[offset:offset + limit]]
    return {'family': family, 'items': rows, 'total': len(selected),
            'next_offset': offset + len(rows) if offset + len(rows) < len(selected) else None}


def texts(doc):
    values = {}
    for family in ('paragraph', 'table', 'footnote', 'endnote', 'frame'):
        for key, node in collection(doc, family):
            target = family + ':' + quote(key, safe='')
            if family == 'table':
                for cell in node.getCellNames():
                    values['cell:' + quote(key, safe='') + '/' + cell] = node.getCellByName(cell).String
            else:
                values[target] = node.String
    for key, page in collection(doc, 'page-style'):
        for kind in ('Header', 'Footer'):
            if page.getPropertyValue(kind + 'IsOn'):
                values[kind.lower() + ':' + quote(key, safe='')] = page.getPropertyValue(kind + 'Text').String
    return values


def literal_paragraph(cursor):
    # UNO's String includes computed note labels that are not w:t source text.
    paragraph = cursor.createEnumeration().nextElement()
    portions, text = paragraph.createEnumeration(), []
    while portions.hasMoreElements():
        portion = portions.nextElement()
        if portion.TextPortionType == 'Text':
            text.append(portion.String)
    return ''.join(text)


def edit(doc, operations):
    if not isinstance(operations, list) or not 1 <= len(operations) <= 50:
        raise ValueError('preview needs 1-50 operations')
    # Resolve every object before mutation; never retarget by shifted collection indexes.
    targets = [(op, resolve(doc, op['target'])) for op in operations]
    changes = []
    for op, node in targets:
        if set(op) - {'target', 'set', 'replace'} or ('set' in op) == ('replace' in op):
            raise ValueError('Each operation requires exactly one of set or replace')
        if 'set' in op:
            if not isinstance(op['set'], dict) or not 1 <= len(op['set']) <= 20:
                raise ValueError('set needs 1-20 properties')
            for name, value in op['set'].items():
                if not writable(op['target'], name):
                    raise ValueError('Property is outside the writable policy: ' + name)
                subject = property_object(node, name)
                before = encode(subject.getPropertyValue(name))
                requested = decode(value)
                subject.setPropertyValue(name, requested)
                after = encode(subject.getPropertyValue(name))
                if after != encode(requested):
                    raise ValueError('Writer did not accept requested property ' + name)
                changes.append({'target': op['target'], 'property': name, 'before': before, 'after': after})
        else:
            replacement = op['replace']
            if set(replacement) != {'find', 'text'} or not all(isinstance(v, str) for v in replacement.values()):
                raise ValueError('replace needs exact find and text strings')
            old, new = replacement['find'], replacement['text']
            if not old or max(len(old), len(new)) > 10000 or any(c in old + new for c in '\r\n\t'):
                raise ValueError('Replacement must stay inside one paragraph and be <= 10000 characters')
            text = node.String
            if text.count(old) != 1:
                raise ValueError('Replacement target is missing or ambiguous')
            owner = node.getText() if hasattr(node, 'getText') else node
            search = doc.createSearchDescriptor()
            search.SearchString, search.SearchCaseSensitive = old, True
            search.SearchRegularExpression = False
            matches, scoped = doc.findAll(search), []
            if matches.Count > 10000:
                raise ValueError('Too many native search matches; narrow the anchor')
            for index in range(matches.Count):
                found = matches.getByIndex(index)
                try:
                    inside = (owner.compareRegionStarts(node.Start, found.Start) >= 0 and
                              owner.compareRegionEnds(node.End, found.End) <= 0)
                except Exception:
                    continue  # A match in a different story is not comparable.
                if inside and found.String == old:
                    scoped.append(found)
            if len(scoped) != 1:
                raise ValueError('Native search is missing or ambiguous inside the exact target')
            paragraph = owner.createTextCursorByRange(scoped[0].Start)
            paragraph.gotoStartOfParagraph(False)
            paragraph.gotoEndOfParagraph(True)
            before_paragraph = literal_paragraph(paragraph)
            scoped[0].String = new
            changes.append({'target': op['target'], 'before': old, 'after': new,
                            '_paragraph_before': before_paragraph, '_paragraph_after': literal_paragraph(paragraph)})
    return changes


def _run(source, output, request, binary):
    if sys.platform.startswith('linux') and os.environ.get('BEAVER_UNO_OWNED_GROUP') == '1':
        import resource
        for kind, limit in ((resource.RLIMIT_AS, 2 * 1024 ** 3),
                            (resource.RLIMIT_CPU, 90), (resource.RLIMIT_FSIZE, MAX_FILE),
                            (resource.RLIMIT_NOFILE, 256)):
            _, hard = resource.getrlimit(kind)
            bound = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
            resource.setrlimit(kind, (bound, hard))
    before_parts, before_review, expected_paragraphs = package(source)
    source_hash = sha256(source.read_bytes()).hexdigest()
    if request.get('snapshot') not in (None, source_hash):
        raise ValueError('Stale snapshot; inspect the current document again')
    action = request.get('action', 'inspect')
    if action not in ('inspect', 'describe', 'preview'):
        raise ValueError('Unknown action')
    if action == 'preview' and request.get('snapshot') != source_hash:
        raise ValueError('preview requires the snapshot returned by inspect')
    if action == 'preview' and (output is None or output.exists() or output.resolve() == source.resolve()):
        raise ValueError('Choose a new candidate path; the source is never overwritten')
    with writer(binary) as (desktop, version):
        doc = load(desktop, source)
        try:
            if action != 'preview':
                return {'ok': True, 'snapshot': source_hash, 'engine_version': version, **inspect(doc, request)}
            changes = edit(doc, request.get('operations'))
            expected_text = texts(doc)
            doc.storeToURL(output.resolve().as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
        finally:
            doc.close(True)
        after_parts, after_review, actual_paragraphs = package(output)
        for change in changes:
            if '_paragraph_before' in change:
                old, new = change.pop('_paragraph_before'), change.pop('_paragraph_after')
                family = change['target'].split(':', 1)[0]
                kind = family if family in ('header', 'footer') else 'flow'
                if old:
                    if expected_paragraphs[(kind, old)] < 1:
                        raise ValueError('Imported paragraph does not match original package text')
                    expected_paragraphs[(kind, old)] -= 1
                if new:
                    expected_paragraphs[(kind, new)] += 1
        if +expected_paragraphs != actual_paragraphs:
            raise ValueError('Export changed paragraph text outside the requested replacements')
        if before_review != after_review:
            output.unlink()
            raise ValueError('Export altered revisions, comments, bindings, custom XML or opaque assets')
        reopened = load(desktop, output)
        try:
            if texts(reopened) != expected_text:
                raise ValueError('Export/reopen changed document text or story identities')
            final_properties = {(c['target'], c['property']): c for c in changes if 'property' in c}
            for change in final_properties.values():
                if 'property' in change:
                    actual = encode(property_object(resolve(reopened, change['target']), change['property'])
                                    .getPropertyValue(change['property']))
                    if actual != change['after']:
                        raise ValueError('Export/reopen lost property ' + change['property'])
        except Exception:
            output.unlink(missing_ok=True)
            raise
        finally:
            reopened.close(True)
    return {'ok': True, 'snapshot': source_hash, 'candidate_sha256': sha256(output.read_bytes()).hexdigest(),
            'engine_version': version, 'mode': 'direct-candidate', 'changes': changes, 'reopened': True,
            'changed_parts': [name for name in sorted(set(before_parts) | set(after_parts))
                              if before_parts.get(name) != after_parts.get(name)],
            'warning': 'LibreOffice rewrites DOCX. Reopen/text/review checks are not proof of lossless Word layout.'}


def run(source, output, request, binary):
    fresh = output is not None and not output.exists() and output.resolve() != source.resolve()
    try:
        return _run(source, output, request, binary)
    except BaseException:
        if fresh:
            output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--soffice', default=os.environ.get('SOFFICE_BINARY_PATH') or shutil.which('soffice'))
    args = parser.parse_args()
    try:
        if not args.soffice:
            raise ValueError('LibreOffice is unavailable')
        raw = sys.stdin.read(262145)
        if len(raw) > 262144:
            raise ValueError('Request exceeds 256 KiB')
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError('Request must be an object')
        result = run(args.source, args.output, request, args.soffice)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)[:1000]}))
        raise SystemExit(1)


if __name__ == '__main__':
    def terminate(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, terminate)
    main()
