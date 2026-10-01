import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { DocxCanvas } from '@/app/components/shared/views/DocxCanvas';
import { PdfCanvas } from '@/app/components/shared/views/PdfCanvas';
import type { WorkProductFocus } from '@/app/lib/workProducts';
import { errorMessage } from '@/app/lib/utils';
import { authorityLabel, authorityName } from './authorityPresentation';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesAction, AuthoritiesProduct, AuthorityOccurrence, AuthorityIdentity, AuthoritiesDiscrepancy } from './types';
import { activeBand, caretAt, citationSelection, clearCitationMarks, locateCitationUnits, markCitations, marksOf, paintCitations,
  selectedUnit, showSplit, unitText, wholeUnit, type CitationPaint, type CitationSelection, type LocatedUnit, type PaintMode,
  type UnitText } from './citationDocument';
import './citationReview.css';

const SCROLLERS = '.beaver-pdf-scroll,.docx-view-scroll,.citation-fallback>div';
const LOCATORS: Record<string, [string, string]> = { paragraph: ['para', 'paras'], section: ['s', 'ss'] };
/** "para 35", "ss 3-4", "103": the parsed pinpoint with its locator. */
const pinpointText = ({ pinpointSpan, pinpoints }: AuthorityOccurrence) => {
  // A pinpoint selected by hand may carry the "at" that introduces it.
  const text = (pinpointSpan?.text ?? pinpoints.map(({ text }) => text).join(', ')).replace(/^at\s+/u, '');
  const [one, many] = LOCATORS[pinpoints[0]?.kind] ?? [];
  // A pinpoint placed by hand may already carry its locator.
  return !text || !one || text.startsWith(one) ? text
    : `${pinpoints.length > 1 || pinpoints[0].text.includes('-') ? many : one} ${text}`;
};

/** An outline row: the citation as it reads in the article. The review marks the selected row
 * itself, so choosing another re-renders no row. */
const Row = memo(function Row({ row }: { row: AuthorityOccurrence }) {
  return <button type="button" role="option" data-id={row.id} aria-selected="false" tabIndex={-1}
    title={row.text}><span>{row.text}</span></button>;
});

/** The citations in reading order, and the text marked "Not a citation", which stays listed so a
 * wrong call can be taken back. It renders again only when the draft or its review changes. */
const Outline = memo(function Outline({ product, occurrences, busy, onRestore }: {
  product: AuthoritiesProduct; occurrences: AuthorityOccurrence[]; busy: boolean; onRestore(id: string): void;
}) {
  const { units, occurrences: byId } = product.state;
  const kinds = new Map(units.map(unit => [unit.id, unit.kind]));
  const body = occurrences.filter(row => kinds.get(row.unitId) === 'body');
  const notes = units.filter(unit => unit.kind === 'footnote' && unit.occurrenceIds.some(id => byId[id]));
  const dismissed = Object.values(product.state.dismissedOccurrences ?? {});
  const row = (item: AuthorityOccurrence) => <Row key={item.id} row={item} />;
  return <>
    {!!body.length && <div role="group" aria-labelledby="citation-body-heading">
      <h3 id="citation-body-heading">In-text</h3>{body.map(row)}</div>}
    {!!notes.length && <div role="group" aria-labelledby="citation-notes-heading">
      <h3 id="citation-notes-heading">Footnotes</h3>{notes.map(note => {
        const label = note.footnoteId ?? note.ordinal + 1;
        return <div key={note.id} className="citation-note" role="group" aria-label={`Footnote ${label}`}>
          <span className="citation-note-number" aria-hidden="true">{label}</span>
          <div>{note.occurrenceIds.map(id => byId[id]).filter(Boolean).map(row)}</div>
        </div>;
      })}</div>}
    {dismissed.length > 0 && <details className="citation-dismissed">
      <summary>Not citations ({dismissed.length})</summary>
      {dismissed.map(({ occurrence }) => <div key={occurrence.id}>
        <s title={occurrence.text}>{occurrence.citation || occurrence.text}</s>
        <Button type="button" variant="ghost" className="h-8 shrink-0 px-2" disabled={busy}
          onClick={() => onRestore(occurrence.id)}>Restore</Button>
      </div>)}
    </details>}
  </>;
});

type AuthorityOption = { authorityId: string; group: string; label: string; description: string };
/** The authority a citation points to, chosen from a searchable list that opens upward over the
 * document: the authorities cited in-text, then per footnote, then the rest. */
