"""Document-only UNO broker for the QuickJS console; no Python eval or host proxies."""
from __future__ import annotations
from collections import Counter
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

from word_uno import (W, collection, resolve, encode, decode, check_name, check_value,
                      package, props, writer, load, texts, inspect, edit, property_object, FORBIDDEN)
import uno

# Interfaces are discovered at runtime; application/storage/scripting interfaces
# are never capabilities of a document program. Document-local APIs remain broad.
INTERFACES = ('com.sun.star.text.', 'com.sun.star.style.', 'com.sun.star.table.',
              'com.sun.star.drawing.', 'com.sun.star.container.')
METHODS = {'getString', 'setString', 'getText', 'getStart', 'getEnd', 'getAnchor',
           'getPosition', 'setPosition', 'getSize', 'setSize', 'getShapeType',
           'getCount', 'getByIndex', 'getByName', 'getElementNames', 'getElementType',
           'hasByName', 'hasElements', 'createEnumeration', 'hasMoreElements', 'nextElement',
           'createTextCursor', 'createTextCursorByRange', 'createSearchDescriptor', 'findAll', 'findFirst', 'findNext',
           'supportsService', 'getSupportedServiceNames', 'getAvailableServiceNames',
           'getPropertyDefault', 'getPropertyState', 'getPropertyStates', 'setPropertyToDefault'}
DENIED_METHOD = re.compile(r'^(?:queryInterface|getTypes|getImplementationId|acquire|release|dispose|close|'
    r'store.*|load.*|attachResource|setParent|setPropertyValues|getPropertyValues|'
    r'setPropertyValue|getPropertyValue|setFastPropertyValue|getFastPropertyValue|'
    r'add.*Listener|remove.*Listener|insertDocumentFromURL|updateLinks|refresh|'
    r'createInstanceWithArguments|createInstanceWithContext|createInstanceWithArgumentsAndContext)$')
READ_METHOD = re.compile(r'^(?:get|has|is|supports|createTextCursor|createSearchDescriptor|createEnumeration|nextElement|find|goto|goLeft|goRight|collapse|compareRegion)')
DOCUMENT_SERVICES = re.compile(r'^com\.sun\.star\.(?:text|style|drawing)\.')
ACTIVE_SERVICES = re.compile(r'OLE|Applet|Plugin|MediaShape|Script|Macro|Database|DDE|DataSource', re.I)


def semantic_package(path):
    """Conservative proof: rejecting our changes restores the no-edit control.

Only serialization/inspection metadata are ignored. Document settings, styles,
relationships, custom data and authored metadata are part of the comparison.
"""
    volatile = {'rsidR', 'rsidRPr', 'rsidP', 'rsidSect', 'rsidDel', 'rsidRDefault', 'paraId', 'textId'}
    skip = {W + n for n in ('rsids', 'trackRevisions', 'proofState', 'revisionView', 'lastRenderedPageBreak', 'proofErr')}
    skip.update({'{http://purl.org/dc/terms/}modified',
                 '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}lastModifiedBy',
                 '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}revision',
                 '{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}TotalTime'})
    # Writer adds calculated statistics when selection-based review triggers layout.
    # They are not authored content; all other application properties remain checked.
    skip.update('{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}' + n
                for n in ('Pages', 'Words', 'Characters', 'CharactersWithSpaces', 'Lines', 'Paragraphs'))
    def canonical(node):
        if node.tag in skip: return None
        children = tuple(v for c in node if (v := canonical(c)) is not None)
        attrs = tuple(sorted((k, v) for k, v in node.attrib.items() if k.rsplit('}', 1)[-1] not in volatile))
        if not attrs and not children and not node.text and node.tag in (W+'rPr', W+'pPr'): return None
        return node.tag, attrs, node.text if node.tag in (W+'t', W+'delText', W+'instrText') else (node.text or '').strip(), children
    with zipfile.ZipFile(path) as z:
        return {n: canonical(ET.fromstring(z.read(n))) if n.endswith(('.xml','.rels')) else sha256(z.read(n)).hexdigest()
                for n in z.namelist() if not n.endswith('/') and not n.startswith('docProps/thumbnail.')}


