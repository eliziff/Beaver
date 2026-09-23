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
from urllib.parse import quote

from word_uno import (W, collection, resolve, resolve_many, encode, decode, check_name, check_value,
                      package, props, writer, load, inspect, properties, page, enumerate_values, STYLE_FAMILIES, PAGE_STORIES, page_story, revision_range)
import uno

# Discover document interfaces rather than maintaining a formatting catalogue.
# Application, storage and scripting interfaces are never console capabilities.
INTERFACES = ('com.sun.star.text.', 'com.sun.star.style.', 'com.sun.star.table.',
              'com.sun.star.drawing.', 'com.sun.star.container.')
METHODS = {
    'com.sun.star.beans.XPropertyState': {'getPropertyDefault', 'getPropertyState', 'getPropertyStates', 'setPropertyToDefault'},
    'com.sun.star.beans.XMultiPropertyStates': {'getPropertyStates', 'getPropertyDefaults', 'setPropertiesToDefault'},
    'com.sun.star.lang.XMultiServiceFactory': {'getAvailableServiceNames'},
    'com.sun.star.lang.XServiceInfo': {'supportsService', 'getSupportedServiceNames'},
    'com.sun.star.util.XSearchable': {'createSearchDescriptor', 'findAll', 'findFirst', 'findNext'},
    'com.sun.star.sheet.XCellRangeData': {'getDataArray', 'setDataArray'},
}
READ_METHOD = re.compile(r'^(?:get|has|is|supports|createTextCursor|createSearchDescriptor|createEnumeration|nextElement|find|goto|goLeft|goRight|collapse|compareRegion)')
DOCUMENT_SERVICES = re.compile(r'^com\.sun\.star\.(?:text|style|drawing)\.')
PAGE_LAYOUT = ('Width', 'Height', 'IsLandscape', 'LeftMargin', 'RightMargin')
ACTIVE_SERVICES = re.compile(r'OLE|Applet|Plugin|MediaShape|Script|Macro|Database|DDE|DataSource', re.I)


def semantic_package(path):
    """Rejecting new revisions must restore the no-edit round-trip control.

    Ignore only named volatile/inspection metadata, not document parts or
    formatting. A difference is a refusal, not an invitation to patch the XML.
    """
    volatile = {'rsidR', 'rsidRPr', 'rsidP', 'rsidSect', 'rsidDel', 'rsidRDefault', 'paraId', 'textId'}
    skip = {W + n for n in ('rsids', 'trackRevisions', 'proofState', 'revisionView', 'lastRenderedPageBreak', 'proofErr')}
    skip.update({'{http://purl.org/dc/terms/}modified',
                 '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}lastModifiedBy',
                 '{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}revision',
                 '{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}TotalTime'})
    # Selecting a revision can trigger layout and refresh these calculated counts.
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


def body_margins(style):
    """Word's top/bottom margins reach the body text; LibreOffice's stop at an enabled header/footer."""
    return {'TopMargin': style.TopMargin + (style.HeaderHeight if style.HeaderIsOn else 0),
            'BottomMargin': style.BottomMargin + (style.FooterHeight if style.FooterIsOn else 0)}


def page_text(story):
    # Pagination displays are calculated; retain field identity, not cached digits.
    paragraphs = []
    for _, node in enumerate_values(story):
        if node.supportsService('com.sun.star.text.TextTable'):
            paragraphs.append(('table', node.Name)); continue
        pieces = []
        for _, portion in enumerate_values(node):
            field = portion.TextField if portion.TextPortionType == 'TextField' else None
            kind = next((k for k in ('PageNumber', 'PageCount') if field and field.supportsService('com.sun.star.text.TextField.' + k)), None)
            pieces.append('\0' + kind if kind else portion.String)
        paragraphs.append(''.join(pieces))
    return paragraphs


