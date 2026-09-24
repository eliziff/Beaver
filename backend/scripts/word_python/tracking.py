"""Review-mode recorder: turns ordinary python-docx edits into native Word revisions.

Recorder(roots) tags every structural element before the model program runs;
record() compares afterwards. Removed content returns as w:del at its old place,
new content is wrapped in w:ins, changed properties gain w:*PrChange and
plain-text paragraphs are re-diffed word by word. The separate verifier, not this
module, decides whether rejecting the revisions restores the source.
"""
from __future__ import annotations
import bisect
import copy
import difflib
import re
from datetime import datetime, timezone

from lxml import etree

from ooxml import RUN_WRAPPERS, TEXTUAL, canon, w

PROPS_OF = {w('p'): w('pPr'), w('tbl'): w('tblPr'), w('tr'): w('trPr'), w('tc'): w('tcPr')}
PROPERTY = {w(t) for t in ('pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblGrid', 'sdtPr', 'tblPrEx', 'sdtEndPr')}
MARKERS = {w(t) for t in ('bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'proofErr', 'permStart', 'permEnd')}
SPACE = '{http://www.w3.org/XML/1998/namespace}space'


class Untrackable(ValueError):
    pass


def _without(node, *tags):
    if node is None: return None
    node = copy.deepcopy(node)
    for child in [c for c in node if c.tag in tags]: node.remove(child)
    return node


def _signature(el):
    if el.tag == w('p'):
        ppr = el.find(w('pPr'))
        mark = None if ppr is None else ppr.find(w('rPr'))
        return canon(_without(ppr, w('rPr'), w('sectPr'), w('pPrChange'))), canon(_without(mark, *RUN_WRAPPERS, w('rPrChange')))
    if el.tag == w('r'):
        return canon(_without(el.find(w('rPr')), w('rPrChange'))), canon(_without(el, w('rPr')))
    if el.tag == w('tbl'):
        return canon(_without(el.find(w('tblPr')), w('tblPrChange'))), canon(_without(el.find(w('tblGrid')), w('tblGridChange')))
    if el.tag in (w('tr'), w('tc')):
        props = el.find(PROPS_OF[el.tag])
        return (canon(_without(props, w(etree.QName(props).localname + 'Change'), *RUN_WRAPPERS)) if props is not None else '',
                canon(props.find(w('ins')) if props is not None else None))
    if el.tag == w('sectPr'): return canon(_without(el, w('headerReference'), w('footerReference'), w('sectPrChange'))),
    return canon(etree.Element(el.tag, dict(el.attrib))),


def _simple_text(run):
    """Text of a run holding only text-like children, else None."""
    out = []
    for c in run:
        if c.tag == w('rPr'): continue
        if c.tag not in TEXTUAL or (c.tag == w('br') and c.get(w('type')) not in (None, 'textWrapping')): return None
        out.append((c.text or '') if TEXTUAL[c.tag] is None else TEXTUAL[c.tag])
    return ''.join(out)


def _lis(values):
    """Indices of one longest increasing subsequence."""
    tails, tails_idx, prev = [], [], [-1] * len(values)
    for i, v in enumerate(values):
        j = bisect.bisect_left(tails, v)
        if j == len(tails): tails.append(v); tails_idx.append(i)
        else: tails[j] = v; tails_idx[j] = i
        prev[i] = tails_idx[j - 1] if j else -1
    out, i = set(), tails_idx[-1] if tails_idx else -1
    while i != -1: out.add(i); i = prev[i]
    return out


class Recorder:
    def __init__(self, roots, author='Beaver'):
        self.roots, self.author = roots, author
        self.date = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.snap, self.order, self.warnings = {}, {}, []
        ids = [int(v) for r in roots for n in r.iter(etree.Element) for v in [n.get(w('id'))] if v and v.lstrip('-').isdigit()]
        self.next_id = 1 + max(ids or [0])
        self.keys, self.done, self.alive = {}, {}, []   # identity maps; `alive` pins lxml proxies
        tagged, count = [], 0

        def visit(node, parent):
            nonlocal count
            kids = []
            for child in node:
                if not isinstance(child.tag, str): continue
                target = child.find(w('sectPr')) if child.tag == w('pPr') else None if child.tag in PROPERTY else child
                if target is None: continue
                count += 1; key = str(count)
                self._tag(target, key); kids.append(key); tagged.append((target, key, parent))
                if target.tag not in (w('r'), w('sectPr')): visit(target, key)
            if kids: self.order[parent] = kids
        for root in roots: visit(root, id(root))
        for el, key, parent in tagged:
            clone = copy.deepcopy(el)
            for original, twin in zip(el.iter(), clone.iter()):   # the snapshot copy knows descendant keys
                if self._k(original): self._tag(twin, self._k(original))
            self.snap[key] = {'tag': el.tag, 'parent': parent, 'sig': _signature(el), 'el': clone}

    def _k(self, el):
        return self.keys.get(id(el))

    def _tag(self, el, key):
        self.keys[id(el)] = key; self.alive.append(el)

    def _done(self, el, kind='1'):
        self.done[id(el)] = kind; self.alive.append(el)

    # ---- revision primitives ----------------------------------------------
    def _rev(self, tag):
        node = etree.Element(w(tag), {w('id'): str(self.next_id), w('author'): self.author, w('date'): self.date})
        self.next_id += 1
        self._done(node, 'ours')
        return node

    @staticmethod
    def _props(holder, name):
        props = holder.find(w(name))
        if props is None:
            props = etree.Element(w(name))
            prex = holder.find(w('tblPrEx')) if name == 'trPr' else None
            prex.addnext(props) if prex is not None else holder.insert(0, props)
        return props

    def _mark_rpr(self, p):
        ppr = self._props(p, 'pPr')
        rpr = ppr.find(w('rPr'))
        if rpr is None:
            rpr = etree.Element(w('rPr'))
            tail = next((c for c in ppr if c.tag in (w('sectPr'), w('pPrChange'))), None)
            tail.addprevious(rpr) if tail is not None else ppr.append(rpr)
        return rpr

    def _mark_paragraph(self, p, kind):
        rpr = self._mark_rpr(p)
        if rpr.find(w('ins')) is None and rpr.find(w('del')) is None: rpr.insert(0, self._rev(kind))

    def _deleted_run(self, run):
        run = copy.deepcopy(run)
        for t in run.iter(w('t')): t.tag = w('delText')
        for t in run.iter(w('instrText')): t.tag = w('delInstrText')
        wrapper = self._rev('del'); wrapper.append(run)
        return wrapper

    def _deleted(self, el):
        """A restored copy of removed content, marked as a tracked deletion."""
        el = copy.deepcopy(el)
        if el.tag == w('r'): return self._deleted_run(el)
        if el.tag == w('tc'): raise Untrackable('Removing table cells or columns cannot be tracked; delete whole rows or ask for direct editing')
        if el.tag in RUN_WRAPPERS or el.tag in MARKERS or el.tag == w('sectPr'):
            if el.tag not in (w('proofErr'),):
                self.warnings.append('kept removed <%s>: existing revisions, bookmarks and section breaks are not deleted in Review mode' % etree.QName(el).localname)
            self._done(el)
            return el
        for run in [r for r in el.iter(w('r')) if not any(a.tag in RUN_WRAPPERS for a in r.iterancestors())]:
            run.addprevious(self._deleted_run(run)); run.getparent().remove(run)
        for p in list(el.iter(w('p'))):
            if not any(a.tag == w('tc') for a in p.iterancestors()) or p.getnext() is not None: self._mark_paragraph(p, 'del')
        for tr in [el] if el.tag == w('tr') else list(el.iter(w('tr'))):
            trpr = self._props(tr, 'trPr')
            if trpr.find(w('del')) is None: trpr.append(self._rev('del'))
        self._done(el)
        return el

    def _change(self, holder, name, original):
        """Record that properties <name> of holder changed from `original` (its old container)."""
        change_name = name + 'Change'
        props = holder if name == 'sectPr' else self._props(holder, name) if name != 'markrPr' else self._mark_rpr(holder)
        if name == 'markrPr': change_name, name = 'rPrChange', 'rPr'
        if props.find(w(change_name)) is not None: return
        drop = ({w('rPr'), w('sectPr'), w('pPrChange')} if name == 'pPr' else
                {w('headerReference'), w('footerReference'), w('sectPrChange')} if name == 'sectPr' else
                RUN_WRAPPERS | {w(change_name)})
        change = self._rev(change_name)
        inner = etree.SubElement(change, w(name))
        for child in original if original is not None else []:
            if child.tag not in drop: inner.append(copy.deepcopy(child))
        props.append(change)

    # ---- word diff of plain-text paragraphs ------------------------------
    @staticmethod
    def _inline(p):
        items = []
        for child in p:
            if child.tag == w('pPr'): continue
            if child.tag in MARKERS or (child.tag == w('r') and [c.tag for c in child if c.tag != w('rPr')] == [w('commentReference')]):
                items.append(('mark', child)); continue
            text = _simple_text(child) if child.tag == w('r') else None
            if text is None: return None
            items.append(('run', child, text))
        return items

    def _diff_paragraph(self, p, original):
        now, before = self._inline(p), self._inline(original)
        if now is None or before is None: return False

        def chars(items):
            out, marks = [], []
            for item in items:
                if item[0] == 'mark': marks.append((len(out), item[1])); continue
                rpr = item[1].find(w('rPr'))
                out.extend((ch, rpr) for ch in item[2])
            return out, marks
        (a, a_marks), (b, b_marks) = chars(before), chars(now)
        fmt = lambda rpr: canon(_without(rpr, w('rPrChange')))
        if ([c for c, _ in a] == [c for c, _ in b] and all(fmt(x[1]) == fmt(y[1]) for x, y in zip(a, b))
                and [self._k(m) for _, m in a_marks] == [self._k(m) for _, m in b_marks]):
            return True
        tok = lambda s: re.findall(r'\w+|\s+|[^\w\s]', s)
        ta, tb = tok(''.join(c for c, _ in a)), tok(''.join(c for c, _ in b))
        oa, ob = [0], [0]
        for t in ta: oa.append(oa[-1] + len(t))
        for t in tb: ob.append(ob[-1] + len(t))
        kept = {self._k(m) for _, m in b_marks}
        pend_b = list(b_marks)
        pend_a = [(i, copy.deepcopy(m)) for i, m in a_marks if self._k(m) not in kept]
        out = []

        def marks(pending, upto):
            while pending and pending[0][0] <= upto: out.append(pending.pop(0)[1])

        def runs(seq, wrapper=None, originals=None):
            groups = []
            for index, (ch, rpr) in enumerate(seq):
                old = originals[index] if originals else None
                key = (fmt(rpr), fmt(old) if old is not None or originals else None)
                if groups and groups[-1][0] == key: groups[-1][2].append(ch)
                else: groups.append((key, (rpr, old), [ch]))
            for key, (rpr, old), text in groups:
                run = etree.Element(w('r'))
                if rpr is not None: run.append(_without(rpr, w('rPrChange')))
                if originals and key[0] != key[1]: self._change(run, 'rPr', old)
                for piece in re.split(r'(\t|\n)', ''.join(text)):
                    if piece == '\t': etree.SubElement(run, w('tab'))
                    elif piece == '\n': etree.SubElement(run, w('br'))
                    elif piece:
                        t = etree.SubElement(run, w('delText' if wrapper == 'del' else 't')); t.text = piece; t.set(SPACE, 'preserve')
                if wrapper:
                    node = self._rev(wrapper); node.append(run); out.append(node)
                else:
                    self._done(run); out.append(run)
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ta, tb, autojunk=False).get_opcodes():
            ca, cb, da, db = oa[i1], oa[i2], ob[j1], ob[j2]
            marks(pend_b, da); marks(pend_a, ca)
            if op == 'equal':
                k = 0
                while k < db - da:
                    marks(pend_b, da + k); marks(pend_a, ca + k)
                    stops = [m[0] - da for m in pend_b if m[0] - da > k] + [m[0] - ca for m in pend_a if m[0] - ca > k]
                    end = min([db - da] + stops)
                    runs(b[da + k:da + end], originals=[x[1] for x in a[ca + k:ca + end]])
                    k = end
            if op in ('delete', 'replace'): runs(a[ca:cb], 'del')
            if op in ('insert', 'replace'): runs(b[da:db], 'ins')
        marks(pend_b, len(b)); marks(pend_a, len(a))
        for child in [c for c in p if c.tag != w('pPr')]: p.remove(child)
        for node in out: p.append(node)
        return True

    # ---- main pass ----------------------------------------------------------
    def record(self):
        roots = {id(r): r for r in self.roots}
        present = {}
        for root in self.roots:   # copies made by the program are untagged, hence new content
            present.update((self._k(el), el) for el in root.iter(etree.Element) if self._k(el))
        manual = lambda el: any(a.tag in RUN_WRAPPERS and self._k(a) is None and id(a) not in self.done for a in el.iterancestors())

        def forget(el):
            for n in el.iter(etree.Element):
                present.pop(self._k(n), None); self.keys.pop(id(n), None)
        # Moved content (new parent or order) becomes a deletion plus an insertion.
        for key, el in list(present.items()):
            if key not in present or manual(el): continue
            parent = el.getparent()
            if el.tag == w('sectPr') and parent.tag == w('pPr'): parent = parent.getparent()
            now = self._k(parent) or (id(parent) if id(parent) in roots else None)
            if now != self.snap[key]['parent']: forget(el)
        for parent, kids in self.order.items():
            holder = roots.get(parent) if isinstance(parent, int) else present.get(parent)
            if holder is None: continue
            wanted = set(k for k in kids if k in present)
            actual = [self._k(c) for c in holder.iter(etree.Element) if c is not holder and self._k(c) in wanted]
            rank = {k: i for i, k in enumerate(kids)}
            keep = _lis([rank[k] for k in actual])
            for index, k in enumerate(actual):
                if index not in keep and k in present: forget(present[k])
        # Plain-text paragraphs: one word-level diff.
        handled = set()
        for key, el in list(present.items()):
            if el.tag == w('p') and not manual(el) and self._diff_paragraph(el, self.snap[key]['el']):
                handled.update(self._k(n) for n in self.snap[key]['el'].iter(etree.Element) if self._k(n) != key)
        # Removed content returns as a tracked deletion at its original position.
        covered, revived = set(), set()
        for key, info in self.snap.items():
            if key in present or key in handled or key in covered: continue
            parent_key = info['parent']
            holder = roots.get(parent_key) if isinstance(parent_key, int) else present.get(parent_key)
            if holder is None: continue            # restored together with an ancestor
            covered.update(self._k(n) for n in info['el'].iter(etree.Element))
            node = self._deleted(info['el'])
            if info['tag'] == w('sectPr') and holder.tag == w('p'):
                ppr = self._props(holder, 'pPr'); tail = ppr.find(w('pPrChange'))
                tail.addprevious(node) if tail is not None else ppr.append(node)
            else:
                siblings = self.order.get(parent_key, [])
                index = siblings.index(key)
                lift = lambda n: n.getparent() if n.getparent() is not holder and n.getparent().tag in RUN_WRAPPERS else n
                prev = next((present[k] for k in reversed(siblings[:index]) if k in present and present[k].tag != w('sectPr')), None)
                follow = next((present[k] for k in siblings[index + 1:] if k in present and present[k].tag != w('sectPr')), None)
                if prev is not None: lift(prev).addnext(node)
                elif follow is not None: lift(follow).addprevious(node)
                elif holder.find(w('sectPr')) is not None: holder.find(w('sectPr')).addprevious(node)
                else: holder.append(node)
            present[key] = node[0] if node.tag == w('del') else node
            self._tag(present[key], key); revived.add(key)
        # Changed properties and run content.
        for key, el in list(present.items()):
            info = self.snap[key]
            if key in revived or key in handled or manual(el): continue
            sig, before, old = _signature(el), info['sig'], info['el']
            if sig == before: continue
            if el.tag == w('p'):
                if sig[0] != before[0]: self._change(el, 'pPr', old.find(w('pPr')))
                if sig[1] != before[1]: self._change(el, 'markrPr', old.find(w('pPr') + '/' + w('rPr')))
            elif el.tag == w('r'):
                if sig[1] != before[1]:
                    el.addprevious(self._deleted(old))
                    wrapper = self._rev('ins'); el.addprevious(wrapper); wrapper.append(el)
                else: self._change(el, 'rPr', old.find(w('rPr')))
            elif el.tag == w('tbl'):
                if sig[0] != before[0]: self._change(el, 'tblPr', old.find(w('tblPr')))
                if sig[1] != before[1]:
                    change = self._rev('tblGridChange'); inner = etree.SubElement(change, w('tblGrid'))
                    for c in old.findall(w('tblGrid') + '/' + w('gridCol')): inner.append(copy.deepcopy(c))
                    el.find(w('tblGrid')).append(change)
            elif el.tag in (w('tr'), w('tc')):
                self._change(el, etree.QName(PROPS_OF[el.tag]).localname, old.find(PROPS_OF[el.tag]))
            elif el.tag == w('sectPr'): self._change(el, 'sectPr', old)
            else: raise Untrackable('Changing <%s> attributes cannot be tracked' % etree.QName(el).localname)
        # New content becomes tracked insertions.
        for root in self.roots:
            for el in list(root.iter(w('p'), w('tr'), w('r'))):
                if self._k(el) or self.done.get(id(el)) in ('1', 'new') or any(self.done.get(id(a)) == '1' for a in el.iterancestors()): continue
                if el.tag == w('p'): self._mark_paragraph(el, 'ins')
                elif el.tag == w('tr'):
                    trpr = self._props(el, 'trPr')
                    if trpr.find(w('ins')) is None: trpr.append(self._rev('ins'))
                elif not any(a.tag in RUN_WRAPPERS for a in el.iterancestors()) and \
                        [c.tag for c in el if c.tag != w('rPr')] != [w('commentReference')]:
                    prev = el.getprevious()
                    if prev is not None and prev.tag == w('ins') and self.done.get(id(prev)) == 'new': prev.append(el)
                    else:
                        wrapper = self._rev('ins'); self._done(wrapper, 'new'); el.addprevious(wrapper); wrapper.append(el)
            # A new section break inside an existing paragraph moves to its own inserted paragraph.
            for sect in list(root.iter(w('sectPr'))):
                ppr = sect.getparent()
                if ppr.tag != w('pPr') or self._k(sect) or not self._k(ppr.getparent()): continue
                holder = etree.Element(w('p')); etree.SubElement(holder, w('pPr')).append(sect)
                self._mark_paragraph(holder, 'ins'); ppr.getparent().addnext(holder)
        return self.warnings
