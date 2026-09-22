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
from itertools import islice
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
import unohelper
from com.sun.star.frame import XTerminateListener, TerminationVetoException

MAX_FILE = 100 * 1024 * 1024
MAX_XML = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
STYLE_FAMILIES = {'page-style': 'PageStyles', 'paragraph-style': 'ParagraphStyles',
                  'character-style': 'CharacterStyles', 'numbering-style': 'NumberingStyles'}
# Only independent, enabled stories are targets; shared variants alias the default.
PAGE_STORIES = {kind.lower() + suffix: (kind + 'Text' + variant, kind + 'IsOn', shared)
    for kind in ('Header', 'Footer')
    for suffix, variant, shared in (('', '', None), ('-left', 'Left', kind + 'IsShared'), ('-first', 'First', 'FirstIsShared'))}


# Block host/application capabilities, not a short whitelist of Word formatting.
FORBIDDEN = re.compile(r'(?:URL|URI|Events|Script|Macro|Library|Libraries|InteropGrabBag|'
    r'Context|ServiceManager|Controller|DocumentStorage|DocumentSubStorage|Parent|'
    r'DDE|DataSource|Database|Connection|Password|Command|External|Link|RecordChanges|'
    r'RecordChangesProtection|RedlineDisplay|RedlineProtection)', re.I)
SAFE_MEMBERS = {'HyperLinkURL', 'HyperLinkTarget', 'HyperLinkName',
                'ParentStyle', 'getParentStyle', 'setParentStyle'}


def props(**values):
    return tuple(uno.createUnoStruct('com.sun.star.beans.PropertyValue', Name=key, Value=value)
                 for key, value in values.items())


def package(path):
    """Bounded active-content screening; opaque and authored-text witnesses."""
    if not 0 < path.stat().st_size <= MAX_FILE:
        raise ValueError('DOCX is empty or exceeds 100 MiB')
    hashes, protected, internal, paragraphs = {}, Counter(), [], Counter()
    reviews = {W + tag for tag in ('ins', 'del', 'moveFrom', 'moveTo', 'comment')}
    text_tags = {W + tag for tag in ('t', 'delText', 'instrText')}
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
                if node.tag in reviews:
                    text = ''.join(n.text or '' for n in node.iter() if n.tag in text_tags)
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
    limit = Limits(); limit.Basic.Flags = 0x2000
    if not job or not k.SetInformationJobObject(job, 9, ctypes.byref(limit), ctypes.sizeof(limit)) or not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), 'Cannot establish owned Windows job')
    # Intentionally retained for process lifetime. Closing it would kill this process too.
    return job


