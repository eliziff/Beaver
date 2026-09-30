import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Link2 } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { SearchableChoiceModal } from '@/app/components/modals/ModalSelect';
import { DocxCanvas } from '@/app/components/shared/views/DocxCanvas';
import { PdfCanvas } from '@/app/components/shared/views/PdfCanvas';
import type { WorkProductFocus } from '@/app/lib/workProducts';
import { errorMessage } from '@/app/lib/utils';
import { authorityLabel, authorityName } from './authorityPresentation';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesAction, AuthoritiesProduct, AuthorityOccurrence, AuthorityIdentity, AuthoritiesDiscrepancy } from './types';
import { activeBand, caretAt, citationSelection, clearCitationMarks, locateCitationUnits, markCitations, paintCitations,
  showSplit, unitText, wholeUnit, type CitationPaint, type CitationSelection, type LocatedUnit, type UnitText } from './citationDocument';
import './citationReview.css';

const SCROLLERS = '.beaver-pdf-scroll,.docx-view-scroll,.citation-fallback>div';
const LOCATORS: Record<string, [string, string]> = { paragraph: ['para', 'paras'], section: ['s', 'ss'] };
/** "para 35", "ss 3-4", "103": the parsed pinpoint with its locator. */
const pinpointText = ({ pinpointSpan, pinpoints }: AuthorityOccurrence) => {
  const text = pinpointSpan?.text ?? pinpoints.map(({ text }) => text).join(', ');
  const [one, many] = LOCATORS[pinpoints[0]?.kind] ?? [];
  // A pinpoint placed by hand may already carry its locator.
  return !text || !one || text.startsWith(one) ? text
    : `${pinpoints.length > 1 || pinpoints[0].text.includes('-') ? many : one} ${text}`;
};

