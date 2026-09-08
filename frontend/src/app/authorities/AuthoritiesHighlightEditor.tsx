import { useEffect, useRef, useState } from 'react';
import { Highlighter, MousePointer2, Pencil, Redo2, Trash2, Undo2 } from 'lucide-react';
import { Modal } from '@/app/components/modals/Modal';
import { Button } from '@/app/components/ui/button';
import { StepSection } from './StepSection';
import { SourceRecognition, type SourceOcrPanel } from './AuthoritySources';
import { PdfView } from '@/app/components/shared/views/PdfView';
import type { AnnotationTool } from '@/app/components/shared/views/pdfAnnotationLayer';
import { cn, errorMessage } from '@/app/lib/utils';
import { decodeAnnotationSet, emptyAnnotationSet,
  type PdfAnnotation, type PdfAnnotationSet } from '../../../../shared/pdf-annotations.mjs';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesAction, AuthoritiesProduct } from './types';

type Entry = Extract<AuthoritiesAction, { type: 'set-annotations' }>['entries'][number];
type Choice = { authorityId: string; bindingRole: string; sourceSha256: string; title: string };
type OpenPdf = {
  bytes: Uint8Array; set: PdfAnnotationSet; history: PdfAnnotation[][]; position: number;
  warning: string;
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

export function AuthoritiesHighlights({ product, tabs, host, busy, onSaved, ocr }: {
  product: AuthoritiesProduct; tabs: ReadonlyMap<string,string>; host: AuthoritiesHost; busy: boolean;
  onSaved(product: AuthoritiesProduct): void;
  ocr?: SourceOcrPanel;
}) {
  const [open, setOpen] = useState(false);
  const choices = choicesFor(product, tabs);
  if (product.state.outputMode === 'table' || !choices.length) return null;
  return <><StepSection title="Highlights" className="mt-3"
    subtitle="Review and adjust passage marks in your source PDFs."
    actions={<Button type="button" variant="outline" className="h-9 border-gray-400"
      disabled={busy || !host.readSource} onClick={() => setOpen(true)}><Highlighter /> Edit in PDF</Button>} />
    {open && <AuthoritiesHighlightEditor product={product} choices={choices} host={host}
      onClose={() => setOpen(false)} onSaved={onSaved} ocr={ocr} />}
  </>;
}

function AuthoritiesHighlightEditor({ product, choices: initialChoices, host, onClose, onSaved, ocr }: {
  product: AuthoritiesProduct; choices: Choice[]; host: AuthoritiesHost;
  onClose(): void; onSaved(product: AuthoritiesProduct): void;
  ocr?: SourceOcrPanel;
}) {
  // A review edits one known revision; a concurrent write must not be silently overwritten.
  const [base] = useState(product);
  const revision = useRef(product.revision);
  const savedMarks = useRef<Record<string, PdfAnnotation[]>>({});
  const [choices] = useState(initialChoices);
  const [role, setRole] = useState(choices[0].bindingRole);
  const [documents, setDocuments] = useState<Record<string,OpenPdf>>({});
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [focus, setFocus] = useState<{ id: string; request: number }>();
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController|null>(null);
  const cardRefs = useRef(new Map<string,HTMLLIElement>());
  const source = choices.find(choice => choice.bindingRole === role)!;
  const current = documents[role], marks = current?.history[current.position] ?? [];
  const dirty = Object.entries(documents).some(([key, document]) =>
    savedMarks.current[key] !== document.history[document.position]);
  const disabled = saving || loading || !current;
  const changeDocument = (update: (document: OpenPdf) => OpenPdf) => setDocuments(values => {
    const document = values[role]; return document ? { ...values, [role]: update(document) } : values;
  });
  const edit = (next: PdfAnnotation[]) => {
    if (disabled || next === marks) return;
    changeDocument(document => {
      const history = [...document.history.slice(0,document.position+1),next];
      // Shared immutable annotations keep undo inexpensive; do not clone entire PDFs or mark sets.
      return { ...document, history, position: history.length-1 };
    });
  };
  const undo = () => { if (!disabled) changeDocument(document => ({...document,position:Math.max(0,document.position-1)})); };
  const redo = () => { if (!disabled) changeDocument(document => ({...document,position:Math.min(document.history.length-1,document.position+1)})); };
  const remove = (id: string) => { edit(marks.filter(mark => mark.id !== id)); if (selectedId===id) setSelectedId(null); };
  const close = () => { if (!saving && !dirty) onClose(); };

  useEffect(() => {
    setSelectedId(null); setFocus(undefined); setError('');
    if (documents[role]) { setLoading(false); return; }
    const abort = new AbortController(); request.current?.abort(); request.current=abort; setLoading(true);
    void (async () => {
      if (!host.readSource) throw new Error('This source cannot be opened.');
      const blob = await host.readSource(base, source.bindingRole);
      const bytes = new Uint8Array(await blob.arrayBuffer()); abort.signal.throwIfAborted();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
        .map(value => value.toString(16).padStart(2,'0')).join('');
      if (hash !== source.sourceSha256) throw new Error('This PDF changed. Relink the source before editing highlights.');
      const saved = base.state.authorities[source.authorityId].annotations?.[role];
      const replaced = !!saved && saved.sourceSha256 !== hash;
      let set = saved && !replaced ? decodeAnnotationSet(saved) : emptyAnnotationSet(hash);
      if (set.sourceSha256 !== hash) throw new Error("The marking source does not match this PDF.");
      let warning = replaced ? 'The PDF changed; highlights start from this version.' : '';
      if ((!saved || replaced) && base.state.settings.passageMarking !== 'none') {
        try {
          if (!host.prepareAnnotations) throw new Error('Automatic marking is unavailable.');
          const prepared = await host.prepareAnnotations(base,source.authorityId,role,blob,abort.signal);
          set=prepared.annotations;
          if(set.sourceSha256!==hash) throw new Error('The marking source does not match this PDF.');
          if (prepared.unresolved.length) warning = `Mark these passages manually: ${prepared.unresolved
            .map(item => item.excerpt ? `${item.label} — ${item.excerpt}` : item.label).join('; ')}.`;
        } catch (cause) {
          abort.signal.throwIfAborted(); set=emptyAnnotationSet(hash);
          warning=`Automatic highlights could not be prepared. You can mark this PDF manually. ${errorMessage(cause)}`;
        }
      }
      abort.signal.throwIfAborted();
      savedMarks.current[role] = set.marks;
      setDocuments(values => ({...values,[role]:{bytes,set,history:[set.marks],position:0,warning}}));
    })().catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
    // A loaded document is retained when switching sources; edits do not reload its PDF bytes.
  }, [role, base, host]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if(selectedId) cardRefs.current.get(selectedId)?.scrollIntoView({block:'nearest'}); },[selectedId]);
  useEffect(() => {
    if(!dirty) return;
    const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',guard); return ()=>window.removeEventListener('beforeunload',guard);
  },[dirty]);
  useEffect(() => { if (dirty) void save(); }, [documents]);

  async function save() {
    if(saving || loading) return;
    const entries:Entry[]=choices.flatMap(choice=>{
      const document=documents[choice.bindingRole];
      const unchanged = document && savedMarks.current[choice.bindingRole] === document.history[document.position];
      return document && !unchanged ? [{authorityId:choice.authorityId,bindingRole:choice.bindingRole,
        annotations:{...document.set,marks:document.history[document.position]}}] : [];
    });
    if(!entries.length) return;
    setSaving(true);setError('');
    try {
      const next=await host.act(base.id,revision.current,{type:'set-annotations',entries});
      revision.current = next.revision;
      for (const entry of entries) savedMarks.current[entry.bindingRole] = entry.annotations.marks;
      onSaved(next);
    } catch(cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  }
  return <>
    <Modal open onClose={close} breadcrumbs={['Highlights']} size="2xl"
      className="h-[calc(100dvh-2rem)] max-w-[96rem]"
      primaryAction={error && dirty ? {label:'Retry',disabled:saving,onClick:()=>void save()} : undefined}
      footerStatus={<span role={error?'alert':'status'} className={cn('text-sm',error?'text-red-800':'text-gray-500')}>
        {error || (loading?'Preparing PDF…':saving?'Saving…':'')}</span>}>
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={event=>{
        const input=event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]');
        if(input || disabled) return;
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z') {
          event.preventDefault();event.stopPropagation();if(event.shiftKey)redo();else undo();
        } else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y') {event.preventDefault();redo();}
        else if((event.key==='Delete'||event.key==='Backspace')&&selectedId) {event.preventDefault();remove(selectedId);}
        else if(event.key==='Escape'&&selectedId) {event.preventDefault();event.stopPropagation();setSelectedId(null);}
      }}>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-gray-300 bg-gray-50 p-2">
          <label className="min-w-48 flex-1"><span className="sr-only">Authority PDF</span>
            <select aria-label="Authority PDF" value={role} disabled={saving||loading}
              onChange={event=>setRole(event.target.value)} className="h-9 w-full min-w-0 rounded-md border border-gray-400 bg-white px-2 text-sm">
              {choices.map(choice=><option key={choice.bindingRole} value={choice.bindingRole}>{choice.title}</option>)}
            </select></label>
          <div role="group" aria-label="Highlight tool" className="flex items-center gap-1 rounded-md border border-gray-300 bg-white p-1">
            {([{value:'select',label:'Select',Icon:MousePointer2},{value:'highlight',label:'Highlight text',Icon:Highlighter},
              {value:'draw',label:'Draw highlight',Icon:Pencil}] as const).map(({value,label,Icon})=><Button key={value}
                type="button" variant={tool===value?'default':'ghost'} aria-pressed={tool===value} disabled={disabled}
                onClick={()=>setTool(value)} className="h-8"><Icon />{label}</Button>)}
          </div>
          <div className="flex items-center gap-1 border-gray-300 md:border-s md:ps-3">
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Delete selected highlight"
              disabled={disabled || !selectedId} onClick={() => selectedId && remove(selectedId)}><Trash2 /></Button>
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Undo" disabled={disabled||!current?.position} onClick={undo}><Undo2 /></Button>
            <Button type="button" variant="outline" size="icon-sm" className="border-gray-400" aria-label="Redo" disabled={disabled||current.position>=current.history.length-1} onClick={redo}><Redo2 /></Button>
          </div>
        </div>
        {host.sourceOcr && ocr && <SourceRecognition key={role} ocr={ocr} disabled={loading}
          file={{ role, name: source.title, sourceSha256: source.sourceSha256, textlessPages: [] }} />}
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(16rem,1fr)_minmax(8rem,.45fr)] md:grid-cols-[minmax(0,1fr)_19rem] md:grid-rows-1">
          <div className="mt-3 flex min-h-0 min-w-0 overflow-hidden rounded-lg border border-gray-300 bg-gray-100 md:mr-3">
            {current ? <PdfView key={role} doc={null} bytes={current.bytes} rounded={false} ariaLabel="Authority PDF editor"
              annotationEditor={{marks,tool,selectedId,focus,disabled,
                onSelect:setSelectedId,onCreate:(fragments,text)=>{
                  const id=crypto.randomUUID();edit([...marks,{id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:text,
                    rgb:[1,.92,.6],opacity:.45,fragments}]);setSelectedId(id);
                }}} />
              : <div className="grid min-h-48 flex-1 place-items-center bg-gray-100 text-sm text-gray-600" role="status">{loading?'Preparing PDF…':'PDF unavailable'}</div>}
          </div>
          <aside aria-label="Highlights" className="mt-3 flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-300">
            <h3 className="flex items-baseline justify-between gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-950">
              Highlights<span className="text-xs font-normal text-gray-600">{marks.length}</span></h3>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {current?.warning && <p role="alert" className="mb-2 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-2 text-sm text-red-800">{current.warning}</p>}
            <ul className="space-y-1">{marks.map(mark=><li key={mark.id}
              ref={node=>{if(node)cardRefs.current.set(mark.id,node);else cardRefs.current.delete(mark.id);}}
              className={cn('flex rounded-md border',mark.id===selectedId?'border-red-700 bg-red-50':'border-gray-200 bg-white hover:border-gray-400')}>
              <button type="button" aria-pressed={mark.id===selectedId} className="min-w-0 flex-1 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                onClick={()=>{setSelectedId(mark.id);setFocus(value=>({id:mark.id,request:(value?.request??0)+1}));}}>
                <span className="flex items-baseline justify-between gap-2 text-sm font-medium text-gray-950">{mark.label}<span className="shrink-0 text-xs font-normal text-gray-500">p {mark.fragments.map(f=>f.pageNumber).join(", ")}</span></span>
                {mark.excerpt && <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-gray-600">{mark.excerpt}</span>}
              </button>
              <Button type="button" variant="ghost" size="icon-sm" className="m-1 shrink-0" disabled={disabled}
                aria-label={`Delete ${mark.label}`} onClick={()=>remove(mark.id)}><Trash2 /></Button>
            </li>)}</ul>
            {!marks.length && current && <p className="px-1 py-4 text-sm text-gray-500">No highlights. Select text or draw on the PDF to add one.</p>}
            </div>
          </aside>
        </div>
      </div>
    </Modal>
  </>;
}