class SessionLifetime(unohelper.Base, XTerminateListener):
    """Hold the owned desktop between document close and reopen. Removed before termination."""
    def queryTermination(self, event):
        raise TerminationVetoException('Document session is still active', self)

    def notifyTermination(self, event): pass
    def disposing(self, event): pass


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
        desktop, lifetime = None, SessionLifetime()
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
            desktop.addTerminateListener(lifetime)
            provider = remote.ServiceManager.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider', remote)
            product = provider.createInstanceWithArguments('com.sun.star.configuration.ConfigurationAccess', props(nodepath='/org.openoffice.Setup/Product'))
            yield desktop, product.getByName('ooSetupVersionAboutBox')
        except Exception as error:
            # contextlib assigns __traceback__; PyUNO exception structs reject it.
            if isinstance(error, uno.getClass('com.sun.star.uno.Exception')):
                raise RuntimeError(str(error)) from None
            raise
        finally:
            if desktop is not None:
                try:
                    desktop.removeTerminateListener(lifetime)
                    desktop.terminate()
                except Exception: pass
            # terminate() requests asynchronous shutdown. Killing the Windows
            # launcher immediately can orphan soffice.bin until our job closes,
            # leaving profile files locked while TemporaryDirectory removes them.
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    taskkill = str(Path(os.environ['SYSTEMROOT'], 'System32', 'taskkill.exe'))
                    subprocess.run([taskkill, '/PID', str(process.pid), '/T', '/F'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
                elif own_group:
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if own_group: os.killpg(process.pid, signal.SIGKILL)
                    else: process.kill()
                    process.wait(timeout=3)


def load(desktop, path):
    doc = desktop.loadComponentFromURL(path.resolve().as_uri(), '_blank', 0, props(
        Hidden=True, ReadOnly=False, MacroExecutionMode=uno.getConstantByName(
            'com.sun.star.document.MacroExecMode.NEVER_EXECUTE'),
        UpdateDocMode=uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE')))
    if doc is None or not doc.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('LibreOffice did not load a Writer document')
    doc.RecordChanges = False
    return doc


def enumerate_values(values, offset=0):
    """Fetch native objects lazily; indexed/named pages need not fetch their prefix."""
    if hasattr(values, 'getElementNames'):
        names = values.getElementNames()
        if len(names) > 100000: raise ValueError('Collection exceeds 100000 objects')
        for name in names[offset:]: yield name, values.getByName(name)
    elif hasattr(values, 'getCount'):
        count = values.getCount()
        if count > 100000: raise ValueError('Collection exceeds 100000 objects')
        for index in range(offset, count): yield str(index), values.getByIndex(index)
    else:
        enum = values.createEnumeration()
        index = 0
        while enum.hasMoreElements():
            if index >= 100000: raise ValueError('Collection exceeds 100000 objects')
            node = enum.nextElement()
            if index >= offset: yield str(index), node
            index += 1


def native_collection(doc, family):
    if family in STYLE_FAMILIES: return doc.StyleFamilies.getByName(STYLE_FAMILIES[family])
    names = {'table': 'TextTables', 'frame': 'TextFrames', 'footnote': 'Footnotes', 'endnote': 'Endnotes',
             'bookmark': 'Bookmarks', 'field': 'TextFields', 'section': 'TextSections', 'drawing': 'DrawPage',
             'index': 'DocumentIndexes', 'revision': 'Redlines', 'control': 'ContentControls'}
    if family not in names: raise ValueError('Unknown target family')
    if not hasattr(doc, names[family]): raise ValueError('This LibreOffice version does not expose ' + family)
    return getattr(doc, names[family])


def page_story(style, family, include_shared=False):
    prop, enabled, shared = PAGE_STORIES[family]
    if getattr(style, enabled) and (include_shared or not (shared and getattr(style, shared))):
        return getattr(style, prop)


def collection(doc, family, offset=0):
    if family in ('document', 'body'): return iter([('root', doc if family == 'document' else doc.Text)][offset:])
    if family in PAGE_STORIES:
        stories = ((name, story) for name, style in collection(doc, 'page-style')
                   if (story := page_story(style, family)) is not None)
        return islice(stories, offset, None)
    if family == 'paragraph':
        nodes = (node for _, node in enumerate_values(doc.Text) if node.supportsService('com.sun.star.text.Paragraph'))
        return ((str(i), node) for i, node in islice(enumerate(nodes), offset, None))
    return enumerate_values(native_collection(doc, family), offset)


def resolve(doc, target):
    if target == 'document:root': return doc
    if target == 'body:root': return doc.Text
    family, sep, name = target.partition(':')
    if not sep: raise ValueError('Use a target returned by inspect')
    if family == 'cell':
        table, _, cell = name.partition('/')
        return doc.TextTables.getByName(unquote(table)).getCellByName(unquote(cell))
    if family in PAGE_STORIES:
        story = page_story(doc.StyleFamilies.getByName('PageStyles').getByName(unquote(name)), family)
        if story is None: raise ValueError('Header/footer is disabled or shared; inspect its page style')
        return story
    name = unquote(name)
    if family == 'paragraph' and re.fullmatch(r'0|[1-9][0-9]*', name):
        address = 'paragraph:' + name
        return resolve_many(doc, [address])[address]
    values = native_collection(doc, family)
    if hasattr(values, 'getByName'): return values.getByName(name)
    if hasattr(values, 'getByIndex') and re.fullmatch(r'0|[1-9][0-9]*', name): return values.getByIndex(int(name))
    for key, node in enumerate_values(values):
        if key == name: return node
    raise ValueError('Target does not exist in this snapshot')


def resolve_many(doc, targets):
    resolved, paragraphs = {}, {}
    for target in dict.fromkeys(targets):
        if not isinstance(target, str): raise ValueError('Use inspected target addresses')
        if re.fullmatch(r'paragraph:(0|[1-9][0-9]*)', target):
            paragraphs[target.partition(':')[2]] = target
        else: resolved[target] = resolve(doc, target)
    if paragraphs:
        for index, node in collection(doc, 'paragraph'):
            if index in paragraphs: resolved[paragraphs.pop(index)] = node
            if not paragraphs: break
    if paragraphs: raise ValueError('Target does not exist in this snapshot')
    return resolved


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
    if FORBIDDEN.search(name) and name not in SAFE_MEMBERS:
        raise ValueError('Member is outside document-only capabilities: ' + name)


def check_value(name, value):
    check_name(name)
    if name == 'HyperLinkURL' and value and not re.match(r'^(?:https?://|mailto:|#)', value, re.I):
        raise ValueError('Only HTTP/mailto and internal hyperlinks are permitted')
    if isinstance(value, dict):
        fields = value.get('fields', {})
        for key, item in fields.items():
            check_value(fields.get('Name', key) if key == 'Value' else key, item)
    elif isinstance(value, list):
        for v in value: check_value(name, v)


def decode(value, refs=None, depth=0):
    if depth > 10: raise ValueError('Native value is too deeply nested')
    if value is None or isinstance(value, (bool, int, float, str)):
        if isinstance(value, str) and len(value) > 100000: raise ValueError('Value exceeds 100000 characters')
        return value
    if isinstance(value, list) and len(value) <= 10000:
        return tuple(decode(v, refs, depth + 1) for v in value)
    if isinstance(value, dict) and set(value) == {'ref'} and refs is not None:
        if value['ref'] not in refs: raise ValueError('Unknown session handle')
        return refs[value['ref']]
    if isinstance(value, dict) and set(value) == {'any', 'value'}:
        name = value['any']
        if not isinstance(name, str) or not re.fullmatch(r'(?:\[\]){0,4}(?:boolean|byte|short|long|hyper|float|double|string|any|com\.sun\.star\.(?:text|style|table|drawing|awt|lang|beans|util)\.[A-Za-z0-9_.]+)', name):
            raise ValueError('Any type is outside document types')
        return uno.Any(name, decode(value['value'], refs, depth + 1))
    if isinstance(value, dict) and set(value) == {'enum', 'value'}:
        if not re.fullmatch(r'com\.sun\.star\.(?:text|style|table|drawing|awt|lang|beans)\.[A-Za-z0-9_.]+', value['enum']):
            raise ValueError('Enum is outside document types')
        return uno.Enum(value['enum'], value['value'])
    if isinstance(value, dict) and set(value) == {'struct', 'fields'}:
        if not re.fullmatch(r'com\.sun\.star\.(?:text|style|table|drawing|awt|lang|beans|util)\.[A-Za-z0-9_.]+', value['struct']):
            raise ValueError('Struct is outside document types')
        for key, item in value['fields'].items(): check_value(key, item)
        return uno.createUnoStruct(value['struct'], **{key: decode(item, refs, depth + 1)
                                   for key, item in value['fields'].items()})
    raise ValueError('Use primitives, native enum/struct values or owned handles')


def properties(node, names, *, operation="get", values=None):
    """One property path for native reads, writes and resetting direct formatting.

    Attribute writes remain separate; only actual beans properties use sorted
    XMultiPropertySet calls. Unknown names must not be silently ignored by UNO.
    """
    # Replacing text invalidates a previously selected character cursor. Apply it
    # before resolving formatting ranges, regardless of the object's key order.
    if operation == 'set' and 'String' in names and len(names) > 1:
        properties(node, ['String'], operation='set', values=values)
        properties(node, [name for name in names if name != 'String'], operation='set', values=values)
        return properties(node, names)
    groups, result, cursor = {}, {}, None
    paragraph = bool(names) and hasattr(node, 'supportsService') and node.supportsService('com.sun.star.text.Paragraph')
    for name in names:
        check_name(name)
        subject = node
        if name.startswith('Char') and paragraph or not hasattr(node, name):
            if cursor is None:
                owner = node.getText() if paragraph else node
                cursor = owner.createTextCursorByRange(node.Start); cursor.gotoRange(node.End, True)
            subject = cursor
        groups.setdefault(subject, []).append(name)
    methods = {'get': 'getPropertyValues', 'set': 'setPropertyValues',
               'state': 'getPropertyStates', 'default': 'getPropertyDefaults', 'reset': 'setPropertiesToDefault'}
    for subject, selected in groups.items():
        bulk = ()
        if len(selected) > 1 and hasattr(subject, methods[operation]):
            bulk = tuple(sorted(set(selected)))
            if operation in ('get', 'set'):
                info = subject.getPropertySetInfo()
                bulk = tuple(n for n in bulk if info.hasPropertyByName(n))
        if bulk:
            args = (bulk, tuple(values[n] for n in bulk)) if operation == 'set' else (bulk,)
            found = getattr(subject, methods[operation])(*args)
            if operation not in ('set', 'reset'): result.update(zip(bulk, found))
        for name in selected:
            if name in bulk: continue
            if operation == 'set': setattr(subject, name, values[name])
            elif operation == 'reset': subject.setPropertyToDefault(name)
            else:
                value = (getattr(subject, name) if operation == 'get' else
                         getattr(subject, 'getPropertyState' if operation == 'state' else 'getPropertyDefault')(name))
                if callable(value): raise ValueError('Use call for native methods')
                result[name] = value
    return properties(node, names) if operation in ('set', 'reset') else result


def bounded(request, key, default, maximum):
    value = request.get(key, default)
    if type(value) is not int or not 0 <= value <= maximum: raise ValueError(key + ' is outside the supported range')
    return value


def page(entries, request):
    offset, limit = bounded(request, 'offset', 0, 100000), bounded(request, 'limit', 20, 100)
    if not limit: raise ValueError('limit must be positive')
    rows = list(islice(entries(offset), limit + 1))
    more = len(rows) > limit
    # Enumeration-only collections have no cheap count. Never scan their tail
    # merely to fill a total, nor invent a total for an out-of-range offset.
    return rows[:limit], {'total': None if more or not rows and offset else offset + len(rows),
                         'next_offset': offset + limit if more else None}


def revision_range(revision):
    start = revision.RedlineStart
    cursor = start.getText().createTextCursorByRange(start)
    cursor.gotoRange(revision.RedlineEnd, True)
    return cursor


def inspect(doc, request):
    offset, limit = bounded(request, 'offset', 0, 100000), bounded(request, 'limit', 20, 100)
    if not limit: raise ValueError('limit must be positive')
    names = request.get('properties', [])
    if not isinstance(names, list) or len(names) > 32: raise ValueError('Select at most 32 properties')
    for name in names: check_name(name)
    def selected(node):
        return {'properties': {name: encode(value) for name, value in properties(node, names).items()}} if names else {}
    target = request.get('target')
    if target:
        node = resolve(doc, target)
        result = {'target': target, **selected(node)}
        if request.get('include_text', True):
            text = getattr(node, 'String', '')
            result.update(text=text[offset:offset + limit * 100], total_chars=len(text),
                          next_offset=offset + limit * 100 if offset + limit * 100 < len(text) else None)
        if target.startswith('table:'):
            cells = node.getCellNames()
            result.update(cells=[{'target': 'cell:' + target.split(':', 1)[1] + '/' + quote(c, safe=''),
                **({'text': node.getCellByName(c).String[:200]} if request.get('include_text', True) else {})}
                for c in cells[offset:offset + limit]], total_cells=len(cells), next_offset=offset + limit if offset + limit < len(cells) else None)
        return result
    family = request.get('family', 'paragraph')
    entries, pagination = page(lambda start: collection(doc, family, start), request)
    rows = []
    for key, node in entries:
        row = {'target': family + ':' + quote(key, safe=''), **selected(node)}
        if family == 'revision':
            row.update(author=node.RedlineAuthor, type=node.RedlineType)
            if request.get('include_text', True):
                row['text'] = revision_range(node).String[:1000]
        elif request.get('include_text', True): row['text'] = getattr(node, 'String', '')[:300]
        rows.append(row)
    return {'family': family, 'items': rows, **pagination}


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
        from word_uno_console import serve
        result = serve(args.source, args.output, request, args.soffice)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    except Exception as error:
        import traceback
        location = ','.join(Path(f.filename).name + ':' + str(f.lineno)
                            for f in traceback.extract_tb(error.__traceback__)[-3:])
        print(json.dumps({'ok': False, 'error': str(error)[:700] + ' [' + location + ']'}), flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    def terminate(*_): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, terminate)
    main()