def native_state(doc):
    """Ordered text/story and structural readback; not a complete OOXML validator."""
    result = {'text': texts(doc), 'body': [], 'tables': [], 'bookmarks': [], 'drawings': []}
    body = doc.Text.createEnumeration()
    while body.hasMoreElements():
        node = body.nextElement()
        result['body'].append(('table', node.Name) if node.supportsService('com.sun.star.text.TextTable')
                              else ('paragraph', node.String))
    for name, t in collection(doc, 'table'):
        result['tables'].append((name, tuple(t.getCellNames()), t.Rows.Count))
    for name, b in collection(doc, 'bookmark'):
        result['bookmarks'].append((name, b.Anchor.String))
    for name, s in collection(doc, 'drawing'):
        result['drawings'].append((name, s.ShapeType, encode(s.Position), encode(s.Size)))
    result['revisions'] = [(r.RedlineAuthor, r.RedlineType, redline_text(r)) for _,r in collection(doc, 'revision')]
    return result


def redline_text(r):
    start, end = r.getPropertyValue('RedlineStart'), r.getPropertyValue('RedlineEnd')
    cursor = start.getText().createTextCursorByRange(start); cursor.gotoRange(end, True)
    return cursor.String


def review(doc, indices, decision):
    if decision not in ('accept', 'reject'): raise ValueError('Review must accept or reject named changes')
    selected = [doc.Redlines.getByIndex(i) for i in sorted(set(indices), reverse=True)]
    signatures = lambda: Counter((r.RedlineAuthor, r.RedlineType, redline_text(r)) for _,r in collection(doc, 'revision'))
    expected = signatures() - Counter((r.RedlineAuthor, r.RedlineType, redline_text(r)) for r in selected)
    removed = [(r.RedlineAuthor, r.RedlineType, redline_text(r)) for r in selected]
    ctx = uno.getComponentContext()
    dispatcher = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.DispatchHelper', ctx)
    for r in selected:
        start, end = r.getPropertyValue('RedlineStart'), r.getPropertyValue('RedlineEnd')
        cursor = start.getText().createTextCursorByRange(start); cursor.gotoRange(end, True)
        doc.CurrentController.select(cursor)
        count = doc.Redlines.Count
        dispatcher.executeDispatch(doc.CurrentController.Frame,
            '.uno:AcceptTrackedChange' if decision == 'accept' else '.uno:RejectTrackedChange', '', 0, ())
        if doc.Redlines.Count >= count: raise ValueError('Writer did not resolve the selected revision')
    if signatures() != expected: raise ValueError('Writer resolved a revision outside the requested selection')
    return removed


