#!/usr/bin/env python3
"""Private Writer session and document-local RPC. Never executes model Python.

The JavaScript console runs in QuickJS, outside this process. The only objects
crossing the boundary are primitives, typed UNO values and session-owned handles.
"""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import posixpath
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
FAMILIES = ('paragraph', 'table', 'footnote', 'endnote', 'frame', 'bookmark',
            'field', 'section', 'drawing', 'index', 'control', 'revision',
            'page-style', 'paragraph-style', 'character-style', 'numbering-style')
STYLE_FAMILIES = {'page-style': 'PageStyles', 'paragraph-style': 'ParagraphStyles',
                  'character-style': 'CharacterStyles', 'numbering-style': 'NumberingStyles'}
# Block host/application capabilities, not a short whitelist of Word formatting.
FORBIDDEN = re.compile(r'(?:URL|URI|Events|Script|Macro|Library|Libraries|InteropGrabBag|'
    r'Context|ServiceManager|Controller|DocumentStorage|DocumentSubStorage|Parent|'
    r'DDE|DataSource|Database|Connection|Password|Command|External|Link|RecordChanges|'
    r'RecordChangesProtection|RedlineDisplay|RedlineProtection)', re.I)
SAFE_HYPERLINKS = {'HyperLinkURL', 'HyperLinkTarget', 'HyperLinkName'}


def props(**values):
    result = []
    for key, value in values.items():
        item = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
        item.Name, item.Value = key, value
        result.append(item)
    return tuple(result)


def package(path):
    """Bounded active-content screening; opaque and authored-text witnesses."""
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
            if any(p in name.lower() for p in ('/embeddings/', '/activex/', 'vbaproject')):
                raise ValueError('Macros and embedded objects require a separately qualified engine path')
            data = archive.read(entry)
            if name.endswith(('.xml', '.rels')):
                folded = data.replace(b'\0', b'').upper()
                if b'<!DOCTYPE' in folded or b'<!ENTITY' in folded:
                    raise ValueError('DTD/entity declarations are forbidden')
            hashes[name] = sha256(data).hexdigest()
            if not name.endswith(('.xml', '.rels')) and not name.startswith('docProps/thumbnail.'):
                protected[('opaque', name, hashes[name])] += 1
            if name.startswith('customXml/'):
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
                protected[key] = protected[key] + 1 if kind == 'flow' else 1
            def paragraph_text(node, fields):
                if node.tag in (W + 'del', W + 'moveFrom'):
                    return ''
                if node.tag == W + 'fldSimple' and pagination(node.get(W + 'instr', '')):
                    page_field(pagination(node.get(W + 'instr', '')))
                    return ''
                if node.tag == W + 'fldChar':
                    event = node.get(W + 'fldCharType')
                    if event == 'begin': fields.append({'code': '', 'result': False})
                    elif fields and event == 'separate':
                        fields[-1]['result'] = True
                        if pagination(fields[-1]['code']): page_field(pagination(fields[-1]['code']))
                    elif fields and event == 'end': fields.pop()
                    return ''
                if node.tag == W + 'instrText' and fields:
                    fields[-1]['code'] += node.text or ''
                    return ''
                if node.tag == W + 't':
                    return '' if any(f['result'] and pagination(f['code']) for f in fields) else node.text or ''
                if node.tag == W + 'tab': return '\t'
                if node.tag in (W + 'br', W + 'cr'): return '\n'
                return ''.join(paragraph_text(child, fields) for child in node if child.tag != W + 'p')
            for paragraph in root.iter(W + 'p'):
                text = paragraph_text(paragraph, [])
                if text:
                    paragraphs[(kind, text)] = paragraphs[(kind, text)] + 1 if kind == 'flow' else 1
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
                    if target.path: internal.append(resolved)
                if local == 'Relationship' and node.get('TargetMode') == 'External':
                    if not node.get('Type', '').endswith('/hyperlink') or not re.match(r'^(https?:|mailto:)', node.get('Target', ''), re.I):
                        raise ValueError('Active external relationships are forbidden')
                if local in ('instrText', 'fldSimple'):
                    instructions.append(node.get(W + 'instr', '') + (node.text or ''))
                if node.tag in {W + t for t in ('ins', 'del', 'moveFrom', 'moveTo', 'comment')}:
                    text = ''.join(n.text or '' for n in node.iter() if n.tag in (W + 't', W + 'delText', W + 'instrText'))
                    protected[(local, node.get(W + 'author', ''), text)] += 1
                if node.tag == W + 'dataBinding':
                    protected[('binding', tuple(sorted(node.attrib.items())))] += 1
            if re.search(r'DDE|INCLUDETEXT|INCLUDEPICTURE|DATABASE|\bLINK\b', ''.join(instructions).upper()):
                raise ValueError('Active field instructions are forbidden')
    if any(target not in hashes for target in internal): raise ValueError('Dangling internal relationship')
    if 'word/document.xml' not in hashes or '[Content_Types].xml' not in hashes:
        raise ValueError('Not a Word document package')
    return hashes, protected, paragraphs


