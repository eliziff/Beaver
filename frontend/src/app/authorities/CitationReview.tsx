import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, ChevronUp, TextQuote, X } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { DocxCanvas } from '@/app/components/shared/views/DocxCanvas';
import { PdfCanvas } from '@/app/components/shared/views/PdfCanvas';
import type { WorkProductFocus } from '@/app/lib/workProducts';
import { errorMessage } from '@/app/lib/utils';
import { authorityLabel, authorityName } from './authorityPresentation';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesAction, AuthoritiesProduct, AuthorityOccurrence, AuthorityIdentity, AuthoritiesDiscrepancy } from './types';
import { caretAt, citationSelection, clearCitationMarks, locateCitationUnits, markCitations, marksOf, paintCitations,
  selectedUnit, unitText, wholeUnit, type CitationPaint, type CitationSelection, type LocatedUnit, type PaintMode,
  type UnitText } from './citationDocument';
import './citationReview.css';

type Unit = AuthoritiesProduct['state']['units'][number];
const SCROLLERS = '.beaver-pdf-scroll,.docx-view-scroll,.citation-fallback>div';
/** Each footnote's number as the document prints it. A note with the author's own mark (a "*") shows
 * that mark and takes no number. A draft imported before the printed number was kept counts the
 * marks its notes' text shows. */
