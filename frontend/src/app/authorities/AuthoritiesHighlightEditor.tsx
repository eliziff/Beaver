import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ChevronLeft, ChevronRight, Highlighter, MousePointer2, Pause, Pencil, Play, Redo2,
  Trash2, Undo2, X } from 'lucide-react';
import { Modal } from '@/app/components/modals/Modal';
import { Button, buttonClassName } from '@/app/components/ui/button';
import { StepSection } from './StepSection';
import { PdfView } from '@/app/components/shared/views/PdfView';
import type { AnnotationTool } from '../../../../shared/pdf/pdfAnnotationLayer';
import { cn, errorMessage } from '@/app/lib/utils';
import { decodeAnnotationSet, emptyAnnotationSet,
  type PdfAnnotation, type PdfAnnotationSet } from '../../../../shared/pdf-annotations.mjs';
import type { AuthoritiesHost } from './host';
import { OptionCards, type CardOption } from './OptionCards';
import { authoritiesProfile } from './profiles';
import type { SourceOcrPanel, SourceOcrStatus } from './sourceOcr';
import type { AuthoritiesAction, AuthoritiesBuildSettings, AuthoritiesProduct, AuthoritiesProfileId } from './types';

const ocrMessage = (status: SourceOcrStatus, total = status.textlessPages.length) =>
  status.state === 'done' ? 'Text recognition complete'
    : status.state === 'failed' ? status.error || 'Text recognition failed'
    : status.state === 'paused' ? `Recognition paused · ${status.recognized}/${total} pages`
    : status.state === 'cancelled' ? 'Text recognition cancelled'
    : `${status.waiting ? 'Waiting to recognize' : 'Recognizing text'} · ${status.recognized}/${total} pages`;
const ocrTone = (status: SourceOcrStatus) => status.state === 'failed' ? 'text-red-800' : 'text-gray-600';

/** Pause (or Resume) and Cancel for one recognition, in slots that stay put whatever its state. */
function OcrControls({ status, ocr, className, label }: { status: SourceOcrStatus; ocr: SourceOcrPanel; className: string; label: string }) {
  const pending = status.state === 'running' || status.state === 'paused';
  const resumable = ['paused', 'failed', 'cancelled'].includes(status.state);
  return <>
    <button type="button" className={cn(className, status.state === 'done' && 'invisible')}
      disabled={status.state === 'done'} title={resumable ? 'Resume' : 'Pause'}
      aria-label={`${resumable ? 'Resume' : 'Pause'} text recognition for ${status.name}`}
      onClick={() => resumable ? void ocr.begin([status], status.pages?.length ? status.pages : undefined)
        : void ocr.stop([status.role], true)}>
      {resumable ? <Play /> : <Pause />}<span className={label}>{resumable ? 'Resume' : 'Pause'}</span></button>
    <button type="button" className={cn(className, !pending && 'invisible')} disabled={!pending} title="Cancel"
      aria-label={`Cancel text recognition for ${status.name}`} onClick={() => void ocr.stop([status.role], false)}>
      <X /><span className={label}>Cancel</span></button>
  </>;
}
const ocrButton = cn(buttonClassName({ variant: 'outline', size: 'compact' }), 'border-gray-400');
const ocrBar = 'appearance-none overflow-hidden rounded-full bg-gray-100 [&::-moz-progress-bar]:bg-gray-500 [&::-webkit-progress-bar]:bg-gray-100 [&::-webkit-progress-value]:bg-gray-500';

/**
 * Text recognition for one scanned source, watched where the source is being used. Its two
 * controls keep fixed slots, so toggling Pause and Resume or finishing never moves anything.
 */
function SourceOcrProgress({ status, ocr }: { status: SourceOcrStatus; ocr: SourceOcrPanel }) {
  const total = status.textlessPages.length;
  const pending = status.state === 'running' || status.state === 'paused';
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-xs">
    <span role="status" className={cn('min-w-0 truncate', ocrTone(status))}
      title={status.state === 'failed' ? status.error : undefined}>{ocrMessage(status, total)}</span>
    <span className="flex h-8 items-center justify-end gap-1">
      <OcrControls status={status} ocr={ocr} className={cn(ocrButton, 'w-8 px-0')} label="sr-only" /></span>
    <progress value={status.recognized} max={total} aria-label={`Pages recognized in ${status.name}`}
      className={cn('col-span-full h-0.5 w-full', ocrBar, !pending && 'invisible')} />
  </div>;
}

/**
 * The same recognition inside one line of a list row: a short count in a fixed slot, a hairline
 * of progress under it and two icon buttons, so the row keeps its height from start to finish.
 * The full sentence is what assistive technology announces.
 */
