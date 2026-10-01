import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, ChevronUp, RotateCcw, TextQuote } from 'lucide-react';
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

type Unit = AuthoritiesProduct['state']['units'][number];
const SCROLLERS = '.beaver-pdf-scroll,.docx-view-scroll,.citation-fallback>div';
const LOCATORS: Record<string, [string, string]> = { paragraph: ['para', 'paras'], section: ['s', 'ss'] };
/** "para 35", "ss 3-4", "103": the parsed pinpoint with its locator. */
const pinpointText = ({ pinpointSpan, pinpoints }: AuthorityOccurrence) => {
  // The parsed values, whole even where a hand-placed pinpoint covers part of one; failing those,
  // the text placed, which may carry the "at" that introduces it.
  const text = (pinpoints.length ? pinpoints.map(({ text }) => text.replace(/-/gu, '–')).join(', ')
    : pinpointSpan?.text ?? '').replace(/^at\s+/u, '');
  const [one, many] = LOCATORS[pinpoints[0]?.kind] ?? [];
  // A pinpoint placed by hand may already carry its locator.
  return !text || !one || text.startsWith(one) ? text
    : `${pinpoints.length > 1 || pinpoints[0].text.includes('-') ? many : one} ${text}`;
};
/** A unit's citations as marked in the document: an edit marks again only the units it changed. */
const marking = (unit: Unit, occurrences: AuthoritiesProduct['state']['occurrences']) => unit.occurrenceIds.map(id => {
  const item = occurrences[id];
  return item ? `${id}:${item.start}:${item.end}:${item.pinpointSpan?.start}:${item.pinpointSpan?.end}` : '';
}).join('|');

/** An outline row: the citation as it reads in the article, with a quotation finding marked in its
 * padding. The review marks the selected row itself, so choosing another re-renders no row, and a
 * saved draft re-renders only the rows whose text it changed. */
const Row = memo(function Row({ row, finding }: { row: AuthorityOccurrence; finding: boolean }) {
  return <button type="button" role="option" data-id={row.id} aria-selected="false" tabIndex={-1} title={row.text}>
    <span>{row.text}</span>{finding && <i className="citation-finding" role="img" aria-label="Quotation to review" />}</button>;
}, (a, b) => a.finding === b.finding && a.row.id === b.row.id && a.row.text === b.row.text);

/** The citations in reading order, and the text marked "Not a citation", which stays listed so a
 * wrong call can be taken back. It renders again only when the draft or its review changes. */
