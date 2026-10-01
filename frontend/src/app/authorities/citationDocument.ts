import type { AuthoritiesProduct, AuthorityOccurrence } from './types';

type Unit = AuthoritiesProduct['state']['units'][number];
export type CitationSelection = { start: number; end: number };
export type LocatedUnit = { unit: Unit; root: HTMLElement; start: number; end: number };
const ignored = 'style,script,del,a.docx-note-label,a.docx-note-ref,[data-citation-ui]';
const normalized = (value: string) => value.normalize('NFKC').replace(/[\s\u00ad]/gu, '');

function textNodes(root: Node, body = false): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest(ignored) || body &&
      node.parentElement?.closest('.docx-notes,header,footer')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function textIndex(text: string) {
  let value = '';
  const starts: number[] = [], ends: number[] = [];
  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const part = normalized(char);
    for (let i = 0; i < part.length; i++) { starts.push(index); ends.push(index + char.length); }
    value += part; index += char.length;
  }
  return { value, starts, ends };
}
const indexes = new WeakMap<Text, { data: string; index: ReturnType<typeof textIndex> }>();
/** A text node's index, computed again only when its text changes: marking one unit again walks
 * the whole root, and every node outside that unit is unchanged. */
function nodeIndex(node: Text) {
  const cached = indexes.get(node);
  if (cached?.data === node.data) return cached.index;
  const index = textIndex(node.data);
  indexes.set(node, { data: node.data, index });
  return index;
}

/** Locate imported units against the rendered source. Notes use their source IDs;
 * repeated body text is consumed in document order, never by the first quote alone. */
export function locateCitationUnits(root: HTMLElement, units: Unit[], page?: number): LocatedUnit[] {
  const caches = new Map<HTMLElement, { text: string; cursor: number }>();
  const notes = [...root.querySelectorAll<HTMLElement>('.docx-notes li')];
  return units.flatMap(unit => {
    if (page && !unit.pageNumbers.includes(page)) return [];
    const sourceNote = /^(footnote|endnote):(\d+)(?::|$)/u.exec(unit.id);
    const scope = page || unit.kind === 'body' ? root :
      notes.find(note => sourceNote && note.id === `docx-note-${sourceNote[1] === 'footnote' ? 'f' : 'e'}-${sourceNote[2]}`) ??
      notes.find(note => note.querySelector('.docx-note-label')?.textContent === String(unit.footnoteId));
    if (!scope) return [];
    let cached = caches.get(scope);
    if (!cached) {
      cached = { text: normalized(textNodes(scope, !page && unit.kind === 'body').map(n => n.data).join('')), cursor: 0 };
      caches.set(scope, cached);
    }
    const value = normalized(unit.text);
    if (!value) return [];
    const start = cached.text.indexOf(value, cached.cursor);
    if (start < 0) return [];
    cached.cursor = start + value.length;
    return [{ unit, root: scope, start, end: cached.cursor }];
  });
}

/** The marks of one citation (ids are matched exactly, never through a selector). */
export const marksOf = (root: ParentNode, id: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-citation-id]')].filter(mark => mark.dataset.citationId === id);

export function clearCitationMarks(root: HTMLElement, unitId?: string) {
  const parents = new Set<Node>();
  root.querySelectorAll<HTMLElement>('[data-citation-id]').forEach(mark => {
    if (unitId !== undefined && mark.dataset.unit !== unitId) return;
    parents.add(mark.parentNode!); mark.replaceWith(...mark.childNodes);
  });
  // One unit's marks are cleared without touching the rest of the document.
  if (unitId === undefined) root.normalize(); else parents.forEach(parent => parent.normalize());
}