export function SourceOcrInline({ status, ocr, className }: { status: SourceOcrStatus; ocr: SourceOcrPanel; className?: string }) {
  const total = status.textlessPages.length;
  const pending = status.state === 'running' || status.state === 'paused';
  const word = status.state === 'done' ? 'Recognized' : status.state === 'failed' ? 'Failed'
    : status.state === 'cancelled' ? 'Cancelled' : status.state === 'paused' ? 'Paused'
    : status.waiting ? 'Waiting' : 'Recognizing';
  const count = pending ? `${status.recognized}/${total}` : '';
  return <div className={cn('@container/ocr flex min-w-0 items-center gap-1 text-xs', className)}>
    <span role="status" className={cn('relative min-w-0 flex-1 truncate tabular-nums', ocrTone(status))}
      title={status.state === 'failed' ? status.error : ocrMessage(status, total)}>
      <span className="sr-only">{ocrMessage(status, total)}</span>
      <span aria-hidden><span className={cn(count && 'hidden @min-[6.5rem]/ocr:inline')}>{word} </span>{count}</span>
      <progress value={status.recognized} max={total} aria-hidden tabIndex={-1}
        className={cn('absolute inset-x-0 -bottom-0.5 h-0.5 w-full', ocrBar, !pending && 'invisible')} />
    </span>
    <OcrControls status={status} ocr={ocr} className={cn(ocrButton, 'size-8 shrink-0 px-0 [&_svg]:size-3.5')} label="sr-only" />
  </div>;
}

type Entry = Extract<AuthoritiesAction, { type: 'set-annotations' }>['entries'][number];
type Choice = { authorityId: string; bindingRole: string; sourceSha256: string; title: string };
type OpenPdf = {
  set: PdfAnnotationSet; history: PdfAnnotation[][]; position: number; warning: string;
  saved: PdfAnnotation[]; review: 'preparing' | 'ready' | 'edited';
};
const choicesFor = (product: AuthoritiesProduct, tabs: ReadonlyMap<string,string>): Choice[] =>
  product.state.authorityOrder.flatMap(id => {
    const authority = product.state.authorities[id];
    if (authority.excluded || authority.source.kind !== 'attached') return [];
    const sources = authority.source.sources;
    return sources.map(source => ({ authorityId: id, bindingRole: source.bindingRole,
      sourceSha256: source.sourceSha256,
      title: [tabs.get(id), authority.displayName || authority.name || authority.citation,
        ...(sources.length > 1 ? [source.language === 'fr' ? 'French' : 'English'] : [])].filter(Boolean).join(' — ') }));
  });

type Marking = AuthoritiesBuildSettings['passageMarking'];
// The colours the book's marks are written in (authoritiesAnnotations.ts), at their opacity.
const RED_LINE = 'rgb(191 20 20 / .9)', BLACK_LINE = 'rgb(20 20 20 / .9)', YELLOW = 'rgb(255 235 153 / .45)';
/** A page in miniature whose middle paragraph is cited, marked as the built book marks it. */
function MarkPreview({ type }: { type: Marking }) {
  const line = type === 'margin' ? RED_LINE : type === 'sidelined' ? BLACK_LINE : undefined;
  return <span aria-hidden="true" className="relative block h-10 w-14 shrink-0 overflow-hidden rounded border border-gray-400 bg-white">
    {[[5, 36], [14, 38], [20, 30], [29, 34]].map(([top, width]) =>
      <span key={top} className="absolute left-2.5 h-0.5 bg-gray-500" style={{ top, width }} />)}
    {line && <span className="absolute left-1 w-0.5" style={{ top: 12, height: 12, background: line }} />}
    {type === 'paragraph' && [12, 18].map(top => <span key={top} className="absolute left-2 h-1.5 mix-blend-multiply"
      style={{ top, width: 42, background: YELLOW }} />)}
    {(type === 'margin' || type === 'text') && <span className="absolute h-1.5 mix-blend-multiply"
      style={{ top: 12, left: 22, width: 20, background: YELLOW }} />}
  </span>;
}
export const PASSAGE_OPTIONS: ReadonlyArray<CardOption<Marking>> = [
  { value: 'margin', label: 'Red line and quote highlight', preview: <MarkPreview type="margin" />,
    detail: 'A red line beside each cited passage, and its quoted words highlighted in yellow.' },
  { value: 'sidelined', label: 'Black line', preview: <MarkPreview type="sidelined" />,
    detail: 'A black line beside each cited passage, with nothing highlighted.' },
  { value: 'paragraph', label: 'Paragraph highlight', preview: <MarkPreview type="paragraph" />,
    detail: 'Each cited paragraph or section highlighted in yellow.' },
  { value: 'text', label: 'Quote highlight', preview: <MarkPreview type="text" />,
    detail: 'Only the quoted words highlighted in yellow.' },
  { value: 'none', label: 'No passage marks', preview: <MarkPreview type="none" />,
    detail: 'Source pages stay unmarked.' },
];
const MARKED_PASSAGE_OPTIONS = PASSAGE_OPTIONS.filter(({ value }) => value !== 'none');
export const passageOptions = (profileId: AuthoritiesProfileId) =>
  authoritiesProfile(profileId).requirements?.markedPassages ? MARKED_PASSAGE_OPTIONS : PASSAGE_OPTIONS;