def native_state(doc):
    """Ordered text/story and structural readback; not a complete OOXML validator."""
    # Page styles in use become Word sections and may be renamed on reopen.
    used = dict.fromkeys(node.PageStyleName for _, node in collection(doc, 'paragraph'))
    styles = doc.StyleFamilies.getByName('PageStyles')
    return {
        # Word tables have no names; LibreOffice renumbers them on reopen.
        'body': [('table', node.Rows.Count) if node.supportsService('com.sun.star.text.TextTable') else ('paragraph', node.String)
                 for _, node in enumerate_values(doc.Text)],
        'stories': {**{family: [(key, node.String) for key, node in collection(doc, family)]
                       for family in ('footnote', 'endnote', 'frame')},
                    # An empty header equals none: Word sections otherwise inherit the previous one.
                    **{family + ':' + str(order): text for order, name in enumerate(used) for family in PAGE_STORIES
                       if (story := page_story(styles.getByName(name), family, include_shared=True)) is not None
                       and any(text := page_text(story))}},
        'tables': sorted((tuple((cell, table.getCellByName(cell).String) for cell in table.getCellNames()), table.Rows.Count)
                         for _, table in collection(doc, 'table')),
        'bookmarks': [(name, bookmark.Anchor.String) for name, bookmark in collection(doc, 'bookmark')],
        'drawings': [(name, shape.ShapeType, encode(shape.Position), encode(shape.Size)) for name, shape in collection(doc, 'drawing')],
        'revisions': [(r.RedlineAuthor, r.RedlineType, revision_range(r).String) for _, r in collection(doc, 'revision')],
    }


def review(doc, indices, decision):
    if decision not in ('accept', 'reject'): raise ValueError('Review must accept or reject named changes')
    selected = [doc.Redlines.getByIndex(i) for i in sorted(set(indices), reverse=True)]
    signatures = lambda: Counter((r.RedlineAuthor, r.RedlineType, revision_range(r).String) for _,r in collection(doc, 'revision'))
    removed = [(r.RedlineAuthor, r.RedlineType, revision_range(r).String) for r in selected]
    expected = signatures() - Counter(removed)
    ctx = uno.getComponentContext()
    dispatcher = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.DispatchHelper', ctx)
    for r in selected:
        doc.CurrentController.select(revision_range(r))
        count = doc.Redlines.Count
        dispatcher.executeDispatch(doc.CurrentController.Frame,
            '.uno:AcceptTrackedChange' if decision == 'accept' else '.uno:RejectTrackedChange', '', 0, ())
        if doc.Redlines.Count >= count: raise ValueError('Writer did not resolve the selected revision')
    if signatures() != expected: raise ValueError('Writer resolved a revision outside the requested selection')
    return removed


def unique_range(doc, scope, text, prefix=None):
    """Select exact native text; validate cursor movement, never trust text offsets."""
    if prefix is None:
        if not isinstance(text, str) or not text or len(text) > 10000 or any(c in text for c in '\r\n\t'):
            raise ValueError('find needs 1-10000 literal characters inside a paragraph')
        prefix, match, suffix = scope.String.partition(text)
        if not match or text in suffix: raise ValueError('Replacement target is missing or ambiguous')
    owner = scope.getText() if hasattr(scope, 'getText') else scope
    cursor = owner.createTextCursorByRange(scope.Start)
    # This also reaches first/left page stories excluded from document search.
    # Native cursor units can differ at fields/Unicode: read back BOTH ranges.
    for part in (prefix, text):
        cursor.collapseToEnd()
        if not all(cursor.goRight(min(32767, len(part)-i), True) for i in range(0, len(part), 32767)) or cursor.String != part: break
    else:
        if owner.compareRegionEnds(scope.End, cursor.End) <= 0: return cursor
    search = doc.createSearchDescriptor()
    search.SearchString, search.SearchCaseSensitive, search.SearchRegularExpression = text, True, False
    found = doc.findNext(scope.Start, search)
    for _ in range(10000):
        try: inside = found is not None and owner.compareRegionStarts(scope.Start, found.Start) >= 0 and owner.compareRegionEnds(scope.End, found.End) <= 0
        except Exception: inside = False
        if not inside: break
        before = owner.createTextCursorByRange(scope.Start); before.gotoRange(found.Start, True)
        if before.String == prefix and found.String == text: return found
        if len(before.String) > len(prefix): break
        found = doc.findNext(found.End, search)
    raise ValueError('Native search is missing or ambiguous inside the exact target')


