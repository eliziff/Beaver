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

export function clearCitationMarks(root: HTMLElement) {
  root.querySelectorAll('[data-citation-id]').forEach(mark => mark.replaceWith(...mark.childNodes));
  root.normalize();
}

/** Flat adjacent spans preserve formatting and give the pinpoint its own fill. */
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
      return [{ id, start: offset(occurrence.start), end: offset(occurrence.end),
        pinpointStart: occurrence.pinpointSpan ? offset(occurrence.pinpointSpan.start) : -1,
        pinpointEnd: occurrence.pinpointSpan ? offset(occurrence.pinpointSpan.end) : -1 }];
    })).sort((a, b) => a.start - b.start);
    let cursor = 0, first = 0;
    for (const node of textNodes(root, root.classList.contains('docx-view-container'))) {
      const index = textIndex(node.data), end = cursor + index.value.length;
      while (first < spans.length && spans[first].end <= cursor) first++;
      const pieces: Array<{ start: number; end: number; id: string; pinpoint: boolean }> = [];
      for (let i = first; i < spans.length && spans[i].start < end; i++) {
        const span = spans[i], from = Math.max(cursor, span.start), to = Math.min(end, span.end);
        const points = [...new Set([from, to, span.pinpointStart, span.pinpointEnd]
          .filter(n => n >= from && n <= to))].sort((a, b) => a - b);
        for (let p = 0; p < points.length - 1; p++) pieces.push({
          start: points[p] === cursor && span.start < cursor ? 0 : index.starts[points[p] - cursor],
          end: points[p + 1] === end && span.end > end ? node.length :
            p < points.length - 2 ? index.starts[points[p + 1] - cursor] : index.ends[points[p + 1] - cursor - 1],
          id: span.id, pinpoint: points[p] >= span.pinpointStart && points[p + 1] <= span.pinpointEnd,
        });
      }
      if (pieces.length) {
        const fragment = document.createDocumentFragment(); let offset = 0;
        for (const piece of pieces) {
          fragment.append(node.data.slice(offset, piece.start));
          const mark = document.createElement('span'); mark.dataset.citationId = piece.id;
          mark.className = 'citation-mark';
          if (piece.pinpoint) mark.dataset.pinpoint = '';
          mark.textContent = node.data.slice(piece.start, piece.end); fragment.append(mark); offset = piece.end;
        }
        fragment.append(node.data.slice(offset)); node.replaceWith(fragment);
      }
      cursor = end;
    }
  }
}

export function citationSelection(location?: LocatedUnit): CitationSelection | null {
  const selection = window.getSelection();
  if (!location || !selection?.rangeCount) return null;
  const range = selection.getRangeAt(0), { root, unit, start, end } = location;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const body = root.classList.contains('docx-view-container');
  const full = textNodes(root, body).map(n => n.data).join(''), rendered = textIndex(full);
  const rawStart = rendered.starts[start] ?? 0;
  const prefix = document.createRange(); prefix.selectNodeContents(root);
  const offset = (node: Node, at: number) => {
    prefix.setEnd(node, at);
    return textNodes(prefix.cloneContents(), body).map(n => n.data).join('');
  };
  const before = offset(range.startContainer, range.startOffset), after = offset(range.endContainer, range.endOffset);
  if (full.slice(rawStart, rawStart + unit.text.length) === unit.text) {
    const from = before.length - rawStart, to = after.length - rawStart;
    return from >= 0 && to <= unit.text.length ? { start: from, end: to } : null;
  }
  const from = normalized(before).length, to = normalized(after).length;
  if (from < start || to > end) return null;
  const index = textIndex(unit.text), a = index.starts[from - start] ?? unit.text.length;
  return { start: a, end: range.collapsed ? a : index.ends[to - start - 1] ?? a };
}