function noteLabels(units: Unit[]) {
  const labels = new Map<string, string>();
  let marked = 0;
  for (const unit of units) if (unit.kind === 'footnote') {
    const mark = /^\s*([*†‡§¶]+)\s/u.exec(unit.text)?.[1];
    if (mark) marked++;
    labels.set(unit.id, unit.noteNumber === undefined ? mark ?? String((unit.footnoteId ?? unit.ordinal + 1) - marked)
      : unit.noteNumber === null ? mark ?? '*' : String(unit.noteNumber));
  }
  return labels;
}
/** A unit's citations as marked in the document: an edit marks again only the units it changed. */
const marking = (unit: Unit, occurrences: AuthoritiesProduct['state']['occurrences']) => unit.occurrenceIds.map(id => {
  const item = occurrences[id];
  return item ? `${id}:${item.start}:${item.end}` : '';
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
  const dismissed = Object.values(product.state.dismissedOccurrences ?? {}), labels = noteLabels(units);
  const row = (item: AuthorityOccurrence) => <Row key={item.id} row={item} finding={findings.has(item.id)} />;
  return <>
    {!!body.length && <div role="group" aria-labelledby="citation-body-heading">
      <h3 id="citation-body-heading">In-text</h3>{body.map(row)}</div>}
    {!!notes.length && <div role="group" aria-labelledby="citation-notes-heading">
      <h3 id="citation-notes-heading">Footnotes</h3>{notes.map(note => {
        const label = labels.get(note.id);
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

type Pin = AuthorityOccurrence['pinpoints'][number] & { start: number; end: number };
type PinpointEdit = Extract<AuthoritiesAction, { type: 'set-pinpoints' }>['pinpoints'];
/** A citation's pinpoints where its unit writes them, in or out of its range. One saved before
 * pinpoints kept their place takes the place of the pinpoint as written. */
function placedPins(item: AuthorityOccurrence): Pin[] {
  return item.pinpoints.flatMap(pin => {
    if (pin.start !== undefined && pin.end !== undefined) return [pin as Pin];
    const span = item.pinpointSpan, at = span ? item.pinpoints.length === 1 ? 0 : span.text.indexOf(pin.text) : -1;
    return span && at >= 0 ? [{ ...pin, start: span.start + at, end: item.pinpoints.length === 1 ? span.end
      : span.start + at + pin.text.length }] : [];
  });
}
/** Each locator kind by its symbol and name. Clicking a pinpoint's symbol steps through the first three. */
const KINDS: Record<string, [symbol: string, name: string]> = { paragraph: ['¶', 'Paragraph'], page: ['p.', 'Page'],
  section: ['s', 'Section'], subsection: ['ss', 'Subsection'], rule: ['r', 'Rule'], article: ['art', 'Article'],
  schedule: ['sch', 'Schedule'], footnote: ['n', 'Footnote'], clause: ['cl', 'Clause'] };
const CYCLE = ['paragraph', 'page', 'section'];
const PINPOINTS = 3;
const edit = (pins: Pin[]): PinpointEdit => pins.map(({ start, end, kind }) => ({ start, end, kind: kind as PinpointEdit[number]['kind'] }));

/** One chip per yellow pinpoint, in the order the text writes them: its kind's symbol, which
 * steps to the next kind, its value as written, and a remove. Room for three is kept whatever a
 * citation has; a fourth and more show as one count. "+ Pinpoint" adds the selected text. The chips
 * are drawn anew whenever any pinpoint changes, so none ever slides along the row. */
function PinpointChips({ occurrence, unitText, adding, onSet, onAdd }: {
  occurrence: AuthorityOccurrence; unitText: string; adding: boolean; onSet(pinpoints: PinpointEdit): void; onAdd(): void;
}) {
  const pins = placedPins(occurrence), shown = pins.length > PINPOINTS ? pins.slice(0, PINPOINTS - 1) : pins;
  const label = (pin: Pin) => `${KINDS[pin.kind]?.[0] ?? pin.kind} ${unitText.slice(pin.start, pin.end).replace(/\s+/gu, ' ')}`;
  const full = pins.length >= PINPOINTS, list = useRef<HTMLUListElement>(null);
  const drawn = `${occurrence.id}:${pins.map(({ start, end, kind }) => `${start}-${end}-${kind}`).join()}`;
  // A kind stepped from the keyboard keeps the focus on that chip's symbol.
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    list.current?.children[refocus.current]?.querySelector('button')?.focus(); refocus.current = null;
  });
  return <div role="group" aria-label="Pinpoints" className="citation-pins">
    <ul ref={list} className="citation-chips">
      {shown.map((pin, i) => {
        const [symbol, name] = KINDS[pin.kind] ?? [pin.kind, pin.kind], written = unitText.slice(pin.start, pin.end).replace(/\s+/gu, ' ');
        const next = CYCLE[(CYCLE.indexOf(pin.kind) + 1) % CYCLE.length], nextName = KINDS[next][1].toLowerCase();
        return <li key={`${drawn}:${i}`} className="citation-chip" title={`${name} ${written}`}>
          <button type="button" aria-label={`${name} ${written}: make it a ${nextName}`} title={`${name}; click for ${nextName}`}
            onClick={event => {
              if (event.currentTarget === document.activeElement) refocus.current = i;
              onSet(edit(pins.map((other, j) => j === i ? { ...other, kind: next } : other)));
            }}>{symbol}</button>
          <span>{written}</span>
          <button type="button" aria-label={`Remove pinpoint ${symbol} ${written}`} title="Remove this pinpoint"
            onClick={() => onSet(edit(pins.filter((_, j) => j !== i)))}><X aria-hidden="true" /></button>
        </li>;
      })}
      {pins.length > PINPOINTS && <li className="citation-chip" data-more title={pins.slice(PINPOINTS - 1).map(label).join(', ')}>
        <span>+{pins.length - PINPOINTS + 1} more</span></li>}
    </ul>
    <button type="button" className="citation-add-pin" disabled={!adding || full} aria-keyshortcuts="P"
      title={full ? 'A citation takes up to three pinpoints' : 'Select the pinpoint in the text, then add it (P)'}
      onClick={onAdd}>+ Pinpoint</button>
  </div>;
}

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
  // Each page's text layer as searched for citations (a page scrolled far away loses its layer, and
  // is searched again when drawn again), and each marked unit's citations.
  const decorated = useRef(new Map<number, HTMLElement>()), marked = useRef(new Map<string, string>());
  const preview = useRef<CitationPaint>({}), frame = useRef(0), mode = useRef<PaintMode | undefined>(undefined);
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
  const labels = useMemo(() => noteLabels(units), [units]);
  const authorityById = new Map(authorities.map(authority => [authority.id, authority]));
  const unit = selected && unitById.get(selected.unitId);
  const navigation = [...occurrences.filter(row => unitById.get(row.unitId)?.kind === 'body'), ...units.flatMap(unit =>
    unit.kind === 'footnote' ? unit.occurrenceIds.map(id => product.state.occurrences[id]).filter(Boolean) : [])];
  const occurrenceIndex = new Map(navigation.map((row, i) => [row.id, i]));
  const index = occurrenceIndex.get(selected?.id ?? '') ?? 0;
  // Choosing the selected citation again from the list brings it back into view.
  const choose = (id: string, scroll: boolean) => {
    if (id !== selected?.id) { scrollPending.current = scroll; onSelect(id); }
    else if (scroll) { scrollPending.current = true; activate(); }
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
  // arrives before the `selectionchange` that refreshes `selection`.
  const liveRange = () => window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
  const readSelection = () => {
    const range = liveRange(), location = !range || range.collapsed ? null : fallbackRef.current?.contains(range.startContainer)
      ? locate()?.location : selectedUnit(locations.current, range);
    if (location && !texts.current.has(location)) texts.current.set(location, unitText(location));
    const span = location && citationSelection(location, texts.current.get(location), range);
    return location && span && span.end > span.start ? { unitId: location.unit.id, ...span } : null;
  };
  const rememberSelection = () => setSelection(readSelection());
  // "layout" measures every band again; "active" redraws the active citation; "scroll" repaints only
  // when the pages in view change.
  /** Where the active citation's pinpoints are written in the rendered document. */
  const pinRanges = () => {
    const { selected, product } = live.current, own = selected && product.state.units.find(item => item.id === selected.unitId);
    const location = !selected || !own ? null : fallbackRef.current ? wholeUnit(own, fallbackRef.current)
      : locations.current.findLast(item => item.unit.id === own.id && item.root.isConnected);
    if (!selected || !location) return [];
    if (!texts.current.has(location)) texts.current.set(location, unitText(location));
    const text = texts.current.get(location)!;
    return placedPins(selected).flatMap(pin => text.range(text.index(pin.start), text.index(pin.end)) ?? []);
  };
  const paint = (next: PaintMode) => {
    cancelAnimationFrame(frame.current); frame.current = 0; mode.current = undefined;
    documentRef.current?.querySelectorAll<HTMLElement>(SCROLLERS).forEach(scroller =>
      paintCitations(scroller, { active: live.current.selected?.id, ...preview.current, pins: pinRanges }, next));
  };
  const repaint = (next: PaintMode) => {
    const rank = { scroll: 0, active: 1, layout: 2 };
    if (!mode.current || rank[next] > rank[mode.current]) mode.current = next;
    frame.current ||= requestAnimationFrame(() => paint(mode.current ?? 'scroll'));
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
    const found = locations.current.some(location => location.unit.id === selected.unitId && location.root.isConnected);
    setLocated(found || product.state.import.kind === 'document' && product.state.import.fileType === 'pdf' &&
      !pages.every(page => decorated.current.get(page)?.isConnected));
    const scroller = root.querySelector<HTMLElement>('.docx-view-scroll,.beaver-pdf-scroll');
    if (!scrollPending.current || !scroller) return;
    const view = scroller.getBoundingClientRect();
    // The document's own marks place the view; the passage shown below it when it is not found never does.
    const placed = marks.find(mark => !mark.closest('.citation-fallback'));
    if (placed) {
      scrollPending.current = false;
      const mark = placed.getBoundingClientRect();
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
    if (page) decorated.current.set(page, root);
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
    flushNudge(); rememberSelection(); activate(); paint('active');
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
  // The active citation's pinpoints are drawn again in the frame that shows their edit.
  const pinKey = selected && JSON.stringify(placedPins(selected).map(({ start, end }) => [start, end]));
  useLayoutEffect(() => { paint('active'); }, [pinKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bands follow the text through scrolling, zoom and layout changes.
  useEffect(() => {
    const root = documentRef.current, scroll = () => repaint('scroll');
    if (!root) return;
    const observer = window.ResizeObserver && new ResizeObserver(() => repaint('layout'));
    [root, ...root.querySelectorAll('.pdfViewer,.docx-view-container')].forEach(element => observer?.observe(element));
    root.addEventListener('scroll', scroll, true);
    return () => { observer?.disconnect(); root.removeEventListener('scroll', scroll, true); };
  }, [source, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancelAnimationFrame(frame.current); flushNudge(); }, []);
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
  const pins = placedPins(selected);
  /** A selection that can be a pinpoint of the active citation: in its unit, clear of its authority
   * and of its other pinpoints, inside its range or not. */
  const pinTarget = (span = selection) => span && span.unitId === selected.unitId && span.end > span.start &&
    !(span.start < selected.authoritySpan.end && selected.authoritySpan.start < span.end) &&
    !pins.some(pin => pin.start < span.end && span.start < pin.end) && pins.length < PINPOINTS ? span : null;
  const addPinpoint = (span = selection) => {
    const target = pinTarget(span);
    if (target) submit({ type: 'set-pinpoints', occurrenceId: selected.id,
      pinpoints: [...edit(pins), { start: target.start, end: target.end }] });
  };
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
  const hover = (event: ReactPointerEvent) => {
    if (event.buttons || documentRef.current?.dataset.dragging) return;
    // Another citation under the pointer is tinted: a click makes it active.
    const over = (event.target as Element).closest<HTMLElement>('[data-citation-id]')?.dataset.citationId;
    if (over === hot.current) return;
    hot.current = over;
    documentRef.current?.querySelectorAll<HTMLElement>('.citation-band').forEach(band =>
      band.toggleAttribute('data-hot', !!over && band.dataset.id === over));
  };
  /** A grip drags a citation edge from word to word. The band follows the pointer every frame;
   * release commits once and Escape cancels. */
  const grab = (event: ReactPointerEvent) => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>('.citation-grip')?.dataset.grip;
    const found = grip && locate(), root = documentRef.current;
    // The overlay holds the pointer while dragging: its few shapes take the drag cursor, not the whole text.
    const holder = (event.target as HTMLElement).closest<HTMLElement>('.citation-overlay');
    if (!grip) return false;
    // A grip never starts a text selection, even while an edit is saving.
    event.preventDefault();
    if (!found || !root || !holder || busy || event.button !== 0) return true;
    flushNudge();
    const { text } = found, side = grip === 'start' ? 'start' : 'end', pointer = event.pointerId;
    let from = text.index(selected.start), to = text.index(selected.end), point: { x: number; y: number } | undefined, raf = 0;
    const follow = () => {
      raf = 0;
      const caret = point && caretAt(point.x, point.y), k = caret && text.at(caret.node, caret.offset);
      const edge = k == null ? null : side === 'start' ? text.snap(k, 'start', 0, to - 1) : text.snap(k, 'end', from + 1, text.count);
      if (edge == null || edge === (side === 'start' ? from : to)) return;
      if (side === 'start') from = edge; else to = edge;
      preview.current = { range: text.range(from, to) }; paint('active');
    };
    const move = (moved: PointerEvent) => { point = { x: moved.clientX, y: moved.clientY }; raf ||= requestAnimationFrame(follow); };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(raf); delete root.dataset.dragging;
      root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', cancel); removeEventListener('keydown', escape, true);
      if (holder.hasPointerCapture(pointer)) holder.releasePointerCapture(pointer);
      holder.style.cursor = '';
      const start = text.from(from), end = text.to(to);
      if (commit && (start !== selected.start || end !== selected.end))
        submit({ type: 'set-citation-range', occurrenceId: selected.id, start, end });
      else { preview.current = {}; paint('active'); }
    };
    const up = () => finish(true), cancel = () => finish(false);
    const escape = (key: KeyboardEvent) => {
      if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); }
    };
    window.getSelection()?.removeAllRanges(); root.dataset.dragging = '';
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
    const now = readSelection(), meaning = intentOf(now);
    if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight') && !now) {
      event.preventDefault();
      if (!busy) nudgeEdge(event.altKey ? 'start' : 'end', key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.altKey || event.shiftKey && (key.startsWith('Arrow') || key === 'Enter') || busy && !key.startsWith('Arrow')) return;
    const listed = element.getAttribute('role') === 'option';
    if (key === 'ArrowUp' || key === 'ArrowDown') step(key === 'ArrowDown' ? 1 : -1, listed);
    else if (listed && (key === 'Home' || key === 'End')) step(key === 'Home' ? -Infinity : Infinity, true);
    else if (key === 'Enter' && meaning === 'active' && now && !element.closest('button'))
      submit({ type: 'set-citation-range', occurrenceId: selected.id, start: now.start, end: now.end });
    else if ((key === 'Enter' && !element.closest('button') || key === 'n' || key === 'N') && meaning === 'new') addCitation(now);
    else if ((key === 'p' || key === 'P') && pinTarget(now)) addPinpoint(now);
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
    const note = place.kind === 'footnote' ? labels.get(place.id) : undefined;
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
  const finding = discrepancies.find(item => item.occurrenceId === selected.id);
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
        hot.current = undefined;
        documentRef.current?.querySelectorAll('[data-hot]').forEach(band => band.removeAttribute('data-hot'));
      }}
      onMouseUp={rememberSelection} onKeyUp={rememberSelection} onBeforeInput={readOnly} onPaste={readOnly} onDrop={readOnly}
      onClick={event => {
        if (!window.getSelection()?.isCollapsed || busy) return;
        const mark = (event.target as Element).closest<HTMLElement>('[data-citation-id]');
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
    {/* One bar in fixed zones: where you are, what the citation refers to and its pinpoints, and edits to it. */}
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
      </div>
      <PinpointChips occurrence={selected} unitText={unit.text} adding={!!pinTarget()}
        onSet={pinpoints => submit({ type: 'set-pinpoints', occurrenceId: selected.id, pinpoints })} onAdd={() => addPinpoint()} />
      {/* Its room is kept when there is nothing to review, so nothing beside it moves. */}
      <button type="button" className="citation-quote" style={finding ? undefined : { visibility: 'hidden' }}
        aria-label="Review quotation" onClick={() => finding && onReview(finding.id)}>
        <TextQuote aria-hidden="true" /><span>Review quotation</span></button>
      <div role="group" aria-label="Edit citation" className="citation-edit">
        <Button variant="outline" disabled={busy || intent !== 'new'} onClick={() => addCitation()} aria-keyshortcuts="N"
          title={intent === 'other' ? 'The selection overlaps another citation' : 'Add the selected text as a citation (N)'}>Add citation</Button>
        <Button variant="outline" disabled={busy} onClick={remove} aria-keyshortcuts="Delete Control+Z"
          title="Not a citation (Delete). Ctrl+Z restores it, as does Restore under Not citations">Remove</Button>
      </div>
    </div>
  </div>;
}