class Broker:
    def __init__(self, doc, readonly=False):
        self.doc, self.readonly = doc, readonly
        self.refs, self.targets, self.changes, self.checks = {'doc': doc}, {}, [], []
        self.scratch = set()
        self.removed_review = Counter()
        self.calls = 0
        ctx = uno.getComponentContext()
        self.introspection = ctx.ServiceManager.createInstanceWithContext('com.sun.star.beans.Introspection', ctx)

    def save(self, value, target=None):
        if value is None or isinstance(value, (str, bool, int, float, uno.Enum, uno.Type)) or getattr(value, 'typeName', None):
            return encode(value)
        if isinstance(value, (tuple, list)):
            if len(value) > 10000: raise ValueError('Collection too large; use paged inspection')
            return [self.save(v) for v in value]
        if isinstance(value, dict): return {k: self.save(v) for k, v in value.items()}
        if len(self.refs) >= 20000: raise ValueError('Object budget exhausted')
        key = 'u' + str(len(self.refs)); self.refs[key] = value
        if target: self.targets[key] = target
        return {'ref': key}

    def obj(self, key):
        if key in self.refs: return self.refs[key]
        return resolve(self.doc, key)

    def info(self, obj):
        return self.introspection.inspect(obj)

    def method_allowed(self, obj, name):
        try: check_name(name)
        except ValueError: return False
        if DENIED_METHOD.fullmatch(name): return False
        if name in METHODS: return True
        try:
            method = self.info(obj).getMethod(name, -1)
            return method.DeclaringClass.Name.startswith(INTERFACES)
        except Exception: return False

    def mutate(self):
        if self.readonly: raise ValueError('This console is read-only')

    def rpc(self, command):
        self.calls += 1
        if self.calls > 4000: raise ValueError('Native operation budget exhausted')
        op, target = command.get('op'), command.get('target', 'doc')
        obj = self.obj(target)
        if op == 'target': return self.save(obj, target)
        if op == 'inspect':
            query = command.get('query', {})
            if not isinstance(query, dict): raise ValueError('Inspection requires an object')
            return inspect(self.doc, query)
        if op == 'describe':
            offset, limit = command.get('offset', 0), command.get('limit', 50)
            if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 100: raise ValueError('Invalid metadata page')
            info = self.info(obj); pattern = command.get('filter', '').lower()
            properties = [{'name': p.Name, 'type': p.Type.typeName, 'writable': not self.readonly and not p.Attributes & 16 and not bool(FORBIDDEN.search(p.Name))}
                          for p in info.getProperties(-1) if pattern in p.Name.lower()]
            methods = [{'name': m.Name, 'returns': m.ReturnType.Name,
                        'arguments': [{'name': p.aName, 'type': p.aType.Name, 'mode': str(p.aMode)} for p in m.ParameterInfos]}
                       for m in info.getMethods(-1) if pattern in m.Name.lower() and self.method_allowed(obj, m.Name)]
            rows = [{'kind': 'property', **p} for p in properties] + [{'kind': 'method', **m} for m in methods]
            return {'items': rows[offset:offset+limit], 'total': len(rows), 'next_offset': offset+limit if offset+limit < len(rows) else None}
        if op == 'get':
            name = command['name']; check_name(name)
            value = getattr(obj, name)
            if callable(value): raise ValueError('Use call for native methods')
            return self.save(value)
        if op == 'set':
            if target not in self.scratch: self.mutate()
            values = command.get('values')
            if not isinstance(values, dict) or not 1 <= len(values) <= 100: raise ValueError('set requires 1-100 properties')
            for name, value in values.items():
                check_value(name, value)
                subject = obj if hasattr(obj, name) else property_object(obj, name)
                before = encode(getattr(subject, name))
                setattr(subject, name, decode(value, self.refs))
                after = encode(getattr(subject, name))
                expected = encode(decode(value, self.refs))
                if after != expected and not (name == 'String' and self.doc.RecordChanges):
                    raise ValueError('Writer did not retain property ' + name)
                if name == 'String': after = expected
                if target not in self.scratch:
                    self.changes.append({'target': self.targets.get(target, target), 'property': name, 'before': before, 'after': after})
                if target in self.targets:
                    self.checks.append((self.targets[target], name, after))
            return None
        if op == 'create':
            self.mutate(); service = command.get('service', '')
            if (not isinstance(service, str) or not DOCUMENT_SERVICES.match(service) or ACTIVE_SERVICES.search(service)
                    or service not in self.doc.getAvailableServiceNames()):
                raise ValueError('Service is not an available document-local object factory')
            return self.save(self.doc.createInstance(service))
        if op == 'call':
            name, args = command.get('name'), command.get('args', [])
            if not self.method_allowed(obj, name): raise ValueError('Method is not a document-only capability: ' + str(name))
            if not isinstance(args, list) or len(args) > 20: raise ValueError('Too many native arguments')
            if name == 'setPropertyToDefault': check_name(args[0])
            if not READ_METHOD.match(name): self.mutate()
            result = getattr(obj, name)(*(decode(a, self.refs) for a in args))
            if not READ_METHOD.match(name): self.changes.append({'target': self.targets.get(target, target), 'method': name})
            saved = self.save(result)
            if name == 'createSearchDescriptor' and isinstance(saved, dict) and 'ref' in saved: self.scratch.add(saved['ref'])
            return saved
        if op == 'batch':
            self.mutate(); changes = edit(self.doc, command.get('operations'))
            self.changes.extend({k:v for k,v in c.items() if not k.startswith('_')} for c in changes)
            for c in changes:
                if 'property' in c: self.checks.append((c['target'], c['property'], c['after']))
            return changes
        if op == 'expect':
            # Expectations use persisted inspection addresses, not ephemeral native handles.
            selector = self.targets.get(target, target)
            resolve(self.doc, selector)
            for name, value in command.get('values', {}).items():
                check_name(name); actual = encode(getattr(property_object(obj, name), name))
                if actual != value: raise ValueError('Postcondition failed: ' + selector + '.' + name)
                self.checks.append((selector, name, value))
            return True
        if op == 'review':
            self.mutate()
            targets = command.get('targets', [target])
            if (not isinstance(targets, list) or not 1 <= len(targets) <= 1000 or
                    any(not isinstance(t, str) or not re.fullmatch(r'revision:[0-9]+', t) for t in targets)):
                raise ValueError('Review needs inspected revision targets')
            removed = review(self.doc, [int(t.partition(':')[2]) for t in targets], command.get('decision'))
            for author, kind, text in removed:
                tag = {'Insert':'ins', 'Delete':'del'}.get(kind)
                if tag: self.removed_review[(tag,author,text)] += 1
            self.changes.append({'targets': targets, 'review': command.get('decision')})
            return True
        raise ValueError('Unknown document console operation')