def _windows_job():
    """The kernel closes the owned office tree even when the Python worker dies."""
    if os.name != 'nt': return None
    import ctypes
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64), ('Flags', w.DWORD),
                    ('Min', ctypes.c_size_t), ('Max', ctypes.c_size_t), ('Active', w.DWORD),
                    ('Affinity', ctypes.c_size_t), ('Priority', w.DWORD), ('Scheduling', w.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ('ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes')]
    class Limits(ctypes.Structure):
        _fields_ = [('Basic', Basic), ('IO', IO), ('ProcessMemory', ctypes.c_size_t),
                    ('JobMemory', ctypes.c_size_t), ('PeakProcess', ctypes.c_size_t), ('PeakJob', ctypes.c_size_t)]
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateJobObjectW.argtypes, k.CreateJobObjectW.restype = [ctypes.c_void_p, w.LPCWSTR], w.HANDLE
    k.GetCurrentProcess.restype = w.HANDLE
    k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    job = k.CreateJobObjectW(None, None)
    limit = Limits(); limit.Basic.Flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job or not k.SetInformationJobObject(job, 9, ctypes.byref(limit), ctypes.sizeof(limit)) or not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), 'Cannot establish owned Windows job')
    # Intentionally retained for process lifetime. Closing it would kill this process too.
    return job


