import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
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
import { citationSelection, clearCitationMarks, locateCitationUnits, markCitations,
  type CitationSelection, type LocatedUnit } from './citationDocument';
import './citationReview.css';

export function CitationReview({ product, host, sourceVersion, occurrences, selected, authorities, discrepancies,
  busy, onSelect, onAction, onReview, onFocusChange }: {
  product: AuthoritiesProduct; host: AuthoritiesHost; sourceVersion: number;
  occurrences: AuthorityOccurrence[]; selected?: AuthorityOccurrence; authorities: AuthorityIdentity[];
  discrepancies: AuthoritiesDiscrepancy[]; busy: boolean; onSelect(id: string): void;
  onAction(action: AuthoritiesAction, done?: (next: AuthoritiesProduct) => void): void;
  onReview(id: string): void; onFocusChange?(focus?: WorkProductFocus): void;
}) {
  const documentRef = useRef<HTMLDivElement>(null), fallbackRef = useRef<HTMLDivElement>(null);
  const locations = useRef<LocatedUnit[]>([]), options = useRef<Array<HTMLButtonElement | null>>([]);
  const [source, setSource] = useState<{ buffer: ArrayBuffer; pdf: Uint8Array }>();
  const [error, setError] = useState(''), [ready, setReady] = useState(0);
  const [selection, setSelection] = useState<CitationSelection | null>(null), [linkOpen, setLinkOpen] = useState(false);
  const [located, setLocated] = useState(false);
  const { units } = product.state, imported = product.state.import;
  // Source gathering returns fresh objects without changing citation geometry.
  // Replacing those marks would discard the browser's current text selection.
  const citationKey = useMemo(() => JSON.stringify([units, product.state.occurrences]),
    [units, product.state.occurrences]);
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
  const linked = selected?.reference && authorityById.get(selected.reference.targetAuthorityId);
  const referenceKind = selected?.reference?.kind ?? selected?.referenceKind;
  const finding = selected && findingById.get(selected.id);
  const hasSelection = !!selection && selection.end > selection.start;
  const current = useEffectEvent(() => ({ product, selected, units, onSelect }));
  const rememberSelection = () => {
    const fallback = fallbackRef.current;
    setSelection((fallback && unit ? citationSelection({ unit, root: fallback, start: 0,
      end: unit.text.normalize('NFKC').replace(/[\s\u00ad]/gu, '').length }) : null) ??
      locations.current.filter(item => item.unit.id === unit?.id).map(citationSelection).find(Boolean) ?? null);
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

  const activate = useEffectEvent((scroll = false) => {
    const { selected } = current(), root = documentRef.current;
    if (!root || !selected) return;
    let first: HTMLElement | undefined;
    root.querySelectorAll<HTMLElement>('[data-citation-id]').forEach(mark => {
      const active = mark.dataset.citationId === selected.id;
      mark.dataset.active = String(active); if (active) first ??= mark;
    });
    setLocated(locations.current.some(location => location.unit.id === selected.unitId));
    if (scroll && first) {
      const scroller = first.closest<HTMLElement>('.docx-view-scroll,.beaver-pdf-scroll');
      if (scroller) {
        const box = scroller.getBoundingClientRect(), mark = first.getBoundingClientRect();
        if (mark.top < box.top + 36 || mark.bottom > box.bottom - 36)
          scroller.scrollTop += mark.top - box.top - 32;
      }
    }
  });
  const decorate = useEffectEvent((root: HTMLElement, page?: number, focus = !page) => {
    clearCitationMarks(root);
    const found = locateCitationUnits(root, current().units, page);
    locations.current = page ? [...locations.current.filter(item => item.root !== root), ...found] : found;
    markCitations(found, current().product.state.occurrences); activate(focus);
    if (page) setReady(value => value || 1);
  });
  useEffect(() => {
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
  }, [ready, source, citationKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelection(locations.current.filter(item => item.unit.id === selected?.unitId)
      .map(citationSelection).find(Boolean) ?? null);
    activate(true);
  }, [selected?.id]);
  useEffect(() => {
    const root = fallbackRef.current;
    if (!root || !unit || !selected) return;
    clearCitationMarks(root);
    markCitations([{ unit, root, start: 0, end: unit.text.length }], product.state.occurrences);
    root.querySelectorAll<HTMLElement>('[data-citation-id]').forEach(mark => {
      mark.dataset.active = String(mark.dataset.citationId === selected.id);
    });
  }, [error, located, ready, source, selected?.id, citationKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.addEventListener('selectionchange', rememberSelection);
    return () => document.removeEventListener('selectionchange', rememberSelection);
  }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onFocusChange?.(selected ? { itemId: selected.id, ...(selection && { selection }) } : undefined); },
    [selected?.id, selection, onFocusChange]);
  useEffect(() => () => onFocusChange?.(), [onFocusChange]);

  if (!selected || !unit) return <p className="p-8 text-sm text-gray-500">No citations found.</p>;
  const submit = (action: AuthoritiesAction) => onAction(action, () => {
    window.getSelection()?.removeAllRanges(); setSelection(null);
  });
  const item = (row: AuthorityOccurrence) => {
    const position = occurrenceIndex.get(row.id)!, authority = authorityById.get(row.authorityId ?? '');
    return <button key={row.id} type="button" role="option" aria-selected={row.id === selected.id}
      ref={node => { options.current[position] = node; }} tabIndex={row.id === selected.id ? 0 : -1}
      onClick={() => onSelect(row.id)} title={row.text} onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? navigation.length - 1 :
          (position + (event.key === 'ArrowDown' ? 1 : -1) + navigation.length) % navigation.length;
        onSelect(navigation[next].id); options.current[next]?.focus();
      }}><span>{row.kind === 'reference' ? row.authoritySpan.text : authority ? authorityName(authority) : row.citation}</span>
      {authority && authorityName(authority) !== row.citation && row.kind !== 'reference' && <small>{row.citation}</small>}
      {findingById.has(row.id) && <small className="citation-finding">Check quotation</small>}</button>;
  };
  const pdf = imported.kind === 'document' && imported.fileType === 'pdf';
  return <div className="authorities-review citation-review">
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
    </div>
    <div className="citation-reader">
      <div ref={documentRef} className="citation-document"
        onMouseUp={rememberSelection} onKeyUp={rememberSelection}
        onBeforeInput={event => { if ((event.target as Element).closest('.docx-view-container')) event.preventDefault(); }}
        onPaste={event => { if ((event.target as Element).closest('.docx-view-container')) event.preventDefault(); }}
        onDrop={event => { if ((event.target as Element).closest('.docx-view-container')) event.preventDefault(); }}
        onKeyDown={event => {
          if ((event.target as Element).closest('.docx-view-container') &&
            ((!event.ctrlKey && !event.metaKey && event.key.length === 1) || ['Backspace', 'Delete', 'Enter'].includes(event.key))) event.preventDefault();
        }} onClick={event => {
        if (!window.getSelection()?.isCollapsed) return;
        const mark = (event.target as Element).closest<HTMLElement>('[data-citation-id]');
        if (mark?.dataset.citationId) { event.preventDefault(); onSelect(mark.dataset.citationId); }
      }}>
        {source ? pdf ? <PdfCanvas bytes={source.pdf} rounded={false} ariaLabel="Source document"
          quotes={[{ quote: selected.text, page: unit.pageNumbers[0] }]} quoteFocusKey={selected.id}
          onUnavailable={() => setError('The document preview could not be opened.')}
          onTextReady={(page, element, focus) => decorate(element.querySelector<HTMLElement>('.pdf-text-layer') ?? element, page, focus)} />
          : <DocxCanvas bytes={source.buffer} onReady={() => setReady(value => value + 1)}
            onUnavailable={() => setError('The document preview could not be opened.')} />
          : <p className="citation-source-status" role={error ? undefined : 'status'}>{error || 'Opening document…'}</p>}
      </div>
      {(error || source && !located && ready > 0) && <details className="citation-fallback" open>
        <summary>{error ? 'Review extracted text' : 'This passage could not be located. Review extracted text.'}</summary>
        <div ref={fallbackRef} contentEditable suppressContentEditableWarning role="textbox" aria-readonly="true"
          onMouseUp={rememberSelection} onKeyUp={rememberSelection}
          aria-multiline="true" aria-label={`${unit.kind === 'footnote' ? 'Footnote' : 'In-text citation'} context`}
          spellCheck={false} onBeforeInput={event => event.preventDefault()} onPaste={event => event.preventDefault()}
          onDrop={event => event.preventDefault()} onKeyDown={event => {
            if ((!event.ctrlKey && !event.metaKey && event.key.length === 1) || ['Backspace', 'Delete', 'Enter'].includes(event.key)) event.preventDefault();
          }}>{unit.text}</div>
      </details>}
      <div className="citation-controls">
        <div className="citation-tools">
          <Button variant="ghost" size="icon-sm" aria-label="Previous citation" disabled={index < 1}
            onClick={() => onSelect(navigation[index - 1].id)}><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next citation" disabled={index === navigation.length - 1}
            onClick={() => onSelect(navigation[index + 1].id)}><ChevronRight /></Button>
          <Button variant="outline" disabled={busy || !hasSelection} onMouseDown={event => event.preventDefault()}
            onClick={() => selection && submit({ type: 'set-citation-range', occurrenceId: selected.id, ...selection })}>Set citation</Button>
          <Button variant="outline" disabled={busy || !hasSelection} onMouseDown={event => event.preventDefault()}
            onClick={() => selection && submit({ type: 'set-pinpoint-span', occurrenceId: selected.id, ...selection })}>Set pinpoint</Button>
          <Button variant="outline" disabled={busy || !selection || hasSelection || selection.start <= selected.start || selection.start >= selected.end}
            onMouseDown={event => event.preventDefault()} onClick={() => selection && submit({ type: 'split-occurrence', occurrenceId: selected.id, cursor: selection.start })}>Split at cursor</Button>
          <Button variant="outline" disabled={busy || unit.occurrenceIds.indexOf(selected.id) < 1}
            onClick={() => submit({ type: 'merge-occurrence', occurrenceId: selected.id })}>Merge previous</Button>
          <Button variant="ghost" disabled={busy} onClick={() => submit({ type: 'remove-occurrence', occurrenceId: selected.id })}>Not a citation</Button>
        </div>
        <div className="citation-help"><span>Select text to set a citation or pinpoint.</span>
          <span className="citation-key"><i />Citation <i className="pinpoint-key" />Pinpoint</span></div>
        {finding && <Button variant="outline" onClick={() => onReview(finding.id)}>Review quotation</Button>}
        {selected.kind === 'reference' && <div className="citation-link">
          <span>{linked ? `Linked to ${authorityLabel(linked)}` : 'Not linked'}</span>
          <Button variant="outline" disabled={busy || !referenceKind} onClick={() => setLinkOpen(true)}><Link2 />Change link</Button>
          <Button variant="ghost" disabled={busy || !selected.reference}
            onClick={() => submit({ type: 'set-reference', occurrenceId: selected.id, reference: null })}>Clear link</Button>
        </div>}
      </div>
    </div>
    <SearchableChoiceModal open={linkOpen} title="Link to authority" size="md" searchLabel="Search authorities"
      value={selected.reference?.targetAuthorityId ?? null} closeOnSelect={false}
      options={authorities.map(row => ({ value: row.id, label: authorityLabel(row), disabled: busy }))}
      onClose={() => { if (!busy) setLinkOpen(false); }} onChange={id => {
        if (id && referenceKind) onAction({ type: 'set-reference', occurrenceId: selected.id,
          reference: { kind: referenceKind, targetAuthorityId: id } }, () => setLinkOpen(false));
      }} />
  </div>;
}