export function CitationReview({ product, host, sourceVersion, occurrences, selected, authorities, discrepancies,
  busy, onSelect, onAction, onReview, onFocusChange }: {
  product: AuthoritiesProduct; host: AuthoritiesHost; sourceVersion: number;
  occurrences: AuthorityOccurrence[]; selected?: AuthorityOccurrence; authorities: AuthorityIdentity[];
  discrepancies: AuthoritiesDiscrepancy[]; busy: boolean; onSelect(id: string): void;
  onAction(action: AuthoritiesAction, done?: (next: AuthoritiesProduct) => void): void;
  onReview(id: string): void; onFocusChange?(focus?: WorkProductFocus): void;
}) {
  const reviewRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null), fallbackRef = useRef<HTMLDivElement>(null);
  const locations = useRef<LocatedUnit[]>([]), options = useRef<Array<HTMLButtonElement | null>>([]);
  const texts = useRef(new WeakMap<LocatedUnit, UnitText>());
  const preview = useRef<CitationPaint>({}), frame = useRef(0), forced = useRef(false);
  const [source, setSource] = useState<{ buffer: ArrayBuffer; pdf: Uint8Array }>();
  const [error, setError] = useState(''), [ready, setReady] = useState(0);
  const [selection, setSelection] = useState<CitationSelection | null>(null), [linkOpen, setLinkOpen] = useState(false);
  const [located, setLocated] = useState(false), [target, setTarget] = useState(selected);
  // Only outline and navigation choices move the view; a click in the document never does.
  const scrollPending = useRef(true);
  const { units } = product.state, imported = product.state.import;
  const sourceKey = JSON.stringify([product.id, product.state.bindings.source, sourceVersion]);
  const unitById = new Map(units.map(unit => [unit.id, unit]));
  const authorityById = new Map(authorities.map(authority => [authority.id, authority]));
  const findingById = new Map(discrepancies.map(finding => [finding.occurrenceId, finding]));
  const unit = selected && unitById.get(selected.unitId);
  const reviewUnits = units.filter(unit => unit.occurrenceIds.some(id => product.state.occurrences[id]));
  const body = occurrences.filter(row => unitById.get(row.unitId)?.kind === 'body');
  const notes = reviewUnits.filter(unit => unit.kind === 'footnote');
  const navigation = [...body, ...notes.flatMap(unit => unit.occurrenceIds.map(id => product.state.occurrences[id]).filter(Boolean))];
  const occurrenceIndex = new Map(navigation.map((row, i) => [row.id, i]));
  const index = occurrenceIndex.get(selected?.id ?? '') ?? 0;
  const current = useEffectEvent(() => ({ product, selected, units, onSelect }));
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
    const found = locate();
    setSelection(found ? citationSelection(found.location, found.text) : null);
  };

  useEffect(() => {
    let live = true; setSource(undefined); setError(''); setLocated(false); setReady(0); locations.current = [];
    void (async () => {
      if (!host.readSource || imported.kind !== 'document') throw new Error('The source document is unavailable.');
      const blob = await host.readSource(product, imported.bindingRole), buffer = await blob.arrayBuffer();
      if (live) setSource({ buffer, pdf: new Uint8Array(buffer) });
    })().catch(cause => { if (live) setError(errorMessage(cause)); });
    return () => { live = false; };
  }, [host, sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const paint = useEffectEvent(() => {
    const force = forced.current, active = current().selected?.id;
    frame.current = 0; forced.current = false;
    documentRef.current?.querySelectorAll<HTMLElement>(SCROLLERS).forEach(scroller =>
      paintCitations(scroller, { active, ...preview.current }, force));
  });
  const repaint = (force = true) => {
    forced.current ||= force;
    frame.current ||= requestAnimationFrame(() => paint());
  };
  const activate = useEffectEvent(() => {
    const { selected } = current(), root = documentRef.current;
    if (!root || !selected) return;
    let first: HTMLElement | undefined;
    root.querySelectorAll<HTMLElement>('[data-citation-id]').forEach(mark => {
      const active = mark.dataset.citationId === selected.id;
      mark.dataset.active = String(active); if (active) first ??= mark;
    });
    setLocated(locations.current.some(location => location.unit.id === selected.unitId));
    repaint();
    if (scrollPending.current && first) {
      scrollPending.current = false;
      const scroller = first.closest<HTMLElement>('.docx-view-scroll,.beaver-pdf-scroll');
      if (scroller) {
        const box = scroller.getBoundingClientRect(), mark = first.getBoundingClientRect();
        if (mark.top < box.top + 36 || mark.bottom > box.bottom - 36)
          scroller.scrollTop += mark.top - box.top - 32;
      }
    }
  });
  const decorate = useEffectEvent((root: HTMLElement, page?: number) => {
    clearCitationMarks(root);
    const found = locateCitationUnits(root, current().units, page);
    locations.current = page ? [...locations.current.filter(item => item.root !== root), ...found] : found;
    markCitations(found, current().product.state.occurrences); activate();
    if (page) setReady(value => value || 1);
  });
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
    rememberSelection();
    if (scrollPending.current) setTarget(selected);
    activate();
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = fallbackRef.current;
    if (!root || !unit || !selected) return;
    clearCitationMarks(root);
    markCitations([{ unit, root, start: 0, end: unit.text.length }], product.state.occurrences);
    root.querySelectorAll<HTMLElement>('[data-citation-id]').forEach(mark => {
      mark.dataset.active = String(mark.dataset.citationId === selected.id);
    });
    repaint();
  }, [error, located, ready, source, selected?.id, units, product.state.occurrences]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!busy) { preview.current = {}; repaint(); } }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bands follow the text through scrolling, zoom and layout changes.
  useEffect(() => {
    const root = documentRef.current, scroll = () => repaint(false);
    if (!root) return;
    const observer = window.ResizeObserver && new ResizeObserver(() => repaint());
    [root, ...root.querySelectorAll('.pdfViewer,.docx-view-container')].forEach(element => observer?.observe(element));
    root.addEventListener('scroll', scroll, true);
    return () => { observer?.disconnect(); root.removeEventListener('scroll', scroll, true); };
  }, [source, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    document.addEventListener('selectionchange', rememberSelection);
    return () => document.removeEventListener('selectionchange', rememberSelection);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onFocusChange?.(selected ? { itemId: selected.id, ...(selection && { selection }) } : undefined); },
    [selected?.id, selection, onFocusChange]);
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
      review.style.setProperty('--citation-review-height', `${Math.max(336, frame.clientHeight - top - 24)}px`);
    };
    fit(); addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [!!(selected && unit)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Text marked "Not a citation" stays listed so a wrong call can be taken back.
  const dismissed = Object.values(product.state.dismissedOccurrences ?? {});
  const notCitations = dismissed.length > 0 && <details className="citation-dismissed">
    <summary>Not citations ({dismissed.length})</summary>
    {dismissed.map(({ occurrence }) => <div key={occurrence.id}>
      <s title={occurrence.text}>{occurrence.citation || occurrence.text}</s>
      <Button type="button" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={busy}
        onClick={() => onAction({ type: 'restore-occurrence', occurrenceId: occurrence.id },
          () => onSelect(occurrence.id))}>Restore</Button>
    </div>)}
  </details>;
  if (!selected || !unit) return <div className="p-8 text-sm text-gray-500">
    <p>No citations found.</p>{notCitations}</div>;
  const submit = (action: AuthoritiesAction, then?: () => void) => onAction(action, () => {
    window.getSelection()?.removeAllRanges(); setSelection(null); then?.();
  });
  const step = (delta: number, focus = false) => {
    const next = index + delta;
    if (next < 0 || next >= navigation.length) return;
    choose(navigation[next].id, true);
    if (focus) options.current[next]?.focus();
  };
  // The reviewer keeps their place: the next citation becomes active where the view already is.
  const remove = () => {
    const next = navigation[index + 1] ?? navigation[index - 1];
    submit({ type: 'remove-occurrence', occurrenceId: selected.id }, () => { if (next) choose(next.id, false); });
  };
  const hasSelection = !!selection && selection.end > selection.start;
  const mergeable = unit.occurrenceIds.indexOf(selected.id) > 0;
  // Client x of the gap before character k: its centre on one line, else the line's end.
  const gapX = (text: UnitText, k: number) => {
    const a = text.range(k - 1, k)!.getBoundingClientRect(), b = text.range(k, k + 1)!.getBoundingClientRect();
    return Math.abs(a.top - b.top) < a.height / 2 ? (a.right + b.left) / 2 : a.right + 2;
  };
  // A split sits at a whitespace gap strictly inside the active citation, within a character of the pointer.
  const splitAt = (x: number, y: number) => {
    const found = locate(), caret = caretAt(x, y), k = found && caret && found.text.at(caret.node, caret.offset);
    if (!found || k == null) return null;
    const { text } = found, inside = (j: number) => j > text.index(selected.start) && j < text.index(selected.end) && text.gap(j);
    const near = inside(k) ? k : [k - 1, k + 1].filter(inside)
      .sort((a, b) => Math.abs(gapX(text, a) - x) - Math.abs(gapX(text, b) - x))[0];
    return near === undefined ? null : { k: near, text };
  };
  const hover = (event: ReactPointerEvent) => {
    if (event.buttons) return;
    const element = event.target as Element, scroller = element.closest(SCROLLERS);
    const band = scroller && activeBand(scroller, event.clientX, event.clientY);
    const over = !!band || element.closest<HTMLElement>('[data-citation-id]')?.dataset.citationId === selected.id;
    // The grips shown are those of the shape under the pointer: the pinpoint, or the citation.
    const pin = !!element.closest('[data-grip^=pin]') || !!scroller && !!activeBand(scroller, event.clientX, event.clientY, '.citation-pinpoint', 0);
    const hot = element.closest<HTMLElement>('[data-citation-id]')?.dataset.citationId;
    documentRef.current?.querySelectorAll<HTMLElement>('.citation-overlay').forEach(overlay => {
      if ((over || element.closest('.citation-grip')) && overlay.parentElement === scroller) overlay.dataset.hover = pin ? 'pin' : 'band';
      else delete overlay.dataset.hover;
      // Another citation under the pointer is tinted: a click makes it active.
      overlay.querySelectorAll<HTMLElement>('.citation-band').forEach(band => band.toggleAttribute('data-hot', band.dataset.id === hot));
    });
    const split = over && band ? splitAt(event.clientX, event.clientY) : null;
    documentRef.current?.toggleAttribute('data-split', !!split);
    if (!scroller) return;
    showSplit(scroller, split && band ? { band, x: gapX(split.text, split.k) } : undefined);
  };
  // Grips drag a citation or pinpoint edge from word to word; release commits the range.
  const grab = (event: ReactPointerEvent) => {
    const grip = (event.target as HTMLElement).closest<HTMLElement>('.citation-grip')?.dataset.grip, found = locate();
    if (!grip || !found || busy) return;
    event.preventDefault();
    const { text } = found, pin = grip.startsWith('pin-'), side = grip.endsWith('start') ? 'start' : 'end';
    const span = pin ? selected.pinpointSpan! : selected, root = documentRef.current!;
    const [low, high] = pin ? [text.index(selected.start), text.index(selected.end)] : [0, text.count];
    let from = text.index(span.start), to = text.index(span.end);
    const move = (event: PointerEvent) => {
      const caret = caretAt(event.clientX, event.clientY), k = caret && text.at(caret.node, caret.offset);
      const edge = k == null ? null : side === 'start' ? text.snap(k, side, low, to - 1) : text.snap(k, side, from + 1, high);
      if (edge == null) return;
      if (side === 'start') from = edge; else to = edge;
      preview.current = { [pin ? 'pinpoint' : 'range']: text.range(from, to) }; repaint();
    };
    const release = () => {
      removeEventListener('pointermove', move); delete root.dataset.dragging;
      const start = text.from(from), end = text.to(to);
      if (start === span.start && end === span.end) { preview.current = {}; repaint(); return; }
      submit({ type: pin ? 'set-pinpoint-span' : 'set-citation-range', occurrenceId: selected.id, start, end });
    };
    root.dataset.dragging = '';
    addEventListener('pointermove', move); addEventListener('pointerup', release, { once: true });
  };
  const keys = (event: React.KeyboardEvent) => {
    const element = event.target as Element, key = event.key;
    if (event.altKey || event.ctrlKey || event.metaKey || linkOpen || element.closest('input,textarea,select,[role=dialog]')) return;
    // The document is focusable for selection only; it is never edited.
    if (element.closest('.docx-view-container,.citation-fallback') && (key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(key)))
      event.preventDefault();
    if (event.shiftKey && (key.startsWith('Arrow') || key === 'Enter') || busy && !key.startsWith('Arrow')) return;
    if (key === 'ArrowUp' || key === 'ArrowDown') step(key === 'ArrowDown' ? 1 : -1, element.getAttribute('role') === 'option');
    else if ((key === 'p' || key === 'P') && hasSelection) submit({ type: 'set-pinpoint-span', occurrenceId: selected.id, ...selection });
    else if (key === 'Enter' && hasSelection && !element.closest('button')) submit({ type: 'set-citation-range', occurrenceId: selected.id, ...selection });
    else if ((key === 'm' || key === 'M') && mergeable) submit({ type: 'merge-occurrence', occurrenceId: selected.id });
    else if (key === 'Delete') remove();
    else return;
    event.preventDefault();
  };
  const item = (row: AuthorityOccurrence) => {
    const position = occurrenceIndex.get(row.id)!, pinpoint = pinpointText(row);
    const authority = authorityById.get(row.reference?.targetAuthorityId ?? row.authorityId ?? '');
    const detail = row.kind === 'reference' ? row.authoritySpan.text : row.citation;
    const label = authority ? authorityName(authority) : detail;
    return <button key={row.id} type="button" role="option" aria-selected={row.id === selected.id}
      ref={node => { options.current[position] = node; }} tabIndex={row.id === selected.id ? 0 : -1}
      onClick={() => choose(row.id, true)} title={row.text} onKeyDown={event => {
        if (event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : navigation.length - 1;
        choose(navigation[next].id, true); options.current[next]?.focus();
      }}><span>{label}</span>{(label !== detail || pinpoint) && <small>
        {pinpoint && <em data-manual={row.pinpointManual ? '' : undefined}>at {pinpoint}</em>}
        {label !== detail && <span>{detail}</span>}</small>}
      {findingById.has(row.id) && <small className="citation-finding">Check quotation</small>}</button>;
  };
  const pdf = imported.kind === 'document' && imported.fileType === 'pdf';
  const readOnly = (event: React.SyntheticEvent) => {
    if ((event.target as Element).closest('.docx-view-container,.citation-fallback')) event.preventDefault();
  };
  const linkOptions = [...new Map(navigation.flatMap(row => {
    const authority = !row.reference && authorityById.get(row.authorityId ?? ''), note = unitById.get(row.unitId);
    if (!authority || !note) return [];
    const footnote = note.kind === 'footnote' ? `Footnote ${note.footnoteId ?? note.ordinal + 1}` : 'In-text';
    return [[`${footnote}\0${authority.id}`, { value: row.id, authorityId: authority.id, group: footnote,
      label: authorityName(authority), description: authority.citation, disabled: busy }]] as const;
  })).values()];
  const cited = new Set(linkOptions.map(option => option.authorityId));
  for (const authority of authorities) if (!cited.has(authority.id)) linkOptions.push({ value: `authority:${authority.id}`,
    authorityId: authority.id, group: 'Other authorities', label: authorityName(authority),
    description: authority.citation, disabled: busy });
  const linkTarget = (value: string | null) => linkOptions.find(option => option.value === value)?.authorityId;
  const linked = selected.reference && authorityById.get(selected.reference.targetAuthorityId);
  const referenceKind = selected.reference?.kind ?? selected.referenceKind;
  const finding = findingById.get(selected.id), pinpoint = pinpointText(selected);
  const named = authorityById.get(selected.reference?.targetAuthorityId ?? selected.authorityId ?? '');
  const name = named ? authorityName(named) : selected.citation;
  return <div ref={reviewRef} className="authorities-review citation-review" tabIndex={-1} onKeyDown={keys}>
    <div className="citation-outline" role="listbox" aria-label="Citations">
      {!!body.length && <div role="group" aria-labelledby="citation-body-heading">
        <h3 id="citation-body-heading">In-text</h3>{body.map(item)}</div>}
      {!!notes.length && <div role="group" aria-labelledby="citation-notes-heading">
        <h3 id="citation-notes-heading">Footnotes</h3>{notes.map(note => {
          const label = note.footnoteId ?? note.ordinal + 1;
          return <div key={note.id} className="citation-note" role="group" aria-label={`Footnote ${label}`}>
            <span className="citation-note-number" aria-hidden="true">{label}</span>
            <div>{note.occurrenceIds.map(id => product.state.occurrences[id]).filter(Boolean).map(item)}</div>
          </div>;
        })}</div>}
      {notCitations}
    </div>
    <div ref={documentRef} className="citation-document"
      onPointerMove={hover} onPointerDown={event => {
        grab(event);
        // Keep keyboard review alive after a click in the text, which the PDF layer keeps unfocused.
        if (!reviewRef.current?.contains(document.activeElement)) reviewRef.current?.focus({ preventScroll: true });
      }}
      onPointerLeave={() => {
        documentRef.current?.removeAttribute('data-split');
        documentRef.current?.querySelectorAll(SCROLLERS).forEach(scroller => showSplit(scroller));
        documentRef.current?.querySelectorAll('[data-hover],[data-hot]').forEach(element =>
          element.removeAttribute(element.hasAttribute('data-hot') ? 'data-hot' : 'data-hover'));
      }}
      onMouseUp={rememberSelection} onKeyUp={rememberSelection} onBeforeInput={readOnly} onPaste={readOnly} onDrop={readOnly}
      onClick={event => {
        if (!window.getSelection()?.isCollapsed || busy) return;
        const element = event.target as Element, scroller = element.closest(SCROLLERS);
        const split = (scroller && activeBand(scroller, event.clientX, event.clientY) ||
          element.closest<HTMLElement>('[data-citation-id]')?.dataset.citationId === selected.id) && splitAt(event.clientX, event.clientY);
        if (split) {
          event.preventDefault(); documentRef.current?.removeAttribute('data-split');
          return submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: split.text.from(split.k) });
        }
        const mark = element.closest<HTMLElement>('[data-citation-id]');
        if (mark?.dataset.citationId) { event.preventDefault(); choose(mark.dataset.citationId, false); }
      }}>
      {source ? pdf ? <PdfCanvas bytes={source.pdf} rounded={false} ariaLabel="Source document"
        quotes={target ? [{ quote: target.text, page: unitById.get(target.unitId)?.pageNumbers[0] }] : []}
        quoteFocusKey={target?.id}
        onUnavailable={() => setError('The document preview could not be opened.')}
        onTextReady={(page, element) => decorate(element.querySelector<HTMLElement>('.pdf-text-layer') ?? element, page)} />
        : <DocxCanvas bytes={source.buffer} onReady={() => setReady(value => value + 1)}
          onUnavailable={() => setError('The document preview could not be opened.')} />
        : !error && <p className="citation-source-status" role="status">Opening document…</p>}
      {(error || source && !located && ready > 0) && <div className="citation-fallback" data-full={error ? '' : undefined}>
        <p>{error || 'This passage could not be located in the document.'}</p>
        <div ref={fallbackRef} contentEditable suppressContentEditableWarning role="textbox" aria-readonly="true"
          aria-multiline="true" aria-label={`${unit.kind === 'footnote' ? 'Footnote' : 'In-text citation'} context`}
          spellCheck={false}>{unit.text}</div>
      </div>}
    </div>
    <aside className="citation-rail" aria-label="Citation">
      <div className="citation-rail-nav">
        <Button variant="ghost" size="icon-sm" aria-label="Previous citation" disabled={index < 1}
          onClick={() => step(-1)}><ChevronLeft /></Button>
        <span>{index + 1} of {navigation.length}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Next citation" disabled={index === navigation.length - 1}
          onClick={() => step(1)}><ChevronRight /></Button>
      </div>
      <div className="citation-rail-card">
        <strong title={name}>{name}</strong>
        <p title={selected.text}>{selected.text}</p>
        <div className="citation-rail-pin"><span>{pinpoint ? `at ${pinpoint}` : 'No pinpoint'}</span>
          {selected.pinpointManual && <button type="button" disabled={busy}
            onClick={() => submit({ type: 'reset-pinpoint', occurrenceId: selected.id })}>Reset to automatic</button>}</div>
        <div className="citation-rail-row">{selected.kind === 'reference' && <>
          <span title={linked ? authorityLabel(linked) : undefined}>{linked ? `Linked to ${authorityLabel(linked)}` : 'Not linked'}</span>
          <Button variant="outline" disabled={busy || !referenceKind} onClick={() => setLinkOpen(true)}><Link2 />Change link</Button>
          <Button variant="ghost" disabled={busy || !selected.reference}
            onClick={() => submit({ type: 'set-reference', occurrenceId: selected.id, reference: null })}>Clear link</Button>
        </>}{finding && <Button variant="outline" onClick={() => onReview(finding.id)}>Review quotation</Button>}</div>
      </div>
      <div className="citation-rail-actions">
        <Button variant="outline" disabled={busy || !mergeable}
          onClick={() => submit({ type: 'merge-occurrence', occurrenceId: selected.id })}>Merge with previous</Button>
        <Button variant="ghost" disabled={busy} onClick={remove}>Not a citation</Button>
      </div>
      <p className="citation-rail-keys">↑↓ move · Enter set · P pinpoint · M merge · Del remove</p>
    </aside>
    <SearchableChoiceModal open={linkOpen} title="Link to authority" size="md" searchLabel="Search authorities"
      value={linkOptions.find(option => option.authorityId === selected.reference?.targetAuthorityId)?.value ?? null}
      closeOnSelect={false} options={linkOptions}
      onClose={() => { if (!busy) setLinkOpen(false); }} onChange={value => {
        const id = linkTarget(value);
        if (id && referenceKind) onAction({ type: 'set-reference', occurrenceId: selected.id,
          reference: { kind: referenceKind, targetAuthorityId: id } }, () => setLinkOpen(false));
      }} />
  </div>;
}