/** Flat adjacent spans keep formatting and mark the pinpoint; they carry no paint of their own. */
export function markCitations(locations: LocatedUnit[], occurrences: Record<string, AuthorityOccurrence>) {
  const byRoot = new Map<HTMLElement, LocatedUnit[]>();
  for (const location of locations) {
    const list = byRoot.get(location.root) ?? []; list.push(location); byRoot.set(location.root, list);
  }
  for (const [root, located] of byRoot) {
    const spans = located.flatMap(({ unit, start }) => unit.occurrenceIds.flatMap(id => {
      const occurrence = occurrences[id];
      if (!occurrence) return [];
      const offset = (at: number) => start + normalized(unit.text.slice(0, at)).length;
      return [{ id, unit: unit.id, start: offset(occurrence.start), end: offset(occurrence.end),
        pinpointStart: occurrence.pinpointSpan ? offset(occurrence.pinpointSpan.start) : -1,
        pinpointEnd: occurrence.pinpointSpan ? offset(occurrence.pinpointSpan.end) : -1 }];
    })).sort((a, b) => a.start - b.start);
    let cursor = 0, first = 0;
    for (const node of textNodes(root, root.classList.contains('docx-view-container'))) {
      const index = nodeIndex(node), end = cursor + index.value.length;
      while (first < spans.length && spans[first].end <= cursor) first++;
      const pieces: Array<{ start: number; end: number; id: string; unit: string; pinpoint: boolean }> = [];
      for (let i = first; i < spans.length && spans[i].start < end; i++) {
        const span = spans[i], from = Math.max(cursor, span.start), to = Math.min(end, span.end);
        const points = [...new Set([from, to, span.pinpointStart, span.pinpointEnd]
          .filter(n => n >= from && n <= to))].sort((a, b) => a - b);
        for (let p = 0; p < points.length - 1; p++) pieces.push({
          start: points[p] === cursor && span.start < cursor ? 0 : index.starts[points[p] - cursor],
          end: points[p + 1] === end && span.end > end ? node.length :
            p < points.length - 2 ? index.starts[points[p + 1] - cursor] : index.ends[points[p + 1] - cursor - 1],
          id: span.id, unit: span.unit, pinpoint: points[p] >= span.pinpointStart && points[p + 1] <= span.pinpointEnd,
        });
      }
      if (pieces.length) {
        const fragment = document.createDocumentFragment(); let offset = 0;
        for (const piece of pieces) {
          fragment.append(node.data.slice(offset, piece.start));
          const mark = document.createElement('span');
          Object.assign(mark.dataset, { citationId: piece.id, unit: piece.unit }); mark.className = 'citation-mark';
          if (piece.pinpoint) mark.dataset.pinpoint = '';
          mark.textContent = node.data.slice(piece.start, piece.end); fragment.append(mark); offset = piece.end;
        }
        fragment.append(node.data.slice(offset)); node.replaceWith(fragment);
      }
      cursor = end;
    }
  }
}

export const wholeUnit = (unit: Unit, root: HTMLElement): LocatedUnit =>
  ({ unit, root, start: 0, end: normalized(unit.text).length });

/** A located unit's rendered characters by `k`, the index of a whitespace-free character:
 * unit text offsets and DOM points both map to `k` and back. */