const savedSet = (product: AuthoritiesProduct, choice: Choice) => {
  const saved = product.state.authorities[choice.authorityId].annotations?.[choice.bindingRole];
  return saved?.sourceSha256 === choice.sourceSha256 ? decodeAnnotationSet(saved) : undefined;
};

type Prepared = { set: PdfAnnotationSet; warning: string };
type Ahead = { choice: Choice; result?: Promise<Prepared>; ready?: Prepared };
/** Automatic marks prepared before their source is opened, for one draft: all it asks of them but
 *  the step it is on and the marks saved, which preparing them reads neither of. */
type Store = { draft: string; product: AuthoritiesProduct; abort: AbortController; sources: Map<string, Ahead>;
  queue: Ahead[]; running: boolean };
const stores = new WeakMap<AuthoritiesHost, Store>(), draftKeys = new WeakMap<AuthoritiesProduct['state'], string>();
const draftKey = (product: AuthoritiesProduct) => {
  let key = draftKeys.get(product.state);
  if (key === undefined) draftKeys.set(product.state, key = `${product.id}\0${JSON.stringify(product.state,
    function (name, value) { return name === 'annotations' || name === 'stage' && this === product.state ? undefined : value; })}`);
  return key;
};
const sourceKey = (choice: Choice) => `${choice.bindingRole}\0${choice.sourceSha256}`;
const pageMarkedWarning = (labels: string[]) => labels.length
  ? `The cited page carries the mark for ${labels.join(', ')} because that paragraph's text was not found.` : '';
function storeFor(host: AuthoritiesHost, product: AuthoritiesProduct) {
  const draft = draftKey(product), held = stores.get(host);
  if (held?.draft === draft) return held;
  held?.abort.abort();
  const store: Store = { draft, product, abort: new AbortController(), sources: new Map(), queue: [], running: false };
  stores.set(host, store);
  return store;
}
/** A source's marks, prepared now if they are not already being prepared. A failure is not kept. */
function prepare(host: AuthoritiesHost, store: Store, ahead: Ahead) {
  const { product, abort: { signal } } = store, { authorityId, bindingRole, sourceSha256 } = ahead.choice;
  return ahead.result ??= (async () => {
    const { annotations, pageMarked } = await host.prepareAnnotations!(product, authorityId, bindingRole,
      () => host.readSource!(product, bindingRole, signal), signal);
    if (annotations.sourceSha256 !== sourceSha256) throw new Error('The marking source does not match this PDF.');
    return ahead.ready = { set: annotations, warning: pageMarkedWarning(pageMarked) };
  })().catch((error: unknown) => {
    if (store.sources.get(sourceKey(ahead.choice)) === ahead) store.sources.delete(sourceKey(ahead.choice));
    throw error;
  });
}
/** Queues sources' marks to be prepared one at a time, ahead of the rest when `first`; otherwise
 *  the smallest PDFs first, so that the most sources are ready soonest. */
function prepareAhead(host: AuthoritiesHost, product: AuthoritiesProduct, choices: Choice[], first = false) {
  if (!host.readSource || !host.prepareAnnotations) return;
  const store = storeFor(host, product);
  const size = ({ choice: { bindingRole } }: Ahead) => {
    const binding = product.state.bindings[bindingRole];
    return binding?.kind === 'local-file' ? binding.lastSeen.size : 0;
  };
  const items = choices.map(choice => store.sources.get(sourceKey(choice)) ??
    store.sources.set(sourceKey(choice), { choice }).get(sourceKey(choice))!).filter(item => !item.result);
  if (!first) items.sort((left, right) => size(left) - size(right));
  store.queue = first ? [...new Set([...items, ...store.queue])] : [...new Set([...store.queue, ...items])];
  if (store.running) return;
  store.running = true;
  void (async () => {
    for (let next: Ahead | undefined; stores.get(host) === store && (next = store.queue.shift());)
      await prepare(host, store, next).catch(() => { /* The editor prepares it again when it opens. */ });
    store.running = false;
  })();
}
/** Stops preparing ahead, keeping the marks already prepared. */
function stopAhead(host: AuthoritiesHost) {
  const store = stores.get(host);
  if (!store) return;
  store.queue = []; store.abort.abort(); store.abort = new AbortController();
  for (const [id, ahead] of store.sources) if (!ahead.ready) store.sources.delete(id);
}
/** The marks of the source on screen: at once if prepared, else prepared now, not behind the queue. */
function preparedMarks(host: AuthoritiesHost, product: AuthoritiesProduct, choice: Choice): Prepared | Promise<Prepared> {
  const store = storeFor(host, product), ahead = store.sources.get(sourceKey(choice));
  if (ahead?.ready) return ahead.ready;
  const item = ahead ?? store.sources.set(sourceKey(choice), { choice }).get(sourceKey(choice))!;
  store.queue = store.queue.filter(queued => queued !== item);
  return prepare(host, store, item);
}