class Broker:
    def __init__(self, doc, readonly=False):
        self.doc, self.readonly = doc, readonly
        self.refs, self.targets, self.changes, self.checks = {'doc': doc}, {}, [], {}
        self.find_scopes, self.resets = {}, {}
        self.scratch = set()
        self.metadata = {}
        self.removed_review = Counter()
        self.unsaved = []
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

    def info(self, obj):
        key = id(obj)
        if key not in self.metadata: self.metadata[key] = (obj, self.introspection.inspect(obj))
        return self.metadata[key][1]

    def method_allowed(self, obj, name, method=None):
        if name == 'printPages': return False
        try:
            check_name(name)
            declaring = (method or self.info(obj).getMethod(name, -1)).DeclaringClass.Name
            return declaring.startswith(INTERFACES) or name in METHODS.get(declaring, ())
        except Exception: return False

    def mutate(self):
        if self.readonly: raise ValueError('This console is read-only')

    def rpc(self, command):
        self.calls += 1
        if self.calls > 4000: raise ValueError('Native operation budget exhausted')
        op, target = command.get('op'), command.get('target', 'doc')
        if op == 'target' and isinstance(target, list):
            if not 1 <= len(target) <= 1000: raise ValueError('Select 1-1000 targets')
            resolved = resolve_many(self.doc, target)
            return [self.save(resolved[t], t) for t in target]
        obj = self.refs[target] if target in self.refs else resolve(self.doc, target)
        if op == 'target': return self.save(obj, target)
        if op == 'inspect':
            query = command.get('query', {})
            if not isinstance(query, dict): raise ValueError('Inspection requires an object')
            return inspect(self.doc, query)
        if op == 'describe':
            offset, limit = command.get('offset', 0), command.get('limit', 50)
            if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 100: raise ValueError('Invalid metadata page')
            info = self.info(obj); patterns = str(command.get('filter', '')).lower().split('|')
            matches = lambda name: any(p in name.lower() for p in patterns)
            members = [('property', p) for p in info.getProperties(-1) if matches(p.Name)] + [
                ('method', m) for m in info.getMethods(-1) if matches(m.Name) and self.method_allowed(obj, m.Name, m)]
            rows = []
            # Signatures and values are expensive remote objects: expand only this page.
            for kind, member in members[offset:offset + limit]:
                row = {'kind': kind, 'name': member.Name}
                if kind == 'property':
                    row.update(type=member.Type.typeName, writable=False)
                    try:
                        check_name(member.Name)
                        row['writable'] = not bool(member.Attributes & 16)
                        if command.get('values'): row['value'] = encode(properties(obj, [member.Name])[member.Name])
                    except Exception: row['unavailable'] = True
                else: row.update(returns=member.ReturnType.Name,
                    arguments=[{'name': p.aName, 'type': p.aType.Name, 'mode': str(p.aMode)} for p in member.ParameterInfos])
                rows.append(row)
            return {'items': rows, 'total': len(members), 'next_offset': offset + limit if offset + limit < len(members) else None}
        if op == 'find':
            found = unique_range(self.doc, obj, command.get('text'))
            self.find_scopes[found] = self.find_scopes.get(obj, obj)
            return self.save(found)
        if op == 'items':
            names = command.get('properties', [])
            if not isinstance(names, list) or len(names) > 32: raise ValueError('Select at most 32 properties')
            for name in names: check_name(name)
            entries, pagination = page(lambda start: enumerate_values(obj, start), command)
            return {'items': [{'name': name, 'value': self.save(value),
                **({'properties': self.save(properties(value, names))} if names else {})}
                for name, value in entries], **pagination}
        if op in ('get', 'state', 'default'):
            names = command['name']
            selected = names if isinstance(names, list) else [names]
            if not 1 <= len(selected) <= 32: raise ValueError('get needs 1-32 properties')
            result = self.save(properties(obj, selected, operation=op))
            return result if isinstance(names, list) else result[names]
        if op in ('set', 'reset'):
            if target not in self.scratch: self.mutate()
            names = command.get('names', [])
            if op == 'reset' and (not isinstance(names, list) or not 1 <= len(names) <= 100):
                raise ValueError('reset requires 1-100 property names')
            values = command.get('values') if op == 'set' else dict.fromkeys(names)
            if not isinstance(values, dict) or not 1 <= len(values) <= 100: raise ValueError('set/reset requires 1-100 properties')
            for name, value in values.items(): check_value(name, value)
            requested = {name: decode(value, self.refs) for name, value in values.items()}
            after = {name: encode(value) for name, value in properties(obj, values,
                values=requested, operation=op).items()}
            if op == 'set':
                expected = {name: encode(value) for name, value in requested.items()}
                if 'String' in expected and self.doc.RecordChanges: after['String'] = expected['String']
                if after != expected: raise ValueError('Writer did not retain requested properties')
                self.resets.get(obj, set()).difference_update(values)
                if target in self.targets or obj in self.find_scopes:
                    self.checks.setdefault(obj, {}).update({name: value for name, value in after.items()
                        if name != 'String' or obj not in self.find_scopes})
            elif target not in self.scratch:
                self.resets.setdefault(obj, set()).update(values)
                for name in values: self.checks.get(obj, {}).pop(name, None)
            if target not in self.scratch:
                self.changes.append({'target': self.targets.get(target, target), op: list(values)})
            return None
        if op == 'constant':
            name = command.get('name', '')
            if not isinstance(name, str) or not re.fullmatch(r'com\.sun\.star\.(?:text|style|table|drawing|awt|lang)\.[A-Za-z0-9_.]+', name):
                raise ValueError('Constant is outside document types')
            return encode(uno.getConstantByName(name))
        if op == 'create':
            self.mutate(); service = command.get('service', '')
            if (not isinstance(service, str) or not DOCUMENT_SERVICES.match(service) or ACTIVE_SERVICES.search(service)
                    or service not in self.doc.getAvailableServiceNames()):
                raise ValueError('Service is not an available document-local object factory')
            return self.save(self.doc.createInstance(service))
        if op == 'call':
            name, args = command.get('name'), command.get('args', [])
            if not isinstance(args, list) or len(args) > 20: raise ValueError('Too many native arguments')
            # Native property/factory interfaces share the checked property and create paths.
            if name == 'createInstance' and len(args) == 1:
                return self.rpc({'op': 'create', 'service': args[0]})
            if name in ('setPropertyValue', 'setPropertyValues', 'setParentStyle'):
                values = ({'ParentStyle': args[0]} if name == 'setParentStyle' and len(args) == 1 else
                          {args[0]: args[1]} if name == 'setPropertyValue' and len(args) == 2 else
                          dict(zip(args[0], args[1])) if len(args) == 2 and all(isinstance(a, list) for a in args) and len(args[0]) == len(args[1]) else None)
                if values is None: raise ValueError(name + ' has the wrong arguments')
                return self.rpc({'op': 'set', 'target': target, 'values': values})
            aliases = {'getPropertyValue': 'get', 'getPropertyValues': 'get', 'getPropertyDefaults': 'default', 'getPropertyDefault': 'default',
                       'getPropertyState': 'state', 'getPropertyStates': 'state', 'setPropertyToDefault': 'reset', 'setPropertiesToDefault': 'reset'}
            if name in aliases:
                if len(args) != 1: raise ValueError('Property access requires one name or name list')
                plural = name in ('getPropertyValues', 'getPropertyStates', 'getPropertyDefaults', 'setPropertiesToDefault')
                names = args[0] if plural else [args[0]]
                if not isinstance(names, list): raise ValueError('Property access requires a property-name list')
                result = self.rpc({'op': aliases[name], 'target': target, 'names': names, 'name': names})
                if aliases[name] == 'reset': return result
                return [result[n] for n in names] if plural else result[names[0]]
            if not self.method_allowed(obj, name):
                try: self.info(obj).getMethod(str(name), -1)
                except Exception: raise ValueError('This object has no native method ' + str(name) + '; describe(filter) lists its members') from None
                raise ValueError('Method is not a document-only capability: ' + str(name))
            if not READ_METHOD.match(name): self.mutate()
            result = uno.invoke(obj, name, tuple(decode(a, self.refs) for a in args))
            if not READ_METHOD.match(name): self.changes.append({'target': self.targets.get(target, target), 'method': name})
            saved = self.save(result)
            if name == 'createSearchDescriptor' and isinstance(saved, dict) and 'ref' in saved: self.scratch.add(saved['ref'])
            return saved
        if op == 'expect':
            values = command.get('values')
            if not isinstance(values, dict) or not 1 <= len(values) <= 100: raise ValueError('expect requires 1-100 properties')
            actual = {name: encode(value) for name, value in properties(obj, values).items()}
            if actual != values: raise ValueError('Postcondition failed: ' + str(target))
            self.checks.setdefault(obj, {}).update(values)
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
            self.changes.append({'review': command.get('decision'), 'count': len(removed)})
            return True
        raise ValueError('Unknown document console operation')