export function unitText({ unit, root, start, end }: LocatedUnit) {
  const chars: Array<{ node: Text; start: number; end: number }> = [];
  const own = textIndex(unit.text), before = start > 0 ? 1 : 0, count = end - start;
  let cursor = 0;
  for (const node of textNodes(root, root.classList.contains('docx-view-container'))) {
    if (cursor > end) break;
    const index = nodeIndex(node), next = cursor + index.value.length;
    for (let i = Math.max(cursor, start - 1); i < Math.min(next, end + 1); i++)
      chars.push({ node, start: index.starts[i - cursor], end: index.ends[i - cursor] });
    cursor = next;
  }
  const char = (k: number) => unit.text.slice(own.starts[k], own.ends[k]);
  const gap = (k: number) => k <= 0 || k >= count || /\s/u.test(unit.text.slice(own.ends[k - 1], own.starts[k]));
  // A word's edge is whitespace, or punctuation that may stay outside a citation (a closing ";").
  // Brackets and quotation marks belong to the word they enclose: "[Daviault]" ends after "]".
  const edge = (k: number, side: 'start' | 'end') => {
    const attached = side === 'start' ? /[\p{Ps}\p{Pi}"']/u : /[\p{Pe}\p{Pf}"']/u;
    for (let j = k; !gap(j); j += side === 'start' ? -1 : 1) {
      const c = char(side === 'start' ? j - 1 : j);
      if (!/\p{P}/u.test(c) || attached.test(c)) return false;
    }
    return true;
  };
  const from = (k: number) => own.starts[k] ?? unit.text.length, to = (k: number) => k > 0 ? own.ends[k - 1] : 0;
  /** The first `k` at or after a DOM point, or null outside the unit. */
  const at = (node: Node, offset: number) => {
    if (!root.contains(node)) return null;
    const probe = document.createRange(); probe.setStart(node, offset);
    let low = 0, high = chars.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (probe.comparePoint(chars[middle].node, chars[middle].start) >= 0) high = middle; else low = middle + 1;
    }
    return low - before < 0 || low - before > count ? null : low - before;
  };
  return {
    count, gap, at, from, to,
    index: (at: number) => normalized(unit.text.slice(0, at)).length,
    /** The unit offset of a selection edge, exact within whitespace its text node shows. */
    offset(node: Node, offset: number, side: 'start' | 'end') {
      const k = at(node, offset), next = k === null ? null : chars[before + k], last = k && chars[before + k - 1];
      if (k === null) return null;
      const exact = next?.node === node && offset <= next.start ? from(k) - next.start + offset
        : last && last.node === node && offset >= last.end ? to(k) + offset - last.end : side === 'start' ? from(k) : to(k);
      return Math.min(from(k), Math.max(to(k), exact));
    },
    range(from: number, to: number) {
      const a = chars[before + from], b = chars[before + to - 1], range = document.createRange();
      if (!a || !b || to <= from) return null;
      range.setStart(a.node, a.start); range.setEnd(b.node, b.end);
      return range;
    },
    /** The next word edge from `k` in direction `step` within [low, high]. */
    next(k: number, side: 'start' | 'end', step: 1 | -1, low: number, high: number) {
      for (let j = k + step; j >= low && j <= high; j += step) if (edge(j, side)) return j;
      return null;
    },
    /** The word edge nearest `k` within [low, high]. */
    snap(k: number, side: 'start' | 'end', low: number, high: number) {
      for (let d = 0; d <= count; d++) for (const j of [k - d, k + d])
        if (j >= low && j <= high && edge(j, side)) return j;
      return null;
    },
  };
}
export type UnitText = ReturnType<typeof unitText>;

/** The located unit a selection lies in, or null when it lies outside every unit or crosses two.
 * Units sharing a root (body paragraphs, a PDF page) are told apart by position; a note's own
 * root wins over the body around it. */
export function selectedUnit(locations: LocatedUnit[], range: Range) {
  const place = (node: Node, offset: number, side: 'start' | 'end') => {
    const inside = locations.filter(item => item.root.contains(node));
    const deepest = inside.filter(item => !inside.some(other => other.root !== item.root && item.root.contains(other.root)));
    if (deepest.length < 2) return deepest[0] ?? null;
    const root = deepest[0].root, probe = document.createRange();
    probe.setStart(node, offset);
    let index = 0;
    for (const text of textNodes(root, root.classList.contains('docx-view-container'))) {
      if (text === node) { index += normalized(text.data.slice(0, offset)).length; break; }
      if (probe.comparePoint(text, 0) > 0) break;
      index += normalized(text.data).length;
    }
    // An end point belongs to the character before it.
    const k = side === 'end' ? index - 1 : index;
    return deepest.find(item => k >= item.start && k < item.end) ?? null;
  };
  const start = place(range.startContainer, range.startOffset, 'start');
  return start && start === place(range.endContainer, range.endOffset, 'end') ? start : null;
}

export function citationSelection(location?: LocatedUnit | null, text = location && unitText(location),
  range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null): CitationSelection | null {
  const start = text && range && text.offset(range.startContainer, range.startOffset, 'start');
  const end = range?.collapsed ? start : text && range && text.offset(range.endContainer, range.endOffset, 'end');
  return start == null || end == null ? null : { start, end: Math.max(start, end) };
}