@contextmanager
def writer(binary, author="Beaver"):
    with tempfile.TemporaryDirectory(prefix='beaver-uno-') as directory:
        from xml.sax.saxutils import escape
        user = Path(directory, 'profile', 'user'); user.mkdir(parents=True)
        user.joinpath('registrymodifications.xcu').write_text(
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.UserProfile/Data">'
            '<prop oor:name="givenname" oor:op="fuse"><value>' + escape(author) + '</value></prop>'
            '<prop oor:name="sn" oor:op="fuse"><value></value></prop></item></oor:items>', encoding='utf-8')
        pipe = 'beaver_' + os.urandom(16).hex()
        own_group = os.name != 'nt' and os.environ.get('BEAVER_UNO_OWNED_GROUP') != '1'
        process = subprocess.Popen([binary, '-env:UserInstallation=' + Path(directory, 'profile').as_uri(),
            '--headless', '--norestore', '--nodefault', '--nofirststartwizard',
            '--accept=pipe,name=' + pipe + ';urp;StarOffice.ComponentContext'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=own_group)
        desktop = None
        try:
            context = uno.getComponentContext()
            resolver = context.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', context)
            deadline = time.monotonic() + 25
            while True:
                try:
                    remote = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext')
                    break
                except Exception:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('Private LibreOffice instance did not become ready')
                    time.sleep(0.05)
            desktop = remote.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', remote)
            provider = remote.ServiceManager.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider', remote)
            product = provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationAccess', props(nodepath='/org.openoffice.Setup/Product'))
            yield desktop, product.getByName('ooSetupVersionAboutBox')
        finally:
            if desktop is not None:
                try: desktop.terminate()
                except Exception: pass
            if process.poll() is None:
                if not own_group: process.terminate()
                else: os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if not own_group: process.kill()
                    else: os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def load(desktop, path):
    doc = desktop.loadComponentFromURL(path.resolve().as_uri(), '_blank', 0, props(
        Hidden=True, ReadOnly=False, MacroExecutionMode=uno.getConstantByName(
            'com.sun.star.document.MacroExecMode.NEVER_EXECUTE'),
        UpdateDocMode=uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
    if doc is None or not doc.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('LibreOffice did not load a Writer document')
    doc.RecordChanges = False
    return doc


def enumerate_values(values):
    if hasattr(values, 'getElementNames'):
        return [(n, values.getByName(n)) for n in values.getElementNames()]
    if hasattr(values, 'getCount'):
        return [(str(i), values.getByIndex(i)) for i in range(values.getCount())]
    enum, result = values.createEnumeration(), []
    while enum.hasMoreElements():
        result.append((str(len(result)), enum.nextElement()))
        if len(result) > 100000: raise ValueError('Collection exceeds 100000 objects')
    return result


def collection(doc, family):
    if family in STYLE_FAMILIES: return enumerate_values(doc.StyleFamilies.getByName(STYLE_FAMILIES[family]))
    names = {'table': 'TextTables', 'frame': 'TextFrames', 'footnote': 'Footnotes', 'endnote': 'Endnotes',
             'bookmark': 'Bookmarks', 'field': 'TextFields', 'section': 'TextSections', 'drawing': 'DrawPage',
             'index': 'DocumentIndexes', 'revision': 'Redlines', 'control': 'ContentControls'}
    if family in names:
        if not hasattr(doc, names[family]): raise ValueError('This LibreOffice version does not expose ' + family)
        return enumerate_values(getattr(doc, names[family]))
    if family == 'paragraph':
        return [(str(i), n) for i, n in enumerate(n for _, n in enumerate_values(doc.Text)
                if n.supportsService('com.sun.star.text.Paragraph'))]
    if family == 'document': return [('root', doc)]
    raise ValueError('Unknown target family')


def resolve(doc, target):
    if target == 'document:root': return doc
    family, sep, name = target.partition(':')
    if not sep: raise ValueError('Use a target returned by inspect')
    if family == 'cell':
        table, _, cell = name.partition('/')
        return doc.TextTables.getByName(unquote(table)).getCellByName(unquote(cell))
    if family in ('header', 'footer'):
        page = doc.StyleFamilies.getByName('PageStyles').getByName(unquote(name))
        return page.getPropertyValue('HeaderText' if family == 'header' else 'FooterText')
    for key, node in collection(doc, family):
        if key == unquote(name): return node
    raise ValueError('Target does not exist in this snapshot')


def encode(value, depth=0):
    if depth > 10: raise ValueError('Native value is too deeply nested')
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, uno.Enum): return {'enum': value.typeName, 'value': value.value}
    if isinstance(value, (tuple, list)):
        if len(value) > 10000: raise ValueError('Native sequence exceeds limit')
        return [encode(v, depth + 1) for v in value]
    name = getattr(value, 'typeName', None)
    if name and isinstance(value, uno.Type): return {'type': value.typeName}
    if name:
        return {'struct': name, 'fields': {k: encode(getattr(value, k), depth + 1)
                for k in dir(value.value) if not k.startswith('_')}}
    return {'type': 'interface', 'expanded': False}


def check_name(name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,100}', name):
        raise ValueError('Invalid native member name')
    if FORBIDDEN.search(name) and name not in SAFE_HYPERLINKS:
        raise ValueError('Member is outside document-only capabilities: ' + name)


def check_value(name, value):
    check_name(name)
    if name == 'HyperLinkURL' and value and not re.match(r'^(?:https?://|mailto:|#)', value, re.I):
        raise ValueError('Only HTTP/mailto and internal hyperlinks are permitted')
    if isinstance(value, dict):
        for k, v in value.get('fields', {}).items(): check_value(k, v)
        # PropertyValue/NamedValue can smuggle another setting through a sequence.
        fields = value.get('fields', {})
        if 'Name' in fields and 'Value' in fields: check_value(fields['Name'], fields['Value'])
    elif isinstance(value, list):
        for v in value: check_value(name, v)


def decode(value, refs=None, depth=0):
    if depth > 10: raise ValueError('Native value is too deeply nested')
    if value is None or isinstance(value, (bool, int, float)): return value
    if isinstance(value, str):
        if len(value) > 100000: raise ValueError('Value exceeds 100000 characters')
        return value
    if isinstance(value, list) and len(value) <= 10000:
        return tuple(decode(v, refs, depth + 1) for v in value)
    if isinstance(value, dict) and set(value) == {'ref'} and refs is not None:
        if value['ref'] not in refs: raise ValueError('Unknown session handle')
        return refs[value['ref']]
    if isinstance(value, dict) and set(value) == {'enum', 'value'}:
        if not re.fullmatch(r'com\.sun\.star\.(?:text|style|table|drawing|awt|lang)\.[A-Za-z0-9_.]+', value['enum']):
            raise ValueError('Enum is outside document types')
        return uno.Enum(value['enum'], value['value'])
    if isinstance(value, dict) and set(value) == {'struct', 'fields'}:
        if not re.fullmatch(r'com\.sun\.star\.(?:text|style|table|drawing|awt|lang|beans|util)\.[A-Za-z0-9_.]+', value['struct']):
            raise ValueError('Struct is outside document types')
        result = uno.createUnoStruct(value['struct'])
        for key, item in value['fields'].items():
            check_value(key, item)
            if not hasattr(result, key): raise ValueError('Unknown struct field: ' + key)
            setattr(result, key, decode(item, refs, depth + 1))
        return result
    raise ValueError('Use primitives, native enum/struct values or owned handles')


def writable(target, name):
    try: check_name(name); return True
    except ValueError: return False


def property_object(node, name):
    if name == 'String' and hasattr(node, 'String'): return node
    if hasattr(node, 'getPropertySetInfo') and node.getPropertySetInfo().hasPropertyByName(name): return node
    cursor = node.createTextCursor(); cursor.gotoStart(False); cursor.gotoEnd(True)
    return cursor


def bounded(request, key, default, maximum):
    value = request.get(key, default)
    if type(value) is not int or not 0 <= value <= maximum: raise ValueError(key + ' is outside the supported range')
    return value


def inspect(doc, request):
    offset, limit = bounded(request, 'offset', 0, 100000), bounded(request, 'limit', 20, 100)
    if not limit: raise ValueError('limit must be positive')
    target = request.get('target')
    if target:
        node = resolve(doc, target)
        if request.get('action') == 'describe':
            info = node.getPropertySetInfo() if hasattr(node, 'getPropertySetInfo') else node.createTextCursor().getPropertySetInfo()
            selected = [p for p in info.Properties if request.get('filter', '').lower() in p.Name.lower()]
            rows = []
            for prop in selected[offset:offset + limit]:
                row = {'name': prop.Name, 'type': prop.Type.typeName, 'writable': writable(target, prop.Name) and not prop.Attributes & 16}
                try: row['value'] = encode(property_object(node, prop.Name).getPropertyValue(prop.Name))
                except Exception: row['unavailable'] = True
                rows.append(row)
            return {'target': target, 'items': rows, 'total': len(selected), 'next_offset': offset + len(rows) if offset + len(rows) < len(selected) else None}
        text = getattr(node, 'String', '')
        result = {'target': target, 'text': text[offset:offset + limit * 100], 'total_chars': len(text)}
        result['next_offset'] = offset + len(result['text']) if offset + len(result['text']) < len(text) else None
        if target.startswith('table:'):
            cells = node.getCellNames()
            result.update(cells=[{'target': 'cell:' + target.split(':', 1)[1] + '/' + quote(c, safe=''), 'text': node.getCellByName(c).String[:200]} for c in cells[offset:offset + limit]], total_cells=len(cells), next_offset=offset + limit if offset + limit < len(cells) else None)
        return result
    family = request.get('family', 'paragraph'); selected = collection(doc, family)
    rows = []
    for key, node in selected[offset:offset + limit]:
        row = {'target': family + ':' + quote(key, safe='')}
        if family != 'revision': row['text'] = getattr(node, 'String', '')[:300]
        if family == 'revision':
            start, end = node.RedlineStart, node.RedlineEnd
            cursor = start.getText().createTextCursorByRange(start); cursor.gotoRange(end, True)
            row.update(author=node.RedlineAuthor, type=node.RedlineType, text=cursor.String[:1000])
        rows.append(row)
    return {'family': family, 'items': rows, 'total': len(selected), 'next_offset': offset + len(rows) if offset + len(rows) < len(selected) else None}


def texts(doc):
    values = {}
    for family in ('paragraph', 'table', 'footnote', 'endnote', 'frame'):
        for key, node in collection(doc, family):
            target = family + ':' + quote(key, safe='')
            if family == 'table':
                for cell in node.getCellNames(): values['cell:' + quote(key, safe='') + '/' + cell] = node.getCellByName(cell).String
            else: values[target] = node.String
    for key, page in collection(doc, 'page-style'):
        for kind in ('Header', 'Footer'):
            if page.getPropertyValue(kind + 'IsOn'): values[kind.lower() + ':' + quote(key, safe='')] = page.getPropertyValue(kind + 'Text').String
    return values


def literal_paragraph(cursor):
    paragraph = cursor.createEnumeration().nextElement()
    portions, text = paragraph.createEnumeration(), []
    while portions.hasMoreElements():
        portion = portions.nextElement()
        if portion.TextPortionType == 'Text': text.append(portion.String)
    return ''.join(text)


def edit(doc, operations):
    if not isinstance(operations, list) or not 1 <= len(operations) <= 1000: raise ValueError('preview needs 1-1000 operations')
    targets = [(op, resolve(doc, op['target'])) for op in operations]
    changes = []
    for op, node in targets:
        if set(op) - {'target', 'set', 'replace'} or ('set' in op) == ('replace' in op):
            raise ValueError('Each operation requires exactly one of set or replace')
        if 'set' in op:
            if not isinstance(op['set'], dict) or not 1 <= len(op['set']) <= 100: raise ValueError('set needs 1-100 properties')
            for name, value in op['set'].items():
                check_value(name, value)
                subject = property_object(node, name)
                if subject.getPropertySetInfo().getPropertyByName(name).Attributes & 16: raise ValueError('Read-only property: ' + name)
                before, requested = encode(subject.getPropertyValue(name)), decode(value)
                subject.setPropertyValue(name, requested)
                after = encode(subject.getPropertyValue(name))
                if after != encode(requested): raise ValueError('Writer did not accept requested property ' + name)
                changes.append({'target': op['target'], 'property': name, 'before': before, 'after': after})
        else:
            replacement = op['replace']
            if set(replacement) != {'find', 'text'} or not all(isinstance(v, str) for v in replacement.values()): raise ValueError('replace needs exact find and text strings')
            old, new = replacement['find'], replacement['text']
            if not old or max(len(old), len(new)) > 10000 or any(c in old + new for c in '\r\n\t'): raise ValueError('Replacement must stay inside one paragraph and be <= 10000 characters')
            if node.String.count(old) != 1: raise ValueError('Replacement target is missing or ambiguous')
            owner = node.getText() if hasattr(node, 'getText') else node
            search = doc.createSearchDescriptor(); search.SearchString, search.SearchCaseSensitive = old, True
            search.SearchRegularExpression = False
            matches, scoped = doc.findAll(search), []
            if matches.Count > 10000: raise ValueError('Too many native search matches')
            for index in range(matches.Count):
                found = matches.getByIndex(index)
                try: inside = owner.compareRegionStarts(node.Start, found.Start) >= 0 and owner.compareRegionEnds(node.End, found.End) <= 0
                except Exception: continue
                if inside and found.String == old: scoped.append(found)
            if len(scoped) != 1: raise ValueError('Native search is missing or ambiguous inside the exact target')
            paragraph = owner.createTextCursorByRange(scoped[0].Start)
            paragraph.gotoStartOfParagraph(False); paragraph.gotoEndOfParagraph(True)
            before_paragraph = literal_paragraph(paragraph)
            scoped[0].String = new
            changes.append({'target': op['target'], 'before': old, 'after': new, '_paragraph_before': before_paragraph, '_paragraph_after': literal_paragraph(paragraph)})
    return changes


def run(source, output, request, binary):
    package(source)
    snapshot = sha256(source.read_bytes()).hexdigest()
    if request.get('snapshot') not in (None, snapshot): raise ValueError('Stale snapshot; inspect again')
    action = request.get('action', 'inspect')
    if action == 'preview':
        if request.get('snapshot') != snapshot: raise ValueError('preview requires an inspected snapshot')
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from word_uno_console import transact
        return transact(source, output, {**request, 'mode': request.get('mode', 'direct')}, binary,
                        lambda broker, *_: broker.rpc({'op':'batch', 'operations':request.get('operations')}))
    if action not in ('inspect', 'describe'): raise ValueError('Unknown action')
    with writer(binary) as (desktop, version):
        doc = load(desktop, source)
        try: return {'ok':True, 'snapshot':snapshot, 'engine_version':version, **inspect(doc,request)}
        finally: doc.close(True)


def main():
    _job = _windows_job()
    if sys.platform.startswith('linux') and os.environ.get('BEAVER_UNO_OWNED_GROUP') == '1':
        import resource
        for kind, limit in ((resource.RLIMIT_AS, 2*1024**3), (resource.RLIMIT_CPU, 100), (resource.RLIMIT_FSIZE, MAX_FILE), (resource.RLIMIT_NOFILE, 256)):
            _, hard = resource.getrlimit(kind)
            resource.setrlimit(kind, (limit if hard == resource.RLIM_INFINITY else min(limit,hard), hard))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path); parser.add_argument('--output', type=Path)
    parser.add_argument('--soffice', default=os.environ.get('SOFFICE_BINARY_PATH') or shutil.which('soffice'))
    args = parser.parse_args()
    try:
        if not args.soffice: raise ValueError('LibreOffice is unavailable')
        raw = sys.stdin.readline(262145)
        if len(raw) > 262144: raise ValueError('Request exceeds 256 KiB')
        request = json.loads(raw)
        if not isinstance(request, dict): raise ValueError('Request must be an object')
        if request.get('action') == 'console':
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from word_uno_console import serve
            result = serve(args.source, args.output, request, args.soffice)
        else: result = run(args.source, args.output, request, args.soffice)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)[:1000]}), flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    def terminate(*_): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, terminate)
    main()