def freeze_checks(broker):
    """Bind live objects to final addresses, not indexes captured before edits."""
    for obj, names in broker.resets.items():
        if names:
            if any(state.value != 'DEFAULT_VALUE' for state in properties(obj, names, operation='state').values()):
                raise ValueError('A formatting reset was overridden; set its final properties explicitly')
            broker.checks.setdefault(obj, {}).update({n: encode(v) for n, v in properties(obj, names).items()})
    if not broker.checks: return [], []
    pending = {broker.find_scopes.get(obj, obj) for obj in broker.checks}
    addresses = {}
    def remember(target, obj):
        # Newly attached note factories can have a different UNO identity from
        # their collection entry; compare their actual reference ranges.
        matches = [obj] if obj in pending else []
        family = target.partition(':')[0]
        if family in STYLE_FAMILIES:
            service = 'com.sun.star.style.' + STYLE_FAMILIES[family][:-1]
            matches.extend(wanted for wanted in pending if wanted not in matches
                and hasattr(wanted, 'supportsService') and wanted.supportsService(service)
                and wanted.Name == obj.Name)
        if target.startswith(('footnote:', 'endnote:')):
            for wanted in pending:
                if not hasattr(wanted, 'supportsService') or not wanted.supportsService('com.sun.star.text.Footnote'): continue
                a, b = wanted.Anchor, obj.Anchor
                try:
                    owner = a.getText()
                    if wanted not in matches and owner.compareRegionStarts(a, b) == 0 and owner.compareRegionEnds(a, b) == 0: matches.append(wanted)
                except Exception: pass
        for wanted in matches:
            addresses[wanted] = target
            pending.remove(wanted)
    # Named targets resolve directly; bind all paragraph indexes in one pass.
    for ref, target in broker.targets.items():
        obj = broker.refs[ref]
        if obj in pending and not target.startswith('paragraph:'):
            try:
                remember(target, resolve(broker.doc, target))
            except Exception: pass
    remember('document:root', broker.doc)
    remember('body:root', broker.doc.Text)
    for family in ('paragraph', 'table', 'footnote', 'endnote', 'frame', 'bookmark',
                   *STYLE_FAMILIES, *PAGE_STORIES, 'drawing', 'field', 'section', 'index', 'control'):
        if not pending: break
        for name, obj in collection(broker.doc, family):
            target = family + ':' + quote(name, safe='')
            remember(target, obj)
            if family == 'table':
                for cell in obj.getCellNames():
                    remember('cell:' + quote(name, safe='') + '/' + quote(cell, safe=''), obj.getCellByName(cell))
            if not pending: break
    if pending: raise ValueError('Postcondition object was removed or has no persistent document address')
    accepted, raw, pages = [], [], {}
    def portable(obj, address, values, defaults):
        """Word keeps sections and lists, not LibreOffice page/list style names.

        Unused page styles are not saved. Used ones are checked through a paragraph
        they lay out; applied page styles by their layout; list names by labels.
        """
        values, checks = dict(values), []
        if values.get('NumberingStyleName') or 'NumberingRules' in values:
            values.pop('NumberingStyleName', None); values.pop('NumberingRules', None)
            if hasattr(obj, 'ListLabelString'): values['ListLabelString'] = obj.ListLabelString
        if not pages:
            for index, node in collection(broker.doc, 'paragraph'): pages.setdefault(node.PageStyleName, 'paragraph:' + index)
        if address.startswith('page-style:'):
            if not obj.isInUse(): broker.unsaved.append(address); return []
            if obj.Name in pages: address = 'page-style:' + pages[obj.Name]
            values.update({name: value for name, value in body_margins(obj).items() if name in values})
        if values.get('PageDescName') and address.startswith('paragraph:'):
            style = broker.doc.StyleFamilies.getByName('PageStyles').getByName(values.pop('PageDescName'))
            checks.append(('page-style:' + address, None, None, {**{name: getattr(style, name) for name in PAGE_LAYOUT}, **body_margins(style)}, ()))
        return checks + ([(address, None, None, values, defaults)] if values or defaults else [])
    for obj, values in broker.checks.items():
        if obj not in broker.find_scopes:
            # Formatting/explicit expectations describe the actual redline view.
            # Only a tracked String setter can require an accepted-view check.
            if broker.doc.RecordChanges and 'String' in values and properties(obj, ['String'])['String'] != values['String']:
                accepted.append((addresses[obj], None, None, {'String': values['String']}, ()))
                values = {name: value for name, value in values.items() if name != 'String'}
            raw.extend(portable(obj, addresses[obj], values, tuple(broker.resets.get(obj, ()))))
            continue
        scope, text = broker.find_scopes[obj], obj.String
        if not text: raise ValueError('An empty selection has no persistent formatting to verify')
        owner = scope.getText() if hasattr(scope, 'getText') else scope
        prefix = owner.createTextCursorByRange(scope.Start); prefix.gotoRange(obj.Start, True)
        raw.append((addresses[scope], prefix.String, text, values, tuple(broker.resets.get(obj, ()))))
    return accepted, raw