export function caretAt(x: number, y: number) {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

type Box = { left: number; top: number; right: number; bottom: number };
const GAP = 4;
/** Client rects as one box per text line. */
function lineBoxes(rects: Iterable<DOMRect>) {
  const lines: Box[] = [];
  for (const r of [...rects].filter(r => r.width > .5 && r.height > .5).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const middle = (r.top + r.bottom) / 2, line = lines.find(line => middle > line.top && middle < line.bottom);
    if (!line) lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    else Object.assign(line, { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right),
      top: Math.min(line.top, r.top), bottom: Math.max(line.bottom, r.bottom) });
  }
  return lines;
}
/** Client rects of the words a range or marks cover, so no line ends in the whitespace it wraps at.
 * jsdom has no range geometry; there the marks' own rects stand in. */
function ink(target: Range | HTMLElement[]) {
  const probe = document.createRange(), pieces: Array<[Text, number, number]> = [];
  if (!probe.getClientRects) return target instanceof Range ? [] : target.flatMap(mark => [...mark.getClientRects()]);
  if (target instanceof Range) {
    const { commonAncestorContainer: root, startContainer, startOffset, endContainer, endOffset } = target;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      { acceptNode: node => target.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    for (let node: Node | null = root; node; node = walker.nextNode()) if (node instanceof Text)
      pieces.push([node, node === startContainer ? startOffset : 0, node === endContainer ? endOffset : node.length]);
  } else for (const mark of target) for (const node of mark.childNodes) if (node instanceof Text) pieces.push([node, 0, node.length]);
  return pieces.flatMap(([node, from, to]) => [...node.data.slice(from, to).matchAll(/\S+/gu)].flatMap(word => {
    probe.setStart(node, from + word.index); probe.setEnd(node, from + word.index + word[0].length);
    return [...probe.getClientRects()];
  }));
}
const within = (box: Box, x: number, y: number) => y >= box.top && y <= box.bottom && x >= box.left && x <= box.right;
/** Client coordinates to the scroller's content coordinates. */
const origin = (scroller: Element) => {
  const view = scroller.getBoundingClientRect();
  return { view, x: scroller.scrollLeft - view.left - scroller.clientLeft, y: scroller.scrollTop - view.top - scroller.clientTop };
};

export type CitationPaint = { active?: string; range?: Range | null };
export type PaintMode = 'layout' | 'active' | 'scroll';
type Band = Box & { id: string };
const drawn = new WeakMap<HTMLElement, Band[]>();
/** One rounded band per line of each citation on the pages in view, drawn in an overlay that scrolls
 * with the text. "layout" measures every band again (marks, zoom or size changed), as does a change
 * in the pages in view; "active" redraws only the active citation: its fill, pinpoint and grips, or the
 * range a drag or nudge previews; "scroll" does nothing more while the same pages stay in view. */
export function paintCitations(scroller: HTMLElement, { active, range }: CitationPaint, mode: PaintMode) {
  const { view, x, y } = origin(scroller), all = [...scroller.querySelectorAll('.page,section.docx')];
  const shown = all.flatMap((page, i) => {
    const box = page.getBoundingClientRect();
    return box.bottom > view.top - view.height && box.top < view.bottom + view.height ? [i] : [];
  }).join();
  let overlay = scroller.querySelector<HTMLElement>(':scope>.citation-overlay');
  if (!overlay) {
    overlay = scroller.appendChild(Object.assign(document.createElement('div'), { className: 'citation-overlay' }));
    overlay.dataset.citationUi = ''; overlay.setAttribute('aria-hidden', 'true');
    overlay.append(document.createElement('div'), document.createElement('div'));
  }
  const [layer, own] = overlay.children as unknown as [HTMLElement, HTMLElement];
  const moved = overlay.dataset.pages !== shown;
  if (mode === 'scroll' && !moved) return;
  // Shapes are kept in content coordinates, which scrolling leaves alone: a grip drawn after a scroll
  // from bands measured before it lands on its citation's edge.
  const box = (className: string, b: Box, data: Record<string, string> = {}) => {
    const element = Object.assign(document.createElement('div'), { className });
    Object.assign(element.style, { left: `${b.left}px`, top: `${b.top}px`,
      width: `${b.right - b.left}px`, height: `${b.bottom - b.top}px` });
    Object.assign(element.dataset, data);
    return element;
  };
  /** A measured line, padded, in content coordinates. */
  const pad = (line: Box) => ({ left: line.left - 2 + x, right: line.right + 2 + x, top: line.top - 1 + y, bottom: line.bottom + 1 + y });
  if (mode === 'layout' || moved) {
    overlay.dataset.pages = shown;
    const groups = new Map<string, HTMLElement[]>();
    for (const page of all.length ? shown.split(',').filter(Boolean).map(i => all[+i]) : [scroller])
      for (const mark of page.querySelectorAll<HTMLElement>('[data-citation-id]')) {
        const id = mark.dataset.citationId!, list = groups.get(id) ?? [];
        list.push(mark); groups.set(id, list);
      }
    const bands: Band[] = [...groups].flatMap(([id, marks]) => lineBoxes(ink(marks)).map(line => ({ id, ...pad(line) })));
    // Bands never touch: neighbours on a line, and lines above one another, part around a gap.
    bands.sort((a, b) => a.top - b.top || a.left - b.left);
    for (let i = 0; i < bands.length; i++) for (let j = i + 1; j < bands.length && bands[j].top < bands[i].bottom + GAP; j++) {
      const a = bands[i], b = bands[j], [l, r] = a.left <= b.left ? [a, b] : [b, a];
      if (within(a, a.left, (b.top + b.bottom) / 2)) {
        if (l.id === r.id || r.left - l.right >= GAP) continue;
        const middle = (l.right + r.left) / 2; l.right = middle - GAP / 2; r.left = middle + GAP / 2;
      } else if (r.left < l.right) {
        const middle = (a.bottom + b.top) / 2; a.bottom = Math.min(a.bottom, middle - 1); b.top = Math.max(b.top, middle + 1);
      }
    }
    drawn.set(overlay, bands);
    layer.replaceChildren(...bands.map(band => box('citation-band', band, { id: band.id })));
  }
  for (const band of layer.children as HTMLCollectionOf<HTMLElement>) {
    band.toggleAttribute('data-active', band.dataset.id === active);
    band.hidden = !!range && band.dataset.id === active;
  }
  const lines = range ? lineBoxes(ink(range)).map(pad) : (drawn.get(overlay) ?? []).filter(band => band.id === active);
  const marks = active && !range ? marksOf(scroller, active).filter(mark => mark.dataset.pinpoint !== undefined) : [];
  const pins = lineBoxes(ink(marks)).flatMap(pin => {
    const middle = (pin.top + pin.bottom) / 2 + y, line = lines.find(band => within(band, band.left, middle));
    return line ? [{ ...line, left: Math.max(line.left, pin.left + x - 1), right: Math.min(line.right, pin.right + x + 1) }] : [];
  });
  // Each grip is a slim bar the height of its line with a round cap: the start cap sits above the
  // line and the end cap below. The hit area is 16px wide, mostly outside the text so a selection
  // can still start at its first letter, and a line plus its cap tall.
  const grips = lines.length ? [
    box('citation-grip', { left: lines[0].left - 12, right: lines[0].left + 4,
      top: lines[0].top - 8, bottom: lines[0].bottom }, { grip: 'start', cap: 'top' }),
    box('citation-grip', { left: lines.at(-1)!.right - 4, right: lines.at(-1)!.right + 12,
      top: lines.at(-1)!.top, bottom: lines.at(-1)!.bottom + 8 }, { grip: 'end', cap: 'bottom' }),
  ] : [];
  own.replaceChildren(...range ? lines.map(line => box('citation-band', line, { active: '' })) : [],
    ...pins.map(pin => box('citation-pinpoint', pin)), ...grips);
}