def verify_properties(doc, checks):
    for target, name, value in {(t,n):(t,n,v) for t,n,v in checks}.values():
        actual = encode(getattr(property_object(resolve(doc, target), name), name))
        if actual != value: raise ValueError('Export/reopen lost ' + target + '.' + name)


def emit(value):
    line = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(line.encode()) > 262144: raise ValueError('Native response too large; narrow the query')
    print(line, flush=True)


def transact(source, output, request, binary, interact):
    fresh = output is not None and not output.exists() and output.resolve() != source.resolve()
    source_hash = sha256(source.read_bytes()).hexdigest()
    readonly = request.get('read_only') is True
    mode = request.get('mode', 'tracked')
    if mode not in ('tracked', 'direct'): raise ValueError('Unknown console review mode')
    if request.get('snapshot') != source_hash: raise ValueError('Console needs the inspected source snapshot')
    if not readonly and not fresh: raise ValueError('Choose a new candidate path')
    before_parts, protected, original_paragraphs = package(source)
    author = 'Beaver ' + os.urandom(5).hex()
    proof = tempfile.TemporaryDirectory(prefix='beaver-proof-')
    baseline, control, rejected = [Path(proof.name, name+'.docx') for name in ('baseline','control','rejected')]
    try:
        with writer(binary, author) as (desktop, version):
            doc = load(desktop, source)
            broker = Broker(doc, readonly)
            try:
                # Baseline import/export must first preserve the original. Rich edits
                # never excuse destruction which happened merely by opening the file.
                if not readonly:
                    doc.storeToURL(baseline.resolve().as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
                    _, base_protected, base_paragraphs = package(baseline)
                    if protected != base_protected or original_paragraphs != base_paragraphs:
                        raise ValueError('This document does not survive a no-edit LibreOffice round trip')
                    normalized = load(desktop, baseline)
                    try: normalized.storeToURL(control.as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
                    finally: normalized.close(True)
                doc.RecordChanges = mode == 'tracked' and not readonly
                interact(broker, source_hash, version)
                if readonly:
                    return {'ok': True, 'snapshot': source_hash, 'engine_version': version, 'mode': 'read-only', 'native_calls': broker.calls}
                expected = native_state(doc)
                doc.storeToURL(output.resolve().as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
            finally: doc.close(True)
            after_parts, after_protected, _ = package(output)
            # Existing review/opaque content must survive unless an explicit review
            # operation intentionally resolved revisions. Other deletions fail closed.
            intentional_review = any('review' in c for c in broker.changes)
            if mode == 'tracked' and intentional_review and any('review' not in c for c in broker.changes):
                raise ValueError('Resolve existing revisions in a separate program from new edits')
            preserved = protected - broker.removed_review
            if preserved - after_protected: raise ValueError('Export lost existing review content, bindings or opaque assets')
            reopened = load(desktop, output)
            try:
                if native_state(reopened) != expected: raise ValueError('Export/reopen changed text, ordering or structural objects')
                revisions = [{'target': 'revision:'+str(i), 'author': r.RedlineAuthor,
                              'type': r.RedlineType, 'text': redline_text(r)[:2000]}
                             for i, r in ((i, reopened.Redlines.getByIndex(i)) for i in range(reopened.Redlines.Count))]
                new_indices = [i for i,r in enumerate(revisions) if r['author'] == author]
                if mode == 'tracked' and new_indices:
                    accepted = load(desktop, output)
                    try:
                        review(accepted, new_indices, 'accept')
                        verify_properties(accepted, broker.checks)
                    finally: accepted.close(True)
                else: verify_properties(reopened, broker.checks)
                if mode == 'tracked' and not intentional_review:
                    if new_indices: review(reopened, new_indices, 'reject')
                    reopened.RecordChanges = False
                    reopened.storeToURL(rejected.resolve().as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
                    before_state, rejected_state = semantic_package(control), semantic_package(rejected)
                    if before_state != rejected_state:
                        changed = [n for n in sorted(set(before_state)|set(rejected_state)) if before_state.get(n) != rejected_state.get(n)]
                        raise ValueError('Not every edit is natively reviewable; rejecting our changes leaves differences in ' + ', '.join(changed))
            finally: reopened.close(True)
        return {'ok': True, 'snapshot': source_hash, 'candidate_sha256': sha256(output.read_bytes()).hexdigest(),
                'engine_version': version, 'mode': mode + '-candidate', 'reopened': True,
                'review_verified': mode == 'tracked',
                'changes': broker.changes[:200], 'change_count': len(broker.changes),
                'changes_truncated': len(broker.changes)>200, 'native_calls': broker.calls,
                'revisions': revisions, 'author': author,
                'changed_parts': [n for n in sorted(set(before_parts)|set(after_parts)) if before_parts.get(n)!=after_parts.get(n)],
                'warning': 'LibreOffice compatibility and tested native postconditions, not universal Word-identical fidelity.'}
    except BaseException:
        if fresh: output.unlink(missing_ok=True)
        raise
    finally:
        proof.cleanup()


def serve(source, output, request, binary):
    def interact(broker, source_hash, version):
        emit({'rpc': 'ready', 'snapshot': source_hash, 'engine_version': version})
        while True:
            line = sys.stdin.readline(262145)
            if not line: raise ValueError('Console disconnected before completion')
            if len(line.encode()) > 262144: raise ValueError('Native request exceeds limit')
            command = json.loads(line)
            if not isinstance(command, dict): raise ValueError('Invalid native command')
            if command.get('op') == 'finish': return
            try: emit({'rpc': 'result', 'id': command.get('id'), 'value': broker.rpc(command)})
            except Exception as error:
                emit({'rpc': 'result', 'id': command.get('id'), 'error': str(error)[:1000]})
                raise  # All failures discard the draft, even if the guest catches its error.
    return transact(source, output, request, binary, interact)