const Outline = memo(function Outline({ product, occurrences, findings, busy, onRestore }: {
  product: AuthoritiesProduct; occurrences: AuthorityOccurrence[]; findings: Set<string>; busy: boolean; onRestore(id: string): void;
}) {
  const { units, occurrences: byId } = product.state;
  const kinds = new Map(units.map(unit => [unit.id, unit.kind]));
  const body = occurrences.filter(row => kinds.get(row.unitId) === 'body');
  const notes = units.filter(unit => unit.kind === 'footnote' && unit.occurrenceIds.some(id => byId[id]));
  const dismissed = Object.values(product.state.dismissedOccurrences ?? {});
  const row = (item: AuthorityOccurrence) => <Row key={item.id} row={item} finding={findings.has(item.id)} />;
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

const SECTIONS = ['In-text', 'Footnotes', 'Other authorities'] as const;
type AuthorityOption = { authorityId: string; section: typeof SECTIONS[number]; note?: string; label: string; description: string };
/** The authority a citation refers to, chosen from a searchable list that opens upward over the
 * document. It is laid out as the citation list is: the authorities cited in-text, each footnote's
 * under its number, then the rest. */
function AuthorityPicker({ options, current, busy, onPick }: {
  options: AuthorityOption[]; current?: AuthorityIdentity; busy: boolean; onPick(authorityId: string | null): void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Each opening starts unfiltered.
    if (!open) { setQuery(''); return; }
    root.current?.querySelector('[role=option][aria-selected=true]')?.scrollIntoView?.({ block: 'center' });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    addEventListener('pointerdown', outside, true);
    return () => removeEventListener('pointerdown', outside, true);
  }, [open]);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const shown = options.filter(option => words.every(word => `${option.label} ${option.description}`.toLowerCase().includes(word)));
  const pick = (authorityId: string | null) => { setOpen(false); trigger.current?.focus(); onPick(authorityId); };
  return <div ref={root} className="citation-authority" onKeyDown={event => {
    if (!open) return;
    // Keys inside the list stay in the list: arrows move between choices and Escape closes it.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...root.current!.querySelectorAll<HTMLElement>('[role=option],input')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }}>
    <button ref={trigger} type="button" className="citation-authority-trigger" disabled={busy} aria-haspopup="listbox"
      aria-expanded={open} aria-labelledby="citation-refers citation-authority-name"
      title={current ? authorityLabel(current) : undefined} onClick={() => setOpen(value => !value)}>
      <span id="citation-authority-name" data-empty={current ? undefined : ''}>{current ? authorityLabel(current) : 'No authority'}</span>
      <ChevronUp aria-hidden="true" />
    </button>
    {open && <div className="citation-authority-menu">
      <div role="listbox" aria-label="Authorities">
        {SECTIONS.map(section => {
          const items = shown.filter(option => option.section === section);
          const choice = (option: AuthorityOption) => <button key={option.authorityId} type="button" role="option"
            aria-selected={option.authorityId === current?.id} onClick={() => pick(option.authorityId)}>
            <span>{option.label}</span>{option.description !== option.label && <small>{option.description}</small>}</button>;
          return !!items.length && <div key={section} role="group" aria-label={section}>
            <h4 aria-hidden="true">{section}</h4>
            {section === 'Footnotes' ? [...new Set(items.map(option => option.note))].map(note =>
              <div key={note} role="group" aria-label={`Footnote ${note}`} className="citation-note">
                <span className="citation-note-number" aria-hidden="true">{note}</span>
                <div>{items.filter(option => option.note === note).map(choice)}</div>
              </div>) : items.map(choice)}
          </div>;
        })}
        {!shown.length && <p>No authority matches</p>}
        {current && <button type="button" role="option" aria-selected="false" className="citation-authority-unlink"
          onClick={() => pick(null)}>Unlink</button>}
      </div>
      <input autoFocus aria-label="Search authorities" placeholder="Search authorities" value={query}
        onChange={event => setQuery(event.target.value)} />
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
  // Pages whose text layer has been searched for citations, and each marked unit's citations.
  const decorated = useRef(new Set<number>()), marked = useRef(new Map<string, string>());
  const preview = useRef<CitationPaint>({}), frame = useRef(0), mode = useRef<PaintMode | undefined>(undefined);
  const split = useRef<{ k: number; cursor: number; shown: boolean; timer: ReturnType<typeof setTimeout> }>(undefined);
  const hot = useRef<string | undefined>(undefined);
  // Citations removed in this session, the latest last, for Ctrl+Z.
  const removed = useRef<string[]>([]);
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
  // The document is marked from scratch only when its text changes; edits mark their own units.
  const textKey = useMemo(() => units.map(unit => `${unit.id}:${unit.text.length}`).join(), [units]);
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
      : locations.current.find(item => item.unit.id === unit?.id && item.root.isConnected);
    if (!location) return null;
    if (!texts.current.has(location)) texts.current.set(location, unitText(location));
    return { location, text: texts.current.get(location)! };
  };
  // The document's selection, read again by every command: a key pressed straight after selecting
  // arrives before the `selectionchange` that refreshes `selection` and `splitPoint`.
  const liveRange = () => window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
  const readSplitPoint = () => {
    const range = liveRange(), own = range?.collapsed ? locate() : null, k = own && own.text.at(range!.startContainer, range!.startOffset);
    const low = own && selected ? own.text.index(selected.start) : 0, high = own && selected ? own.text.index(selected.end) : 0;
    let gap: number | null = null;
    if (own && k != null && k >= low && k <= high)
      for (let d = 0; gap == null && d <= high - low; d++) for (const j of [k - d, k + d])
        if (gap == null && j > low && j < high && own.text.gap(j)) gap = j;
    return own && gap != null ? own.text.from(gap) : null;
  };
  const readSelection = () => {
    const range = liveRange(), location = !range || range.collapsed ? null : fallbackRef.current?.contains(range.startContainer)
      ? locate()?.location : selectedUnit(locations.current, range);
    if (location && !texts.current.has(location)) texts.current.set(location, unitText(location));
    const span = location && citationSelection(location, texts.current.get(location), range);
    return location && span && span.end > span.start ? { unitId: location.unit.id, ...span } : null;
  };
  const rememberSelection = () => { setSplitPoint(readSplitPoint()); setSelection(readSelection()); };
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
  // Nothing outside the marker changes: restyling the whole document on every rest would stall it.
  const clearSplit = () => {
    clearTimeout(split.current?.timer); split.current = undefined;
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
    // A page's text layer is rebuilt on zoom and resize; the layer it replaced leaves with it.
    locations.current = page ? [...locations.current.filter(item => item.root !== root && item.root.isConnected), ...found] : found;
    if (page) decorated.current.add(page);
    markCitations(found, product.state.occurrences);
    for (const { unit } of found) marked.current.set(unit.id, marking(unit, product.state.occurrences));
    activate(); repaint('layout');
    if (page) setReady(value => value || 1);
  };

  useEffect(() => {
    let live = true; setSource(undefined); setError(''); setLocated(true); setReady(0);
    locations.current = []; decorated.current.clear(); marked.current.clear();
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
  }, [ready, source, textKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // An edit marks again only the units whose citations it changed, and paints before the frame shows.
  useLayoutEffect(() => {
    const { occurrences } = product.state, current = new Map(units.map(unit => [unit.id, unit]));
    const changed = new Set(units.filter(unit => marked.current.has(unit.id) &&
      marked.current.get(unit.id) !== marking(unit, occurrences)).map(unit => unit.id));
    // Unmarking joins the text nodes around a unit's marks, so every unit sharing that root is read afresh.
    const touched = new Set(locations.current.filter(item => changed.has(item.unit.id)).map(item => item.root));
    locations.current = locations.current.filter(item => item.root.isConnected).map(item => {
      const now = current.get(item.unit.id) ?? item.unit;
      if (changed.has(now.id)) clearCitationMarks(item.root, now.id);
      return touched.has(item.root) ? { ...item, unit: now } : Object.assign(item, { unit: now });
    });
    if (!changed.size) return;
    markCitations(locations.current.filter(item => changed.has(item.unit.id)), occurrences);
    for (const id of changed) marked.current.set(id, marking(current.get(id)!, occurrences));
    activate(); paint('layout');
  }, [units, product.state.occurrences]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    flushNudge(); rememberSelection(); clearSplit(); activate(); paint('active');
    [...listRef.current?.querySelectorAll<HTMLElement>('[role=option]') ?? []].find(row => row.dataset.id === selected?.id)
      ?.scrollIntoView?.({ block: 'nearest' });
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
  const findings = useMemo(() => new Set(discrepancies.map(item => item.occurrenceId)), [discrepancies]);
  const outline = <Outline product={product} occurrences={occurrences} findings={findings} busy={busy} onRestore={restore} />;
  if (!selected || !unit) return <div className="p-8 text-sm text-gray-500">
    <p>No citations found.</p>{outline}</div>;
  // An edit shows at once: the drag or nudge it previewed gives way to the citation as edited.
  const submit = (action: AuthoritiesAction, then?: (next: AuthoritiesProduct) => void) => {
    preview.current = {};
    onAction(action, next => { window.getSelection()?.removeAllRanges(); setSelection(null); then?.(next); });
  };
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
    removed.current.push(selected.id);
    submit({ type: 'remove-occurrence', occurrenceId: selected.id }, () => { if (next) choose(next.id, false); });
  };
  // What a selection means: a new citation where it touches none, the active citation's own range
  // where it touches that one, and nothing where it touches another.
  const intentOf = (span: typeof selection) => {
    const touched = span ? (unitById.get(span.unitId)?.occurrenceIds ?? []).filter(id => {
      const item = product.state.occurrences[id];
      return item && item.start < span.end && span.start < item.end;
    }) : [];
    return !span ? null : touched.includes(selected.id) ? 'active' : touched.length ? 'other' : 'new';
  };
  const intent = intentOf(selection);
  const mergeable = unit.occurrenceIds.indexOf(selected.id) > 0;
  /** A new citation from the selection; it becomes active where the view already is. */
  const addCitation = (span = selection) => {
    if (intentOf(span) !== 'new' || !span || busy) return;
    const { unitId, start, end } = span, before = new Set(unitById.get(unitId)?.occurrenceIds);
    submit({ type: 'add-occurrence', unitId, start, end }, next => {
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
    if (element.closest('.citation-split')) return;
    // Another citation under the pointer is tinted: a click makes it active.
    const over = element.closest<HTMLElement>('[data-citation-id]')?.dataset.citationId;
    if (over !== hot.current) {
      hot.current = over;
      documentRef.current?.querySelectorAll<HTMLElement>('.citation-band').forEach(band =>
        band.toggleAttribute('data-hot', !!over && band.dataset.id === over));
    }
    // The pinpoint's handles show only while the pointer is on the pinpoint or its handles.
    documentRef.current?.toggleAttribute('data-pin', !!scroller &&
      !!activeBand(scroller, event.clientX, event.clientY, '.citation-pinpoint,.citation-grip[data-grip^=pin]', 2));
    const band = scroller && (activeBand(scroller, event.clientX, event.clientY) ||
      (over === selected.id ? element.closest('[data-citation-id]')!.getBoundingClientRect() : undefined));
    const gap = band && scroller ? splitAt(event.clientX, event.clientY) : null;
    if (gap && gap.k === split.current?.k) return;
    clearSplit();
    if (!gap) return;
    const armed = split.current = { k: gap.k, cursor: gap.text.from(gap.k), shown: false as boolean, timer: setTimeout(() => {
      armed.shown = true; showSplit(scroller!, { band: band!, x: gap.x });
    }, 350) };
  };
  /** A grip drags a citation or pinpoint edge from word to word. The band follows the pointer every
   * frame; release commits once and Escape cancels. */
  const grab = (event: ReactPointerEvent) => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>('.citation-grip')?.dataset.grip;
    const found = grip && locate(), root = documentRef.current, pin = !!grip?.startsWith('pin-');
    // The overlay holds the pointer while dragging: its few shapes take the drag cursor, not the whole text.
    const holder = (event.target as HTMLElement).closest<HTMLElement>('.citation-overlay');
    const span = pin ? selected.pinpointSpan : selected;
    if (!grip) return false;
    // A grip never starts a text selection, even while an edit is saving.
    event.preventDefault();
    if (!found || !root || !holder || !span || busy || event.button !== 0) return true;
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
      if (holder.hasPointerCapture(pointer)) holder.releasePointerCapture(pointer);
      holder.style.cursor = '';
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
    holder.setPointerCapture(pointer); holder.style.cursor = 'ew-resize';
    root.addEventListener('pointermove', move); root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', cancel); addEventListener('keydown', escape, true);
    return true;
  };
  const keys = (event: React.KeyboardEvent) => {
    const element = event.target as Element, key = event.key;
    if (element.closest('input,textarea,select,[role=dialog]')) return;
    // Ctrl+Z takes back the last removal still listed under Not citations.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (key === 'z' || key === 'Z')) {
      const dismissed = product.state.dismissedOccurrences ?? {};
      while (removed.current.length && !dismissed[removed.current.at(-1)!]) removed.current.pop();
      const last = removed.current.pop();
      if (last && !busy) { event.preventDefault(); restore(last); }
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    // The document is focusable for selection only; it is never edited.
    if (element.closest('.docx-view-container,.citation-fallback') && (key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(key)))
      event.preventDefault();
    const now = readSelection(), meaning = intentOf(now), cut = readSplitPoint();
    if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight') && !now) {
      event.preventDefault();
      if (!busy) nudgeEdge(event.altKey ? 'start' : 'end', key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.altKey || event.shiftKey && (key.startsWith('Arrow') || key === 'Enter') || busy && !key.startsWith('Arrow')) return;
    const listed = element.getAttribute('role') === 'option';
    if (key === 'ArrowUp' || key === 'ArrowDown') step(key === 'ArrowDown' ? 1 : -1, listed);
    else if (listed && (key === 'Home' || key === 'End')) step(key === 'Home' ? -Infinity : Infinity, true);
    else if ((key === 'p' || key === 'P') && now?.unitId === selected.unitId)
      submit({ type: 'set-pinpoint-span', occurrenceId: selected.id, start: now.start, end: now.end });
    else if (key === 'Enter' && meaning === 'active' && now && !element.closest('button'))
      submit({ type: 'set-citation-range', occurrenceId: selected.id, start: now.start, end: now.end });
    else if ((key === 'Enter' && !element.closest('button') || key === 'n' || key === 'N') && meaning === 'new') addCitation(now);
    else if ((key === 'm' || key === 'M') && mergeable) submit({ type: 'merge-occurrence', occurrenceId: selected.id });
    else if ((key === 's' || key === 'S') && cut != null) submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: cut });
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
    const note = place.kind === 'footnote' ? String(place.footnoteId ?? place.ordinal + 1) : undefined;
    return [[`${note}\0${authority.id}`, { authorityId: authority.id, section: note ? 'Footnotes' : 'In-text', note,
      label: authorityName(authority), description: authority.citation ?? '' } as AuthorityOption]] as const;
  })).values()];
  const cited = new Set(options.map(option => option.authorityId));
  for (const authority of authorities) if (!cited.has(authority.id)) options.push({ authorityId: authority.id,
    section: 'Other authorities', label: authorityName(authority), description: authority.citation ?? '' });
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
        clearSplit(); hot.current = undefined; documentRef.current?.removeAttribute('data-pin');
        documentRef.current?.querySelectorAll('[data-hot]').forEach(band => band.removeAttribute('data-hot'));
      }}
      onMouseUp={rememberSelection} onKeyUp={rememberSelection} onBeforeInput={readOnly} onPaste={readOnly} onDrop={readOnly}
      onClick={event => {
        if (!window.getSelection()?.isCollapsed || busy) return;
        const element = event.target as Element, armed = split.current;
        if (armed?.shown && (element.closest('.citation-split') || splitAt(event.clientX, event.clientY)?.k === armed.k)) {
          event.preventDefault(); clearSplit();
          return submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: armed.cursor });
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
    {/* One bar in three fixed zones: where you are, what this citation means, and edits to it. */}
    <div className="citation-panel">
      <div role="group" aria-label="Citations" className="citation-nav">
        <Button variant="ghost" size="icon-sm" aria-label="Previous citation" title="Previous citation (↑)"
          aria-keyshortcuts="ArrowUp" disabled={index < 1} onClick={() => step(-1)}><ChevronLeft /></Button>
        <span>{index + 1} of {navigation.length}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Next citation" title="Next citation (↓)" aria-keyshortcuts="ArrowDown"
          disabled={index === navigation.length - 1} onClick={() => step(1)}><ChevronRight /></Button>
      </div>
      <div role="group" aria-label="This citation" className="citation-meaning">
        <span id="citation-refers">Refers to</span>
        <AuthorityPicker options={options} current={linked} busy={busy || selected.kind === 'reference' && !referenceKind} onPick={link} />
        <div className="citation-pin" data-empty={pinpoint ? undefined : ''}
          title={selected.pinpointManual ? 'Set by hand' : 'Found automatically'}>
          {pinpoint ? <>Pinpoint <b>{pinpoint}</b></> : 'No pinpoint'}
          {selected.pinpointManual && <><small>edited</small><button type="button" className="citation-reset" disabled={busy}
            aria-label="Reset the pinpoint" title="Reset to the pinpoint found automatically"
            onClick={() => submit({ type: 'reset-pinpoint', occurrenceId: selected.id })}><RotateCcw /></button></>}
        </div>
        {/* Its room is kept when there is nothing to review, so nothing beside it moves. */}
        <button type="button" className="citation-quote" style={finding ? undefined : { visibility: 'hidden' }}
          aria-label="Review quotation" onClick={() => finding && onReview(finding.id)}>
          <TextQuote aria-hidden="true" /><span>Review quotation</span></button>
      </div>
      <div role="group" aria-label="Edit citation" className="citation-edit">
        <Button variant="outline" disabled={busy || intent !== 'new'} onClick={() => addCitation()} aria-keyshortcuts="N"
          title={intent === 'other' ? 'The selection overlaps another citation' : 'Add the selected text as a citation (N)'}>Add</Button>
        <Button variant="outline" disabled={busy || splitPoint == null} aria-keyshortcuts="S"
          title="Split this citation at the space by the cursor (S), or rest the pointer on a space and click"
          onClick={() => splitPoint != null && submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: splitPoint })}>
          Split</Button>
        <Button variant="outline" disabled={busy || !mergeable} aria-keyshortcuts="M" title="Merge with the citation before it (M)"
          onClick={() => submit({ type: 'merge-occurrence', occurrenceId: selected.id })}>Merge</Button>
        <Button variant="outline" disabled={busy} onClick={remove} aria-keyshortcuts="Delete Control+Z"
          title="Not a citation (Delete). Ctrl+Z restores it, as does Restore under Not citations">Remove</Button>
      </div>
    </div>
  </div>;
}
