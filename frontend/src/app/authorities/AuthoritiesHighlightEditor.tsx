import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Highlighter, MousePointer2, Pencil, Redo2, Trash2, Undo2, X } from 'lucide-react';
import { Modal } from '@/app/components/modals/Modal';
import { Button } from '@/app/components/ui/button';
import { StepSection } from './StepSection';
import { PdfView } from '@/app/components/shared/views/PdfView';
import type { AnnotationTool } from '@/app/components/shared/views/pdfAnnotationLayer';
import { cn, errorMessage } from '@/app/lib/utils';
import { decodeAnnotationSet, emptyAnnotationSet,
  type PdfAnnotation, type PdfAnnotationSet } from '../../../../shared/pdf-annotations.mjs';
import type { AuthoritiesHost } from './host';
import type { SourceOcrPanel, SourceOcrStatus } from './sourceOcr';
import type { AuthoritiesAction, AuthoritiesProduct } from './types';

/** Text recognition for one scanned source, watched where the source is being used. */
export function SourceOcrProgress({ status, ocr }: { status: SourceOcrStatus; ocr: SourceOcrPanel }) {
  const action = (label: string, act: () => void) => <button type="button"
    className="min-h-6 rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600"
    onClick={act}>{label}</button>;
  const total = status.textlessPages.length;
  const pending = status.state === 'running' || status.state === 'paused';
  return <div className="col-span-full grid gap-1 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn('min-w-0 truncate', status.state === 'done' ? 'text-green-800'
        : status.state === 'failed' ? 'text-red-800' : 'text-gray-600')}>
        {status.state === 'done' ? 'Text recognition complete'
          : status.state === 'failed' ? status.error || 'Text recognition failed'
          : status.state === 'paused' ? `Text recognition paused — ${status.recognized} of ${total} pages read`
          : status.state === 'cancelled' ? 'Text recognition cancelled'
          : `Recognizing ${status.pages?.length ? 'the cited pages' : 'every scanned page'} — ${status
            .recognized} of ${total} pages read`}</span>
      <span className="ms-auto flex shrink-0 gap-1">
        {status.state === 'running' && action('Pause', () => ocr.stop([status.role], true))}
        {['paused', 'failed', 'cancelled'].includes(status.state) && action('Resume', () => void ocr.begin([status], status.pages?.length ? status.pages : undefined))}
        {pending && action('Cancel', () => void ocr.stop([status.role], false))}
      </span>
    </div>
    {pending && <progress value={status.recognized} max={total} aria-label={`Pages recognized in ${status.name}`}
      className="h-1.5 w-full appearance-none overflow-hidden rounded-full bg-gray-200 [&::-moz-progress-bar]:bg-red-700 [&::-webkit-progress-bar]:bg-gray-200 [&::-webkit-progress-value]:bg-red-700" />}
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