/** Whether a source's automatic marks can be prepared now: none are saved, and its text is not
 *  still being recognized. */
const preparable = (product: AuthoritiesProduct, choice: Choice, tracked?: SourceOcrPanel['tracked']) =>
  !product.state.authorities[choice.authorityId].annotations?.[choice.bindingRole] &&
  !['running', 'paused'].includes(tracked?.[choice.bindingRole]?.state ?? '');
/**
 * Prepares each attached source's automatic marks in the background once its PDF is attached, so
 * the editor shows a source's marks the moment it opens. A scan still being recognized waits for
 * its text; a source with highlights saved is not prepared again. Without a draft, as while a
 * build runs, it stops, so nothing it reads competes with the build.
 */
export function useHighlightsAhead(host: AuthoritiesHost, product: AuthoritiesProduct | undefined,
  tracked?: SourceOcrPanel['tracked']) {
  const choices = product && product.state.outputMode !== 'table' && product.state.settings.passageMarking !== 'none'
    ? choicesFor(product, new Map()).filter(choice => preparable(product, choice, tracked)) : [];
  const key = product && choices.length ? `${draftKey(product)}\0${choices.map(sourceKey).join('\0')}` : '';
  useEffect(() => { if (key) prepareAhead(host, product!, choices); else stopAhead(host); }, [host, key]); // eslint-disable-line react-hooks/exhaustive-deps
}
/**
 * Highlights saved for review keep the marks they were prepared with, so a new choice prepares
 * their automatic marks again; marks the reviewer added stay. A source that cannot be read keeps
 * what it had.
 */
async function prepareAgain(product: AuthoritiesProduct, sources: Choice[], host: AuthoritiesHost,
  report: (done: number) => void) {
  const entries: Array<Entry | undefined> = [], failed: string[] = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
    for (let index = next++; index < sources.length; index = next++) {
      const source = sources[index];
      try {
        if (!host.readSource || !host.prepareAnnotations) throw new Error('Automatic marking is unavailable.');
        const file = await host.readSource(product, source.bindingRole);
        const { annotations } = await host.prepareAnnotations(product, source.authorityId, source.bindingRole, file);
        const kept = savedSet(product, source)!.marks.filter(mark => mark.origin === 'manual');
        entries[index] = { authorityId: source.authorityId, bindingRole: source.bindingRole,
          annotations: { ...annotations, marks: [...annotations.marks, ...kept] } };
      } catch { failed.push(source.title); }
      report(++done);
    }
  }));
  return { entries: entries.filter((entry): entry is Entry => !!entry), failed };
}

export function AuthoritiesHighlights({ product, tabs, host, busy, ocr, onAction, onSaved }: {
  product: AuthoritiesProduct; tabs: ReadonlyMap<string,string>; host: AuthoritiesHost; busy: boolean;
  ocr: SourceOcrPanel;
  onAction(action: AuthoritiesAction): void;
  onSaved(product: AuthoritiesProduct): void;
}) {
  const [open, setOpen] = useState(false);
  const choices = choicesFor(product, tabs);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [failure, setFailure] = useState('');
  // A new marking prepares again only once the draft is saved with it: the host prepares from
  // the saved draft. Before paint, so the cards never show it chosen and idle in between.
  const [pending, setPending] = useState<Marking>();
  useLayoutEffect(() => {
    if (!pending || product.state.settings.passageMarking !== pending) return;
    setPending(undefined);
    const saved = choicesFor(product, tabs).filter(choice => savedSet(product, choice));
    if (!saved.length) return;
    setProgress({ done: 0, total: saved.length });
    void prepareAgain(product, saved, host, done => setProgress({ done, total: saved.length }))
      .then(({ entries, failed }) => {
        setProgress(undefined);
        if (failed.length) setFailure(`Highlights could not be prepared again for ${failed.join(', ')}.`);
        // The save holds the workspace until it lands, as every other draft change does.
        if (entries.length) onAction({ type: 'set-annotations', entries });
      });
  }, [pending, product]); // eslint-disable-line react-hooks/exhaustive-deps
  useHighlightsAhead(host, product, ocr.tracked);
  if (product.state.outputMode === 'table') return null;
  const preparing = !!progress;
  const choose = (passageMarking: Marking) => {
    setFailure(''); setPending(passageMarking);
    onAction({ type: 'set-settings', settings: { passageMarking } });
  };
  // The marking chosen at import is shown here too, and can be changed at any time.
  return <><StepSection title="Highlights" className="mt-3"
    subtitle={choices.length ? 'Review and adjust passage marks in your source PDFs.' : 'No source PDFs to mark yet.'}
    actions={<Button type="button" variant="outline" className="h-9 border-gray-400"
      disabled={busy || preparing || !host.readSource || !choices.length} onClick={() => setOpen(true)}><Highlighter /> Edit in PDF</Button>}>
    <div className="p-4">
      <OptionCards legend="Passage marking" value={product.state.settings.passageMarking}
        options={passageOptions(product.state.settings.profileId)} columns disabled={busy || preparing}
        onChange={choose} />
      {/* Preparation reports in a line that is always there, so nothing moves while it runs. */}
      <div className="mt-3 min-h-9 text-sm">
        {preparing ? <div role="status" className="text-gray-700">
          Preparing highlights · {progress.done}/{progress.total}
          <progress value={progress.done} max={progress.total} aria-hidden
            className={cn('mt-1 block h-0.5 w-full max-w-64', ocrBar)} /></div>
          : failure && <p role="alert" className="text-red-800">{failure}</p>}
      </div>
    </div>
  </StepSection>
    {open && <AuthoritiesHighlightEditor product={product} choices={choices} host={host} ocr={ocr}
      onClose={() => setOpen(false)} onSaved={onSaved} />}
  </>;
}