def verify_properties(doc, checks):
    scopes = resolve_many(doc, (check[0] for check in checks))
    for target, prefix, text, values, defaults in checks:
        obj = scopes[target]
        if prefix is not None: obj = unique_range(doc, obj, text, prefix)
        actual = {name: encode(value) for name, value in properties(obj, values).items()}
        if target.startswith('page-style:'): actual.update({name: value for name, value in body_margins(obj).items() if name in values})
        if actual != values:
            lost = {name: {'expected': values[name], 'actual': actual.get(name)} for name in values if actual.get(name) != values[name]}
            raise ValueError('Export/reopen lost properties at ' + target + ': ' + json.dumps(lost)[:400])
        if any(state.value != 'DEFAULT_VALUE' for state in properties(obj, defaults, operation='state').values()):
            raise ValueError('Export/reopen restored direct formatting at ' + target)


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
    snapshot = request.get('snapshot')
    if snapshot != source_hash and not (readonly and snapshot is None):
        raise ValueError('Stale snapshot; console needs the inspected source snapshot')
    if not readonly and not fresh: raise ValueError('Choose a new candidate path')
    before_parts, protected, original_paragraphs = package(source)
    author = 'Beaver ' + os.urandom(5).hex()
    try:
        with tempfile.TemporaryDirectory(prefix='beaver-proof-') as proof, writer(binary, author) as (desktop, version):
            baseline, control, rejected = [Path(proof, name+'.docx') for name in ('baseline','control','rejected')]
            doc = load(desktop, source)
            broker = Broker(doc, readonly)
            try:
                if not readonly:
                    doc.storeToURL(baseline.resolve().as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
                    _, base_protected, base_paragraphs = package(baseline)
                    if protected != base_protected or original_paragraphs != base_paragraphs:
                        raise ValueError('This document does not survive a no-edit LibreOffice round trip')
                doc.RecordChanges = mode == 'tracked' and not readonly
                result = interact(broker, source_hash, version)
                if readonly:
                    return {**(result or {}), 'ok': True, 'snapshot': source_hash, 'engine_version': version, 'mode': 'read-only', 'native_calls': broker.calls}
                checks, raw_checks = freeze_checks(broker)
                expected = native_state(doc)
                doc.storeToURL(output.resolve().as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
            finally: doc.close(True)
            after_parts, after_protected, _ = package(output)
            intentional_review = any('review' in c for c in broker.changes)
            if mode == 'tracked' and intentional_review and any('review' not in c for c in broker.changes):
                raise ValueError('Resolve existing revisions in a separate program from new edits')
            preserved = protected - broker.removed_review
            if preserved - after_protected: raise ValueError('Export lost existing review content, bindings or opaque assets')
            reopened = load(desktop, output)
            try:
                state = native_state(reopened)
                if state != expected:
                    changed = [key for key in expected if state[key] != expected[key]]
                    raise ValueError('Export/reopen changed ' + ', '.join(changed) + ': ' + str([(state[k], expected[k]) for k in changed])[:600])
                new_indices = [i for i, (who, _, _) in enumerate(expected['revisions']) if who == author]
                verify_properties(reopened, raw_checks)
                if mode == 'tracked' and new_indices and checks:
                    accepted = load(desktop, output)
                    try:
                        review(accepted, new_indices, 'accept')
                        verify_properties(accepted, checks)
                    finally: accepted.close(True)
                else: verify_properties(reopened, checks)
                if mode == 'tracked' and not intentional_review:
                    normalized = load(desktop, baseline)
                    try: normalized.storeToURL(control.as_uri(), props(FilterName='Office Open XML Text', Overwrite=False))
                    finally: normalized.close(True)
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
                'changes': broker.changes[:20], 'change_count': len(broker.changes),
                'changes_truncated': len(broker.changes)>20, 'native_calls': broker.calls,
                **({'unused_page_styles_not_saved': broker.unsaved} if broker.unsaved else {}),
                'revision_count': len(expected['revisions']), 'new_revision_count': len(new_indices), 'author': author,
                'changed_parts': [n for n in sorted(set(before_parts)|set(after_parts)) if before_parts.get(n)!=after_parts.get(n)],
                'warning': 'LibreOffice compatibility and tested native postconditions, not universal Word-identical fidelity.'}
    except BaseException:
        if fresh: output.unlink(missing_ok=True)
        raise


def serve(source, output, request, binary):
    action = request.get('action', 'inspect')
    if action not in ('console', 'inspect', 'describe'): raise ValueError('Unknown action')
    if action != 'console': request = {**request, 'read_only': True}
    def interact(broker, source_hash, version):
        if action == 'describe':
            # Without a target, describe the family's first object.
            target = request.get('target')
            if not target:
                family = request.get('family', 'document')
                first = next(collection(broker.doc, family), None)
                if first is None: raise ValueError('No ' + family + ' object to describe')
                target = family + ':' + quote(first[0], safe='')
            return {'target': target, **broker.rpc({**request, 'target': target, 'op': 'describe', 'values': True})}
        if action != 'console': return inspect(broker.doc, request)
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
                member = command.get('name') if isinstance(command.get('name'), str) else command.get('op')
                # Writer's message for a descriptor that was never inserted or was since removed.
                reason = ('the object is not in the document; insert new content with insertTextContent before using it'
                          if 'Lost connection to core objects' in str(error) else str(error))
                emit({'rpc': 'result', 'id': command.get('id'), 'error': (str(member) + ': ' + reason)[:1000]})
                raise
    return transact(source, output, request, binary, interact)