function AuthorityPicker({ options, current, busy, onPick }: {
  options: AuthorityOption[]; current?: AuthorityIdentity; busy: boolean; onPick(authorityId: string | null): void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('[role=option][aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    addEventListener('pointerdown', outside, true);
    return () => removeEventListener('pointerdown', outside, true);
  }, [open]);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const shown = options.filter(option => words.every(word => `${option.label} ${option.description}`.toLowerCase().includes(word)));
  const groups = [...new Set(shown.map(option => option.group))];
  const pick = (authorityId: string | null) => { setOpen(false); setQuery(''); trigger.current?.focus(); onPick(authorityId); };
  return <div ref={root} className="citation-authority" onKeyDown={event => {
    if (!open) return;
    // Keys inside the list stay in the list: arrows move between choices and Escape closes it.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...root.current!.querySelectorAll<HTMLElement>('input,[role=option]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }}>
    <button ref={trigger} type="button" className="citation-authority-trigger" disabled={busy} aria-haspopup="listbox"
      aria-expanded={open} aria-label={`Authority: ${current ? authorityLabel(current) : 'not linked'}`}
      title={current ? authorityLabel(current) : undefined} onClick={() => setOpen(value => !value)}>
      <span data-empty={current ? undefined : ''}>{current ? authorityLabel(current) : 'Not linked'}</span><ChevronUp aria-hidden="true" />
    </button>
    {open && <div className="citation-authority-menu">
      <input autoFocus aria-label="Search authorities" placeholder="Search authorities" value={query}
        onChange={event => setQuery(event.target.value)} />
      <div role="listbox" aria-label="Authorities">
        {current && <button type="button" role="option" aria-selected="false" className="citation-authority-unlink"
          onClick={() => pick(null)}>Unlink</button>}
        {groups.map(group => <div key={group} role="group" aria-label={group}><div aria-hidden="true">{group}</div>
          {shown.filter(option => option.group === group).map(option => <button key={option.authorityId} type="button"
            role="option" aria-selected={option.authorityId === current?.id} onClick={() => pick(option.authorityId)}>
            <span>{option.label}</span>{option.description && <small>{option.description}</small>}</button>)}
        </div>)}
        {!shown.length && <p>No authority matches</p>}
      </div>
    </div>}
  </div>;
}

export function CitationReview({ product, host, sourceVersion, occurrences, selected, authorities, discrepancies,
  busy, onSelect, onAction, onReview, onFocusChange }: {
  product: AuthoritiesProduct; host: AuthoritiesHost; sourceVersion: number;
  occurrences: AuthorityOccurrence[]; selected?: AuthorityOccurrence; authorities: AuthorityIdentity[];
  discrepancies: AuthoritiesDiscrepancy[]; busy: boolean; onSelect(id: string): void;
  onAction(action: AuthoritiesAction, done?: (next: AuthoritiesProduct) => void): void;
  onReview(id: string): void; onFocusChange?(focus?: WorkProductFocus): void;
}) {
  const reviewRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null), fallbackRef = useRef<HTMLDivElement>(null);
  const locations = useRef<LocatedUnit[]>([]), texts = useRef(new WeakMap<LocatedUnit, UnitText>());
  // Pages whose text layer has been searched for citations.
  const decorated = useRef(new Set<number>());
  const preview = useRef<CitationPaint>({}), frame = useRef(0), mode = useRef<PaintMode | undefined>(undefined);
  const split = useRef<{ k: number; timer: ReturnType<typeof setTimeout> }>(undefined), hot = useRef<string | undefined>(undefined);
  const nudge = useRef<{ id: string; from: number; to: number; commit(): void; timer: ReturnType<typeof setTimeout> }>(undefined);
  // Document events and frames read the latest props here.
  const live = useRef({ product, selected, onAction, onSelect });
  useLayoutEffect(() => { live.current = { product, selected, onAction, onSelect }; });
  const [restore] = useState(() => (id: string) => live.current.onAction({ type: 'restore-occurrence', occurrenceId: id },
    () => live.current.onSelect(id)));
  const [source, setSource] = useState<{ buffer: ArrayBuffer; pdf: Uint8Array }>();
  const [error, setError] = useState(''), [ready, setReady] = useState(0);
  // The selected text, in whichever unit it lies.
  const [selection, setSelection] = useState<CitationSelection & { unitId: string } | null>(null);
  // The word gap nearest a caret inside the active citation, where Split divides it.
  const [splitPoint, setSplitPoint] = useState<number | null>(null);
  // False once the passage's pages have been searched without finding it.
  const [located, setLocated] = useState(true);
  // Only outline and navigation choices move the view; a click in the document never does.
  const scrollPending = useRef(true);
  const { units } = product.state, imported = product.state.import;
  const pdf = imported.kind === 'document' && imported.fileType === 'pdf';
  const sourceKey = JSON.stringify([product.id, product.state.bindings.source, sourceVersion]);
  const unitById = new Map(units.map(unit => [unit.id, unit]));
  const authorityById = new Map(authorities.map(authority => [authority.id, authority]));
  const unit = selected && unitById.get(selected.unitId);
  const navigation = [...occurrences.filter(row => unitById.get(row.unitId)?.kind === 'body'), ...units.flatMap(unit =>
    unit.kind === 'footnote' ? unit.occurrenceIds.map(id => product.state.occurrences[id]).filter(Boolean) : [])];
  const occurrenceIndex = new Map(navigation.map((row, i) => [row.id, i]));
  const index = occurrenceIndex.get(selected?.id ?? '') ?? 0;
  const choose = (id: string, scroll: boolean) => {
    if (id !== selected?.id) { scrollPending.current = scroll; onSelect(id); }
  };
  // The active unit as rendered: its place in the document, or the extracted text shown instead.
  const locate = () => {
    const fallback = fallbackRef.current, location = fallback && unit ? wholeUnit(unit, fallback)
      : locations.current.find(item => item.unit.id === unit?.id);
    if (!location) return null;
    if (!texts.current.has(location)) texts.current.set(location, unitText(location));
    return { location, text: texts.current.get(location)! };
  };
  const rememberSelection = () => {
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    const own = range?.collapsed ? locate() : null, k = own && own.text.at(range!.startContainer, range!.startOffset);
    const low = own && selected ? own.text.index(selected.start) : 0, high = own && selected ? own.text.index(selected.end) : 0;
    let gap: number | null = null;
    if (own && k != null && k >= low && k <= high)
      for (let d = 0; gap == null && d <= high - low; d++) for (const j of [k - d, k + d])
        if (gap == null && j > low && j < high && own.text.gap(j)) gap = j;
    setSplitPoint(own && gap != null ? own.text.from(gap) : null);
    const location = !range || range.collapsed ? null : fallbackRef.current?.contains(range.startContainer)
      ? locate()?.location : selectedUnit(locations.current, range);
    if (location && !texts.current.has(location)) texts.current.set(location, unitText(location));
    const span = location && citationSelection(location, texts.current.get(location), range);
    setSelection(location && span && span.end > span.start ? { unitId: location.unit.id, ...span } : null);
  };
  // "layout" measures every band again; "active" redraws the active citation; "scroll" repaints only
  // when the pages in view change.
  const paint = (next: PaintMode) => {
    cancelAnimationFrame(frame.current); frame.current = 0; mode.current = undefined;
    documentRef.current?.querySelectorAll<HTMLElement>(SCROLLERS).forEach(scroller =>
      paintCitations(scroller, { active: live.current.selected?.id, ...preview.current }, next));
  };
  const repaint = (next: PaintMode) => {
    const rank = { scroll: 0, active: 1, layout: 2 };
    if (!mode.current || rank[next] > rank[mode.current]) mode.current = next;
    frame.current ||= requestAnimationFrame(() => paint(mode.current ?? 'scroll'));
  };
  // The split marker waits for the pointer to rest in a gap; only a shown marker splits on click.
  const clearSplit = () => {
    clearTimeout(split.current?.timer); split.current = undefined;
    documentRef.current?.removeAttribute('data-split');
    documentRef.current?.querySelectorAll(SCROLLERS).forEach(scroller => showSplit(scroller));
  };
  const flushNudge = () => { clearTimeout(nudge.current?.timer); nudge.current?.commit(); };
  /** Marks the selected citation active and brings it into view when a navigation asked for that.
   * A PDF page not yet rendered is scrolled to once; its text layer then marks and places the citation. */
  const activate = () => {
    const { selected, product } = live.current, root = documentRef.current;
    if (!root || !selected) return;
    root.querySelectorAll('.citation-mark[data-active]').forEach(mark => mark.removeAttribute('data-active'));
    const marks = marksOf(root, selected.id);
    marks.forEach(mark => { mark.dataset.active = ''; });
    const pages = product.state.units.find(unit => unit.id === selected.unitId)?.pageNumbers ?? [];
    const found = locations.current.some(location => location.unit.id === selected.unitId);
    setLocated(found || product.state.import.kind === 'document' && product.state.import.fileType === 'pdf' &&
      !pages.every(page => decorated.current.has(page)));
    repaint('active');
    const scroller = root.querySelector<HTMLElement>('.docx-view-scroll,.beaver-pdf-scroll');
    if (!scrollPending.current || !scroller) return;
    const view = scroller.getBoundingClientRect();
    if (marks[0]) {
      scrollPending.current = false;
      const mark = marks[0].getBoundingClientRect();
      if (mark.top < view.top + 36 || mark.bottom > view.bottom - 36) scroller.scrollTop += mark.top - view.top - view.height / 3;
      return;
    }
    const page = pages[0] && scroller.querySelector(`.page[data-page-number="${pages[0]}"]`)?.getBoundingClientRect();
    if (page && (page.bottom < view.top || page.top > view.bottom)) scroller.scrollTop += page.top - view.top;
  };
  const decorate = (root: HTMLElement, page?: number) => {
    const { product } = live.current;
    clearCitationMarks(root);
    const found = locateCitationUnits(root, product.state.units, page);
    locations.current = page ? [...locations.current.filter(item => item.root !== root), ...found] : found;
    if (page) decorated.current.add(page);
    markCitations(found, product.state.occurrences); activate(); repaint('layout');
    if (page) setReady(value => value || 1);
  };

  useEffect(() => {
    let live = true; setSource(undefined); setError(''); setLocated(true); setReady(0);
    locations.current = []; decorated.current.clear();
    void (async () => {
      if (!host.readSource || imported.kind !== 'document') throw new Error('The source document is unavailable.');
      const blob = await host.readSource(product, imported.bindingRole), buffer = await blob.arrayBuffer();
      if (live) setSource({ buffer, pdf: new Uint8Array(buffer) });
    })().catch(cause => { if (live) setError(errorMessage(cause)); });
    return () => { live = false; };
  }, [host, sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    preview.current = {};
    if (imported.kind !== 'document' || !source) return;
    if (imported.fileType === 'docx') {
      const root = documentRef.current?.querySelector<HTMLElement>('.docx-view-container');
      if (root && ready) {
        root.contentEditable = 'true'; root.spellcheck = false;
        root.setAttribute('role', 'textbox'); root.setAttribute('aria-label', 'Source document');
        root.setAttribute('aria-readonly', 'true'); root.setAttribute('aria-multiline', 'true');
        decorate(root);
      }
    } else documentRef.current?.querySelectorAll<HTMLElement>('.pdf-text-layer').forEach(root =>
      decorate(root, Number(root.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber)));
  }, [ready, source, units, product.state.occurrences]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    flushNudge(); rememberSelection(); clearSplit(); activate();
    listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = fallbackRef.current;
    if (!root || !unit || !selected) return;
    clearCitationMarks(root);
    markCitations([{ unit, root, start: 0, end: unit.text.length }], product.state.occurrences);
    marksOf(root, selected.id).forEach(mark => { mark.dataset.active = ''; });
    repaint('layout');
  }, [error, located, ready, source, selected?.id, units, product.state.occurrences]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!busy) { preview.current = {}; repaint('active'); } }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bands follow the text through scrolling, zoom and layout changes.
  useEffect(() => {
    const root = documentRef.current, scroll = () => repaint('scroll');
    if (!root) return;
    const observer = window.ResizeObserver && new ResizeObserver(() => repaint('layout'));
    [root, ...root.querySelectorAll('.pdfViewer,.docx-view-container')].forEach(element => observer?.observe(element));
    root.addEventListener('scroll', scroll, true);
    return () => { observer?.disconnect(); root.removeEventListener('scroll', scroll, true); };
  }, [source, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(split.current?.timer); flushNudge(); }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', rememberSelection);
    return () => document.removeEventListener('selectionchange', rememberSelection);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const own = selection?.unitId === selected?.unitId && selection;
    onFocusChange?.(selected ? { itemId: selected.id, ...(own && { selection: { start: own.start, end: own.end } }) } : undefined);
  }, [selected?.id, selection, onFocusChange]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onFocusChange?.(), [onFocusChange]);
  // The review fills what its scroll frame shows below it, so nothing under it is cut off.
  useLayoutEffect(() => {
    const review = reviewRef.current;
    if (!review) return;
    let scroller = review.parentElement;
    while (scroller && !/auto|scroll/u.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const frame = scroller ?? document.documentElement;
    const fit = () => {
      const top = review.getBoundingClientRect().top + frame.scrollTop -
        (scroller ? scroller.getBoundingClientRect().top : 0);
      review.style.setProperty('--citation-review-height', `${Math.max(336, frame.clientHeight - top - 16)}px`);
    };
    fit(); addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [!!(selected && unit)]); // eslint-disable-line react-hooks/exhaustive-deps

  // The selected row is marked here rather than by rendering every row again.
  useLayoutEffect(() => {
    listRef.current?.querySelectorAll<HTMLElement>('[role=option]').forEach(option => {
      const chosen = option.dataset.id === selected?.id;
      if (chosen !== (option.getAttribute('aria-selected') === 'true')) {
        option.setAttribute('aria-selected', String(chosen)); option.tabIndex = chosen ? 0 : -1;
      }
    });
  });
  const outline = <Outline product={product} occurrences={occurrences} busy={busy} onRestore={restore} />;
  if (!selected || !unit) return <div className="p-8 text-sm text-gray-500">
    <p>No citations found.</p>{outline}</div>;
  const submit = (action: AuthoritiesAction, then?: () => void) => onAction(action, () => {
    window.getSelection()?.removeAllRanges(); setSelection(null); then?.();
  });
  const option = (at: number) => [...listRef.current?.querySelectorAll<HTMLElement>('[role=option]') ?? []]
    .find(row => row.dataset.id === navigation[at].id);
  const step = (delta: number, focus = false) => {
    const next = Math.min(navigation.length - 1, Math.max(0, delta === Infinity ? navigation.length - 1 : index + delta));
    if (next === index) return;
    choose(navigation[next].id, true);
    if (focus) option(next)?.focus();
  };
  // The reviewer keeps their place: the next citation becomes active where the view already is.
  const remove = () => {
    const next = navigation[index + 1] ?? navigation[index - 1];
    submit({ type: 'remove-occurrence', occurrenceId: selected.id }, () => { if (next) choose(next.id, false); });
  };
  // What a selection means: a new citation where it touches none, the active citation's own range
  // where it touches that one, and nothing where it touches another.
  const touched = selection ? (unitById.get(selection.unitId)?.occurrenceIds ?? []).flatMap(id => {
    const item = product.state.occurrences[id];
    return item && item.start < selection.end && selection.start < item.end ? [item.id] : [];
  }) : [];
  const intent = !selection ? null : touched.includes(selected.id) ? 'active' : touched.length ? 'other' : 'new';
  const ownSelection = intent === 'active' && selection;
  const hasSelection = !!selection;
  const mergeable = unit.occurrenceIds.indexOf(selected.id) > 0;
  /** A new citation from the selection; it becomes active where the view already is. */
  const addCitation = () => {
    if (intent !== 'new' || !selection || busy) return;
    const { unitId, start, end } = selection, before = new Set(unitById.get(unitId)?.occurrenceIds);
    onAction({ type: 'add-occurrence', unitId, start, end }, next => {
      window.getSelection()?.removeAllRanges(); setSelection(null);
      const added = next.state.units.find(item => item.id === unitId)?.occurrenceIds.find(id => !before.has(id));
      if (added) choose(added, false);
    });
  };
  /** Moves one edge of the active citation a word; the range commits once the keys rest. */
  const nudgeEdge = (side: 'start' | 'end', direction: 1 | -1) => {
    const found = locate();
    if (!found) return;
    const { text } = found, id = selected.id;
    const now = nudge.current?.id === id ? nudge.current : { from: text.index(selected.start), to: text.index(selected.end) };
    const edge = side === 'start' ? text.next(now.from, 'start', direction, 0, now.to - 1)
      : text.next(now.to, 'end', direction, now.from + 1, text.count);
    if (edge == null) return;
    const from = side === 'start' ? edge : now.from, to = side === 'end' ? edge : now.to;
    clearTimeout(nudge.current?.timer);
    const commit = () => {
      nudge.current = undefined;
      const start = text.from(from), end = text.to(to);
      if (start !== selected.start || end !== selected.end) submit({ type: 'set-citation-range', occurrenceId: id, start, end });
      else { preview.current = {}; paint('active'); }
    };
    nudge.current = { id, from, to, commit, timer: setTimeout(commit, 600) };
    preview.current = { range: text.range(from, to) }; paint('active');
  };
  // The word gap under the pointer strictly inside the active citation, and the marker's client x:
  // the gap's centre on one line, else the edge of the line the pointer is on.
  const splitAt = (x: number, y: number) => {
    const found = locate(), caret = caretAt(x, y), k = found && caret && found.text.at(caret.node, caret.offset);
    if (!found || k == null || k <= found.text.index(selected.start) || k >= found.text.index(selected.end) || !found.text.gap(k)) return null;
    const before = found.text.range(k - 1, k)!;
    // Without range geometry (jsdom) the hit test alone places the pointer.
    if (!before.getBoundingClientRect) return { k, text: found.text, x };
    const a = before.getBoundingClientRect(), b = found.text.range(k, k + 1)!.getBoundingClientRect();
    const on = (r: DOMRect) => y >= r.top && y <= r.bottom;
    const at = Math.abs(a.top - b.top) < a.height / 2 ? x >= a.right - 1 && x <= b.left + 1 && (a.right + b.left) / 2
      : on(a) && x >= a.right - 1 ? a.right + 2 : on(b) && x <= b.left + 1 && b.left - 2;
    return at === false ? null : { k, text: found.text, x: at };
  };
  const hover = (event: ReactPointerEvent) => {
    if (event.buttons || documentRef.current?.dataset.dragging) return clearSplit();
    const element = event.target as Element, scroller = element.closest(SCROLLERS);
    // Another citation under the pointer is tinted: a click makes it active.
    const over = element.closest<HTMLElement>('[data-citation-id]')?.dataset.citationId;
    if (over !== hot.current) {
      hot.current = over;
      documentRef.current?.querySelectorAll<HTMLElement>('.citation-band').forEach(band =>
        band.toggleAttribute('data-hot', !!over && band.dataset.id === over));
    }
    const band = scroller && (activeBand(scroller, event.clientX, event.clientY) ||
      (over === selected.id ? element.closest('[data-citation-id]')!.getBoundingClientRect() : undefined));
    const gap = band && scroller ? splitAt(event.clientX, event.clientY) : null;
    if (gap && gap.k === split.current?.k) return;
    clearSplit();
    if (gap) split.current = { k: gap.k, timer: setTimeout(() => {
      documentRef.current?.setAttribute('data-split', ''); showSplit(scroller!, { band: band!, x: gap.x });
    }, 350) };
  };
  /** A grip drags a citation or pinpoint edge from word to word. The band follows the pointer every
   * frame; release commits once and Escape cancels. */
  const grab = (event: ReactPointerEvent) => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>('.citation-grip')?.dataset.grip;
    const found = grip && locate(), root = documentRef.current, pin = !!grip?.startsWith('pin-');
    const span = pin ? selected.pinpointSpan : selected;
    if (!grip) return false;
    // A grip never starts a text selection, even while an edit is saving.
    event.preventDefault();
    if (!found || !root || !span || busy || event.button !== 0) return true;
    flushNudge(); clearSplit();
    const { text } = found, side = grip.endsWith('start') ? 'start' : 'end', pointer = event.pointerId;
    const [low, high] = pin ? [text.index(selected.start), text.index(selected.end)] : [0, text.count];
    let from = text.index(span.start), to = text.index(span.end), point: { x: number; y: number } | undefined, raf = 0;
    const follow = () => {
      raf = 0;
      const caret = point && caretAt(point.x, point.y), k = caret && text.at(caret.node, caret.offset);
      const edge = k == null ? null : side === 'start' ? text.snap(k, 'start', low, to - 1) : text.snap(k, 'end', from + 1, high);
      if (edge == null || edge === (side === 'start' ? from : to)) return;
      if (side === 'start') from = edge; else to = edge;
      preview.current = { [pin ? 'pinpoint' : 'range']: text.range(from, to) }; paint('active');
    };
    const move = (moved: PointerEvent) => { point = { x: moved.clientX, y: moved.clientY }; raf ||= requestAnimationFrame(follow); };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(raf); delete root.dataset.dragging;
      root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', cancel); removeEventListener('keydown', escape, true);
      if (root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
      const start = text.from(from), end = text.to(to);
      if (commit && (start !== span.start || end !== span.end))
        submit({ type: pin ? 'set-pinpoint-span' : 'set-citation-range', occurrenceId: selected.id, start, end });
      else { preview.current = {}; paint('active'); }
    };
    const up = () => finish(true), cancel = () => finish(false);
    const escape = (key: KeyboardEvent) => {
      if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); }
    };
    window.getSelection()?.removeAllRanges(); root.dataset.dragging = pin ? 'pin' : 'band';
    root.setPointerCapture(pointer);
    root.addEventListener('pointermove', move); root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', cancel); addEventListener('keydown', escape, true);
    return true;
  };
  const keys = (event: React.KeyboardEvent) => {
    const element = event.target as Element, key = event.key;
    if (event.ctrlKey || event.metaKey || element.closest('input,textarea,select,[role=dialog]')) return;
    // The document is focusable for selection only; it is never edited.
    if (element.closest('.docx-view-container,.citation-fallback') && (key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(key)))
      event.preventDefault();
    if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight') && !hasSelection) {
      event.preventDefault();
      if (!busy) nudgeEdge(event.altKey ? 'start' : 'end', key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.altKey || event.shiftKey && (key.startsWith('Arrow') || key === 'Enter') || busy && !key.startsWith('Arrow')) return;
    const listed = element.getAttribute('role') === 'option';
    if (key === 'ArrowUp' || key === 'ArrowDown') step(key === 'ArrowDown' ? 1 : -1, listed);
    else if (listed && (key === 'Home' || key === 'End')) step(key === 'Home' ? -Infinity : Infinity, true);
    else if ((key === 'p' || key === 'P') && selection?.unitId === selected.unitId)
      submit({ type: 'set-pinpoint-span', occurrenceId: selected.id, start: selection.start, end: selection.end });
    else if (key === 'Enter' && ownSelection && !element.closest('button'))
      submit({ type: 'set-citation-range', occurrenceId: selected.id, start: ownSelection.start, end: ownSelection.end });
    else if ((key === 'Enter' && !element.closest('button') || key === 'n' || key === 'N') && intent === 'new') addCitation();
    else if (key === 'Enter' && intent === 'other') { /* The note in the bar explains why nothing happens. */ }
    else if ((key === 'm' || key === 'M') && mergeable) submit({ type: 'merge-occurrence', occurrenceId: selected.id });
    else if ((key === 's' || key === 'S') && splitPoint != null) submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: splitPoint });
    else if (key === 'Delete') remove();
    else return;
    event.preventDefault();
  };
  const readOnly = (event: React.SyntheticEvent) => {
    if ((event.target as Element).closest('.docx-view-container,.citation-fallback')) event.preventDefault();
  };
  const linked = authorityById.get(selected.reference?.targetAuthorityId ?? selected.authorityId ?? '');
  const referenceKind = selected.reference?.kind ?? selected.referenceKind;
  const options = [...new Map(navigation.flatMap(row => {
    const authority = !row.reference && authorityById.get(row.authorityId ?? ''), place = unitById.get(row.unitId);
    if (!authority || !place) return [];
    const group = place.kind === 'footnote' ? `Footnote ${place.footnoteId ?? place.ordinal + 1}` : 'In-text';
    return [[`${group}\0${authority.id}`, { authorityId: authority.id, group, label: authorityName(authority),
      description: authority.citation ?? '' }]] as const;
  })).values()];
  const cited = new Set(options.map(option => option.authorityId));
  for (const authority of authorities) if (!cited.has(authority.id)) options.push({ authorityId: authority.id,
    group: 'Other authorities', label: authorityName(authority), description: authority.citation ?? '' });
  // A supra, ibid or short form names its authority by reference; a full citation is relinked.
  const link = (authorityId: string | null) => selected.kind === 'reference'
    ? referenceKind && submit({ type: 'set-reference', occurrenceId: selected.id,
      reference: authorityId ? { kind: referenceKind, targetAuthorityId: authorityId } : null })
    : submit({ type: 'relink-occurrence', occurrenceId: selected.id, authorityId });
  const finding = discrepancies.find(item => item.occurrenceId === selected.id), pinpoint = pinpointText(selected);
  return <div ref={reviewRef} className="authorities-review citation-review" tabIndex={-1} onKeyDown={keys}>
    <div ref={listRef} className="citation-outline" role="listbox" aria-label="Citations" onClick={event => {
      const id = (event.target as Element).closest<HTMLElement>('[role=option]')?.dataset.id;
      if (id) choose(id, true);
    }}>
      {outline}
    </div>
    <div ref={documentRef} className="citation-document"
      onPointerMove={hover} onPointerDown={event => {
        if (grab(event)) return;
        // Keep keyboard review alive after a click in the text, which the PDF layer keeps unfocused.
        if (!reviewRef.current?.contains(document.activeElement)) reviewRef.current?.focus({ preventScroll: true });
      }}
      onPointerLeave={() => {
        clearSplit(); hot.current = undefined;
        documentRef.current?.querySelectorAll('[data-hot]').forEach(band => band.removeAttribute('data-hot'));
      }}
      onMouseUp={rememberSelection} onKeyUp={rememberSelection} onBeforeInput={readOnly} onPaste={readOnly} onDrop={readOnly}
      onClick={event => {
        if (!window.getSelection()?.isCollapsed || busy) return;
        const element = event.target as Element, armed = split.current?.k;
        const gap = documentRef.current?.hasAttribute('data-split') && splitAt(event.clientX, event.clientY);
        if (gap && gap.k === armed) {
          event.preventDefault(); clearSplit();
          return submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: gap.text.from(gap.k) });
        }
        const mark = element.closest<HTMLElement>('[data-citation-id]');
        if (mark?.dataset.citationId) { event.preventDefault(); choose(mark.dataset.citationId, false); }
      }}>
      {source ? pdf ? <PdfCanvas bytes={source.pdf} rounded={false} ariaLabel="Source document"
        onUnavailable={() => setError('The document preview could not be opened.')}
        onTextReady={(page, element) => decorate(element.querySelector<HTMLElement>('.pdf-text-layer') ?? element, page)} />
        : <DocxCanvas bytes={source.buffer} maxZoom={1.25} onReady={() => setReady(value => value + 1)}
          onUnavailable={() => setError('The document preview could not be opened.')} />
        : !error && <p className="citation-source-status" role="status">Opening document…</p>}
      {(error || source && !located && ready > 0) && <div className="citation-fallback" data-full={error ? '' : undefined}>
        <p>{error || 'This passage could not be located in the document.'}</p>
        <div ref={fallbackRef} contentEditable suppressContentEditableWarning role="textbox" aria-readonly="true"
          aria-multiline="true" aria-label={`${unit.kind === 'footnote' ? 'Footnote' : 'In-text citation'} context`}
          spellCheck={false}>{unit.text}</div>
      </div>}
    </div>
    {/* Controls in labelled groups that keep their places: moving, editing the citation, its pinpoint, its authority. */}
    <div className="citation-panel">
      <div role="group" aria-labelledby="citation-group-navigate" className="citation-group-navigate">
        <h4 id="citation-group-navigate">Navigate <kbd>↑</kbd><kbd>↓</kbd></h4>
        <div>
          <Button variant="ghost" size="icon-sm" aria-label="Previous citation" disabled={index < 1}
            onClick={() => step(-1)}><ChevronLeft /></Button>
          <span>{index + 1} of {navigation.length}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next citation" disabled={index === navigation.length - 1}
            onClick={() => step(1)}><ChevronRight /></Button>
        </div>
      </div>
      <div role="group" aria-labelledby="citation-group-citation" className="citation-group-citation">
        <h4 id="citation-group-citation">Citation{intent === 'other'
          ? <span role="status" className="citation-overlap">The selection overlaps another citation</span>
          : <span>Drag its handles or press Shift+← → to adjust; rest on a space to split there</span>}</h4>
        <div>
          <Button variant="outline" disabled={busy || intent !== 'new'} onClick={addCitation}
            title="Add the selected text as a new citation">Add citation <kbd>N</kbd></Button>
          <Button variant="outline" disabled={busy || !ownSelection} title="Make the selected text this citation"
            onClick={() => ownSelection && submit({ type: 'set-citation-range', occurrenceId: selected.id, start: ownSelection.start, end: ownSelection.end })}>
            Set to selection <kbd>Enter</kbd></Button>
          <Button variant="outline" disabled={busy || splitPoint == null} title="Split this citation at the word gap by the cursor"
            onClick={() => splitPoint != null && submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: splitPoint })}>
            Split <kbd>S</kbd></Button>
          <Button variant="outline" disabled={busy || !mergeable}
            onClick={() => submit({ type: 'merge-occurrence', occurrenceId: selected.id })}>Merge with previous <kbd>M</kbd></Button>
          <Button variant="outline" disabled={busy} onClick={remove}>Not a citation <kbd>Del</kbd></Button>
        </div>
      </div>
      <div role="group" aria-labelledby="citation-group-pinpoint" className="citation-group-pinpoint">
        <h4 id="citation-group-pinpoint">Pinpoint <kbd>P</kbd></h4>
        <div>{pinpoint ? <span data-manual={selected.pinpointManual ? '' : undefined}
          title={selected.pinpointManual ? `at ${pinpoint}, set by hand` : `at ${pinpoint}`}>at {pinpoint}</span>
          : <span data-empty="">None</span>}
          {selected.pinpointManual && <button type="button" className="citation-reset" disabled={busy}
            onClick={() => submit({ type: 'reset-pinpoint', occurrenceId: selected.id })}>Reset to automatic</button>}</div>
      </div>
      <div role="group" aria-labelledby="citation-group-authority" className="citation-group-authority">
        <h4 id="citation-group-authority">Authority{selected.kind === 'reference' && <span>{referenceKind ?? 'reference'}</span>}</h4>
        <div>
          <AuthorityPicker options={options} current={linked} busy={busy || selected.kind === 'reference' && !referenceKind} onPick={link} />
          {finding && <Button variant="outline" onClick={() => onReview(finding.id)}>Review quotation</Button>}
        </div>
      </div>
    </div>
  </div>;
}