export function AuthoritiesHighlights({ product, tabs, host, busy, ocr, onSaved }: {
  product: AuthoritiesProduct; tabs: ReadonlyMap<string,string>; host: AuthoritiesHost; busy: boolean;
  ocr: SourceOcrPanel; onSaved(product: AuthoritiesProduct): void;
}) {
  const [open, setOpen] = useState(false);
  const choices = choicesFor(product, tabs);
  if (product.state.outputMode === 'table' || !choices.length) return null;
  return <><StepSection title="Highlights" className="mt-3"
    subtitle="Review and adjust passage marks in your source PDFs."
    actions={<Button type="button" variant="outline" className="h-9 border-gray-400"
      disabled={busy || !host.readSource} onClick={() => setOpen(true)}><Highlighter /> Edit in PDF</Button>} />
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
  const [pdf, setPdf] = useState<{ role: string; bytes: Uint8Array } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [focus, setFocus] = useState<{ id: string; request: number }>();
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [textError, setTextError] = useState('');
  const cardRefs = useRef(new Map<string,HTMLLIElement>());
  const source = choices.find(choice => choice.bindingRole === role)!;
  const recognition = ocr.tracked[role];
  const neighbour = (step: number) => choices[(choices.indexOf(source)+step+choices.length)%choices.length];
  const go = (step: number) => setRole(neighbour(step).bindingRole);
  const current = documents[role], marks = current?.history[current.position] ?? [];
  const dirty = Object.values(documents).some(document => document.saved !== document.history[document.position]);
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
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      if (!host.readSource) throw new Error('This source cannot be opened.');
      const blob = await host.readSource(base, source.bindingRole, abort.signal);
      const bytes = new Uint8Array(await blob.arrayBuffer()); abort.signal.throwIfAborted();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))]
        .map(value => value.toString(16).padStart(2,'0')).join('');
      abort.signal.throwIfAborted();
      if (hash !== source.sourceSha256) throw new Error('This PDF changed. Relink the source before editing highlights.');
      setPdf({role, bytes});
      const loaded = readDocument(role);
      setLoading(false);
      if (loaded && loaded.review !== 'preparing') return;
      const saved = base.state.authorities[source.authorityId].annotations?.[role];
      const replaced = !!saved && saved.sourceSha256 !== hash;
      let set = saved && !replaced ? decodeAnnotationSet(saved) : emptyAnnotationSet(hash);
      if (set.sourceSha256 !== hash) throw new Error("The marking source does not match this PDF.");
      let warning = replaced ? 'The PDF changed; highlights start from this version.' : '';
      const automatic = (!saved || replaced) && base.state.settings.passageMarking !== 'none';
      const initial: OpenPdf = {set,history:[set.marks],position:0,warning,
        saved:set.marks,review:automatic?'preparing':'ready'};
      if (!loaded) setDocuments(values => ({...values,[role]:values[role] ?? initial}));
      if (automatic) {
        try {
          if (!host.prepareAnnotations) throw new Error('Automatic marking is unavailable.');
          const prepared = await host.prepareAnnotations(base,source.authorityId,role,blob,abort.signal);
          set=prepared.annotations;
          if(set.sourceSha256!==hash) throw new Error('The marking source does not match this PDF.');
          if (prepared.pageMarked.length) warning = `The cited page carries the mark for ${prepared
            .pageMarked.join(', ')} because that paragraph's text was not found.`;
        } catch (cause) {
          abort.signal.throwIfAborted(); set=emptyAnnotationSet(hash);
          warning=`Automatic highlights could not be prepared. You can mark this PDF manually. ${errorMessage(cause)}`;
        }
      }
      abort.signal.throwIfAborted();
      // Decide against the current state, not a ref checked before React applies this update.
      setDocuments(values => values[role]?.review !== 'preparing' ? values : {...values,
        [role]:{set,history:[set.marks],position:0,warning,saved:set.marks,review:'ready'}});
    })().catch(cause => { if (!abort.signal.aborted) { setPdf(null); setError(errorMessage(cause)); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [role, source, base, host]);
  const loadRecognizedText = useCallback(async (page: number, signal: AbortSignal) => {
    try {
      const text = await host.readSourceText?.(base, role, signal, [page]);
      return text?.pages.find(item => item.pageNumber === page);
    } catch (cause) {
      if (!signal.aborted) setTextError(`Text selection could not be prepared. ${errorMessage(cause)}`);
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
              loading={loading} loadRecognizedText={pdf.role === role && host.readSourceText ? loadRecognizedText : undefined}
              annotationEditor={{marks: pdf.role === role ? marks : [],tool,selectedId,focus,disabled: disabled || pdf.role !== role,
                onSelect:setSelectedId,onCreate:(fragments,text)=>{
                  const id=crypto.randomUUID();edit(marks => [...marks,{id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:text,rgb:[1,.92,.6],opacity:.45,fragments}]);setSelectedId(id);
                }}} />
              : <div className="grid min-h-48 flex-1 place-items-center bg-gray-100 text-sm text-gray-600" role="status">{loading?'Preparing PDF…':'PDF unavailable'}</div>}
          </div>
          <aside aria-label="Highlights" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-300">
            <div className="flex items-center justify-between gap-2 px-3 pt-2">
              <h2 className="text-sm font-semibold">Highlights <span className="font-normal text-gray-500">{marks.length}</span></h2>
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
          <div role="group" aria-label="Highlight tool" className="flex flex-wrap items-center gap-1">
            {([{value:'select',label:'Select',Icon:MousePointer2},{value:'highlight',label:'Highlight text',Icon:Highlighter},
              {value:'draw',label:'Draw highlight',Icon:Pencil}] as const).map(({value,label,Icon})=><Button key={value} type="button"
                variant={tool===value?'default':'ghost'} aria-pressed={tool===value} disabled={disabled} onClick={()=>setTool(value)} className="h-8"><Icon />{label}</Button>)}
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Delete selected highlight" disabled={disabled||!selectedId} onClick={()=>selectedId&&remove(selectedId)}><Trash2 /></Button>
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Undo" disabled={disabled||!current?.position} onClick={undo}><Undo2 /></Button>
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Redo" disabled={disabled||current.position>=current.history.length-1} onClick={redo}><Redo2 /></Button>
          </div>
        </div>
        {recognition && <div className="mt-2 shrink-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2">
          <SourceOcrProgress status={recognition} ocr={ocr} /></div>}
            {(error || textError || loading || saving) && <p role={error || textError?'alert':'status'} className="px-3 pb-2 text-sm text-gray-600">
              {error || textError || (loading?'Preparing PDF…':'Saving…')}
              {error && dirty && <Button disabled={saving} onClick={()=>void save()}>Retry</Button>}
            </p>}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {current?.warning && <p role="alert" className="mb-2 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-2 text-sm text-red-800">{current.warning}</p>}
            <ul className="space-y-1">{marks.map(mark=><li key={mark.id}
              ref={node=>{if(node)cardRefs.current.set(mark.id,node);else cardRefs.current.delete(mark.id);}}
              className={cn('flex rounded-md border',mark.id===selectedId?'border-red-700 bg-red-50':'border-gray-200 bg-white hover:border-gray-400')}>
              <button type="button" aria-pressed={mark.id===selectedId} className="min-w-0 flex-1 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-red-600" onClick={()=>{setSelectedId(mark.id);setFocus(value=>({id:mark.id,request:(value?.request??0)+1}));}}>
                <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-gray-950">{mark.label}<span className="shrink-0 text-xs font-normal text-gray-500">p {mark.fragments.map(f=>f.pageNumber).join(", ")}</span></span>
                {mark.excerpt && <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-600">{mark.excerpt}</span>}
              </button>
              <Button type="button" variant="ghost" size="icon-sm" className="m-1 shrink-0" disabled={disabled} aria-label={`Delete ${mark.label}`} onClick={()=>remove(mark.id)}><Trash2 /></Button>
            </li>)}</ul>
            {!marks.length && current && <p className="px-1 py-4 text-sm text-gray-500">No highlights. Select text or draw on the PDF to add one.</p>}
            </div>
          </aside>
        </div>
      </div>
    </Modal>
  </>;
}