/** Mark content independent of object key order, to tell whether stored highlights match. */
const marksKey = (marks: readonly PdfAnnotation[]) => JSON.stringify(marks.map(mark => [mark.id, mark.kind,
  mark.origin, mark.label, mark.excerpt, mark.rgb, mark.opacity,
  mark.fragments.map(fragment => [fragment.pageNumber, fragment.rects])]));

function AuthoritiesHighlightEditor({ product, choices: initialChoices, host, ocr, onClose, onSaved }: {
  product: AuthoritiesProduct; choices: Choice[]; host: AuthoritiesHost; ocr: SourceOcrPanel;
  onClose(): void; onSaved(product: AuthoritiesProduct): void;
}) {
  // A review edits one known revision; a concurrent write must not be silently overwritten.
  const [base] = useState(product);
  const revision = useRef(product.revision);
  const saveRequest = useRef<Promise<void> | null>(null);
  const [choices] = useState(initialChoices);
  const [role, setRole] = useState(choices[0].bindingRole);
  const [documents, setDocuments] = useState<Record<string,OpenPdf>>({});
  const [pdf, setPdf] = useState<{ role: string; bytes: Uint8Array; pageLabels?: Array<string | null> } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [highlightSelection, setHighlightSelection] = useState(0);
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [focus, setFocus] = useState<{ id: string; request: number }>();
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [textError, setTextError] = useState('');
  const cardRefs = useRef(new Map<string,HTMLLIElement>());
  const source = choices.find(choice => choice.bindingRole === role)!;
  const recognition = ocr.tracked[role];
  const neighbour = (step: number) => choices[(choices.indexOf(source)+step+choices.length)%choices.length];
  const go = (step: number) => setRole(neighbour(step).bindingRole);
  // The panel shows the source whose PDF is drawn until the next one's is, so a switch replaces the
  // PDF and its marks, status and recognition in the same frame instead of one after the other:
  // the panel changes in the task that draws the page.
  const [drawn, setDrawn] = useState<string>();
  const shown = pdf ? drawn ?? pdf.role : role, shownRecognition = ocr.tracked[shown];
  const current = documents[shown], marks = current?.history[current.position] ?? [];
  const onCanvas = pdf && documents[pdf.role], canvasMarks = onCanvas?.history[onCanvas.position] ?? [];
  // The count is the shown source's own, and only once its marks are known.
  const count = current && current.review !== 'preparing' ? marks.length : undefined;
  const visibleError = error || current?.warning || textError;
  const dirty = Object.values(documents).some(document => document.saved !== document.history[document.position]);
  // Edits wait while the next source opens; the controls keep their look meanwhile.
  const disabled = loading || !current;
  const changeDocument = (update: (document: OpenPdf) => OpenPdf) => setDocuments(values => {
    const document = values[role]; return document ? { ...values, [role]: update(document) } : values;
  });
  const edit = (update: (marks: PdfAnnotation[]) => PdfAnnotation[]) => {
    if (disabled) return;
    changeDocument(document => {
      const next = update(document.history[document.position]);
      const history = [...document.history.slice(0,document.position+1),next];
      // Shared immutable annotations keep undo inexpensive; do not clone entire PDFs or mark sets.
      return { ...document, history, position: history.length-1, review: 'edited' };
    });
  };
  const undo = () => { if (!disabled) changeDocument(document => ({...document,position:Math.max(0,document.position-1)})); };
  const redo = () => { if (!disabled) changeDocument(document => ({...document,position:Math.min(document.history.length-1,document.position+1)})); };
  const remove = (id: string) => { edit(marks => marks.filter(mark => mark.id !== id)); if (selectedId===id) setSelectedId(null); };
  const close = () => { if (!saving && !dirty) onClose(); };

  // Opening another source starts clean. Only the active PDF owns bytes;
  // mark histories survive source switches independently.
  const [openFor, setOpenFor] = useState({ role, source, base, host });
  if (openFor.role !== role || openFor.source !== source || openFor.base !== base || openFor.host !== host) {
    setOpenFor({ role, source, base, host });
    setSelectedId(null); setFocus(undefined); setError(''); setTextError('');
    setLoading(true);
  }
  const readDocument = useEffectEvent((key: string) => documents[key]);
  const preparableNow = useEffectEvent((choice: Choice) => preparable(base, choice, ocr.tracked));
  useEffect(() => {
    const abort = new AbortController();
    const saved = base.state.authorities[source.authorityId].annotations?.[role];
    const automatic = !saved && base.state.settings.passageMarking !== 'none';
    // This source's marks are prepared now, while its bytes are read.
    const marks = automatic && host.prepareAnnotations && host.readSource ? preparedMarks(host, base, source) : undefined;
    if (marks instanceof Promise) marks.catch(() => { /* Reported once its PDF is open. */ });
    // The sources after it come next, in the order the editor moves through them.
    const at = choices.indexOf(source);
    if (automatic) prepareAhead(host, base, [...choices.slice(at + 1), ...choices.slice(0, at)].filter(preparableNow), true);
    void (async () => {
      if (!host.readSource) throw new Error('This source cannot be opened.');
      const blob = await host.readSource(base, source.bindingRole, abort.signal);
      const bytes = new Uint8Array(await blob.arrayBuffer()); abort.signal.throwIfAborted();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))]
        .map(value => value.toString(16).padStart(2,'0')).join('');
      abort.signal.throwIfAborted();
      if (hash !== source.sourceSha256) throw new Error('This PDF changed. Relink the source before editing highlights.');
      setPdf({role, bytes});
      void host.readSourcePageLabels?.(base, role, abort.signal).then(pageLabels => {
        if (!abort.signal.aborted) setPdf(current => current?.role === role ? { ...current, pageLabels } : current);
      }).catch(() => { /* Unknown labels retain physical navigation. */ });
      const loaded = readDocument(role);
      setLoading(false);
      if (loaded && loaded.review !== 'preparing') return;
      if (saved && saved.sourceSha256 !== hash)
        throw new Error('Saved highlights belong to a different PDF. Relink the original PDF before editing them.');
      const set = saved ? decodeAnnotationSet(saved) : emptyAnnotationSet(hash);
      if (set.sourceSha256 !== hash) throw new Error("The marking source does not match this PDF.");
      // Decide against the current state, not a ref checked before React applies this update.
      const place = ({ set, warning }: Prepared, review: OpenPdf['review']) => setDocuments(values =>
        values[role] && values[role].review !== 'preparing' ? values : {...values,
          [role]:{set,history:[set.marks],position:0,warning,saved:set.marks,review}});
      // Marks prepared ahead open with their PDF, in the same step.
      const ready = !automatic ? { set, warning: '' } : marks instanceof Promise ? undefined : marks;
      if (ready) return place(ready, 'ready');
      place({ set, warning: '' }, 'preparing');
      let prepared: Prepared;
      try {
        if (!marks) throw new Error('Automatic marking is unavailable.');
        prepared = await marks;
      } catch (cause) {
        abort.signal.throwIfAborted(); prepared = { set: emptyAnnotationSet(hash), warning: errorMessage(cause) };
      }
      abort.signal.throwIfAborted();
      place(prepared, 'ready');
    })().catch(cause => { if (!abort.signal.aborted) { setPdf(null); setError(errorMessage(cause)); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [role, source, base, host, choices]);
  const loadRecognizedText = useCallback(async (page: number, signal: AbortSignal) => {
    try {
      const text = await host.readSourceText?.(base, role, signal, [page]);
      return text?.pages.find(item => item.pageNumber === page);
    } catch (cause) {
      if (!signal.aborted) setTextError(errorMessage(cause));
      return undefined;
    }
  }, [role, recognition?.state, recognition?.recognized, base, host]); // eslint-disable-line react-hooks/exhaustive-deps
  // New recognized text replaces a failed attempt to read it.
  const textKey = `${role}\n${recognition?.state}\n${recognition?.recognized}`;
  const [textFor, setTextFor] = useState(textKey);
  if (textFor !== textKey) { setTextFor(textKey); setTextError(''); }
  useEffect(() => { if(selectedId) cardRefs.current.get(selectedId)?.scrollIntoView({block:'nearest'}); },[selectedId]);
  useEffect(() => {
    if(!dirty) return;
    const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',guard); return ()=>window.removeEventListener('beforeunload',guard);
  },[dirty]);
  useEffect(() => { if (dirty && !saving && !loading && !error) void save(); }, [documents, saving, loading, error]);

  async function save() {
    if(saveRequest.current || loading) return;
    const entries:Entry[]=choices.flatMap(choice=>{
      const document=documents[choice.bindingRole];
      const unchanged = document && document.saved === document.history[document.position];
      return document && !unchanged ? [{authorityId:choice.authorityId,bindingRole:choice.bindingRole,
        annotations:{...document.set,marks:document.history[document.position]}}] : [];
    });
    if(!entries.length) return;
    setSaving(true);setError('');
    const before = Object.fromEntries(entries.map(entry => [entry.bindingRole, documents[entry.bindingRole].saved]));
    // One write owns one immutable snapshot; acknowledging it cannot acknowledge later edits.
    saveRequest.current = (async () => {
      try {
        const next=await host.act(base.id,revision.current,{type:'set-annotations',entries});
        revision.current = next.revision;
        setDocuments(values => {
          const updated = {...values};
          for (const entry of entries) updated[entry.bindingRole] = {
            ...values[entry.bindingRole], saved:entry.annotations.marks };
          return updated;
        });
        onSaved(next);
      } catch(cause) {
        setError(errorMessage(cause));
        // The write may have committed with its response lost, or an unrelated edit may have
        // moved the draft on; either way every retry would repeat the same revision conflict.
        // Continue from the stored revision only while these sources hold what this editor
        // last saved or just submitted: another reviewer's highlights are never overwritten.
        try {
          const stored = await host.drafts.get<AuthoritiesProduct['state']>(base.id);
          const held = (entry: Entry) => marksKey(stored.state.authorities[entry.authorityId]
            ?.annotations?.[entry.bindingRole]?.marks ?? []);
          if (entries.every(entry => held(entry) === marksKey(entry.annotations.marks))) {
            revision.current = stored.revision; setError('');
            setDocuments(values => {
              const updated = {...values};
              for (const entry of entries) updated[entry.bindingRole] = {
                ...values[entry.bindingRole], saved:entry.annotations.marks };
              return updated;
            });
            onSaved(stored as AuthoritiesProduct);
          } else if (entries.every(entry => held(entry) === marksKey(before[entry.bindingRole])))
            revision.current = stored.revision;
        } catch { /* offline: Retry resends to the revision last known */ }
      }
    })();
    try { await saveRequest.current; }
    finally { saveRequest.current = null; setSaving(false); }
  }
  return <>
    <Modal open onClose={close} ariaLabel="Highlights" size="2xl"
      className="h-[calc(100dvh-2rem)] max-w-[96rem]" bodyClassName="p-2">
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={event=>{
        const input=event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]');
        const arrow=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;
        if(input || arrow && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) || (arrow ? saving||choices.length<2 : disabled)) return;
        if(arrow) {event.preventDefault();go(arrow);}
        else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z') {
          event.preventDefault();event.stopPropagation();if(event.shiftKey)redo();else undo();
        } else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y') {event.preventDefault();redo();}
        else if((event.key==='Delete'||event.key==='Backspace')&&selectedId) {event.preventDefault();remove(selectedId);}
        else if(event.key==='Escape'&&selectedId) {event.preventDefault();event.stopPropagation();setSelectedId(null);}
      }}>
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(16rem,1fr)_minmax(8rem,.45fr)] md:grid-cols-[minmax(0,1fr)_19rem] md:grid-rows-1">
          <div className="flex min-h-0 min-w-0 overflow-hidden rounded-lg border border-gray-300 bg-gray-100 md:mr-3">
            {pdf ? <PdfView doc={null} bytes={pdf.bytes} rounded={false} ariaLabel="Authority PDF editor"
              loading={loading} pageLabels={pdf.pageLabels} loadRecognizedText={pdf.role === role && host.readSourceText ? loadRecognizedText : undefined}
              onRendered={() => flushSync(() => setDrawn(pdf.role))} onUnavailable={() => setDrawn(pdf.role)}
              annotationEditor={{marks:canvasMarks,tool,selectedId,focus,highlightSelection,disabled: disabled || pdf.role !== role,
                onSelect:setSelectedId,onCreate:(fragments,text)=>{
                  const id=crypto.randomUUID();edit(marks => [...marks,{id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:text,rgb:[1,.92,.6],opacity:.45,fragments}]);setSelectedId(id);
                }}} />
              : <div className="grid min-h-48 flex-1 place-items-center bg-gray-100 text-sm text-gray-600" role="status">{!loading && 'PDF unavailable'}</div>}
          </div>
          <aside aria-label="Highlights" aria-busy={shown !== role} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-300">
            <div className="flex items-center justify-between gap-2 px-3 pt-2">
              <h2 className="text-sm font-semibold">Highlights <span className="font-normal text-gray-500">{count ?? ''}</span></h2>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close highlights" disabled={saving||dirty} onClick={close}><X /></Button>
            </div>
        <div className="flex shrink-0 flex-col gap-3 p-3">
          <div className="flex min-w-0 items-center gap-1">
            <Button type="button" variant="outline" size="icon-sm" className="shrink-0 border-gray-400" disabled={saving||choices.length<2} onClick={()=>go(-1)} title={`Previous: ${neighbour(-1).title}`} aria-label={`Previous authority: ${neighbour(-1).title}`}><ChevronLeft /></Button>
            <select aria-label="Authority PDF" value={role} disabled={saving} onChange={event=>setRole(event.target.value)}
              className="h-9 w-full min-w-0 rounded-md border border-gray-400 bg-white px-2 text-sm">
              {choices.map(choice=><option key={choice.bindingRole} value={choice.bindingRole}>{choice.title}</option>)}</select>
            <Button type="button" variant="outline" size="icon-sm" className="shrink-0 border-gray-400" disabled={saving||choices.length<2} onClick={()=>go(1)} title={`Next: ${neighbour(1).title}`} aria-label={`Next authority: ${neighbour(1).title}`}><ChevronRight /></Button>
          </div>
          {/* Three equal cells, so the tools never wrap onto a second row. */}
          <div role="group" aria-label="Highlight tool" className="grid grid-cols-3 gap-1">
            {([{value:'select',label:'Select',short:'Select',Icon:MousePointer2},{value:'highlight',label:'Highlight text',short:'Highlight',Icon:Highlighter},
              {value:'draw',label:'Draw highlight',short:'Draw',Icon:Pencil}] as const).map(({value,label,short,Icon})=><Button key={value} type="button"
                variant={tool===value?'default':'ghost'} aria-pressed={tool===value} aria-label={label} title={label} disabled={!current} onPointerDown={event=>{if(value==='highlight')event.preventDefault();}}
                onClick={()=>{setTool(value);if(value==='highlight')setHighlightSelection(n=>n+1);}} className="h-8 min-w-0 gap-1 px-1.5 text-xs"><Icon /><span className="truncate">{short}</span></Button>)}
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Delete selected highlight" disabled={disabled||!selectedId} onClick={()=>selectedId&&remove(selectedId)}><Trash2 /></Button>
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Undo" disabled={!current?.position} onClick={undo}><Undo2 /></Button>
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Redo" disabled={!current||current.position>=current.history.length-1} onClick={redo}><Redo2 /></Button>
          </div>
        </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <ul className="space-y-1">{marks.map(mark=><li key={mark.id}
              ref={node=>{if(node)cardRefs.current.set(mark.id,node);else cardRefs.current.delete(mark.id);}}
              className={cn('flex rounded-md border',mark.id===selectedId?'border-red-700 bg-red-50':'border-gray-200 bg-white hover:border-gray-400')}>
              <button type="button" aria-pressed={mark.id===selectedId} className="min-w-0 flex-1 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-red-600" onClick={()=>{setSelectedId(mark.id);setFocus(value=>({id:mark.id,request:(value?.request??0)+1}));}}>
                <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-gray-950">{mark.label}<span className="shrink-0 text-xs font-normal text-gray-500">p {mark.fragments.map(f=>f.pageNumber).join(", ")}</span></span>
                {mark.excerpt && <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-600">{mark.excerpt}</span>}
              </button>
              <Button type="button" variant="ghost" size="icon-sm" className="m-1 shrink-0" aria-label={`Delete ${mark.label}`} onClick={()=>remove(mark.id)}><Trash2 /></Button>
            </li>)}</ul>
            {current?.review === 'preparing' ? <p role="status" className="px-1 py-4 text-sm text-gray-500">Preparing highlights</p>
              : !visibleError && !marks.length && current && <p className="px-1 py-4 text-sm text-gray-500">No highlights. Select text or draw on the PDF to add one.</p>}
            </div>
            {/* What belongs to one source sits under its marks, so it comes and goes without moving them. */}
            {shownRecognition && <div className="shrink-0 border-t border-gray-200 px-3 py-2">
              <SourceOcrProgress status={shownRecognition} ocr={ocr} /></div>}
            {(visibleError || saving) && <p role={visibleError?'alert':'status'} className="shrink-0 border-t border-gray-200 px-3 py-2 text-sm text-gray-600">
              {visibleError || 'Saving…'}
              {error && dirty && <Button disabled={saving} onClick={()=>void save()}>Retry</Button>}
            </p>}
          </aside>
        </div>
      </div>
    </Modal>
  </>;
}
