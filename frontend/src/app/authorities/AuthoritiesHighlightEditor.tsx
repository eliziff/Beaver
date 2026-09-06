import { useEffect, useRef, useState } from 'react';
import { Highlighter, MousePointer2, Pencil, Redo2, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { Modal } from '@/app/components/modals/Modal';
import { Button } from '@/app/components/ui/button';
import { PdfView } from '@/app/components/shared/views/PdfView';
import type { AnnotationTool } from '@/app/components/shared/views/pdfAnnotationLayer';
import { cn, errorMessage } from '@/app/lib/utils';
import { decodeAnnotationSet, emptyAnnotationSet, eraseAnnotations,
  type PdfAnnotation, type PdfAnnotationSet } from '../../../../shared/pdf-annotations.mjs';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesAction, AuthoritiesProduct } from './types';
import { annotationExcerpts } from './annotationExcerpts';

type Entry = Extract<AuthoritiesAction, { type: 'set-annotations' }>['entries'][number];
type Choice = { authorityId: string; bindingRole: string; sourceSha256: string; title: string };
type OpenPdf = {
  bytes: Uint8Array; set: PdfAnnotationSet; history: PdfAnnotation[][]; position: number;
  unresolved: Array<{ label: string; excerpt: string }>; warning: string; stale: boolean;
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

export function AuthoritiesHighlights({ product, tabs, host, busy, onSaved }: {
  product: AuthoritiesProduct; tabs: ReadonlyMap<string,string>; host: AuthoritiesHost; busy: boolean;
  onSaved(product: AuthoritiesProduct): void;
}) {
  const [open, setOpen] = useState(false);
  const choices = choicesFor(product, tabs);
  if (product.state.outputMode === 'table' || !choices.length) return null;
  return <section className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-gray-300 bg-white px-4 py-3">
    <h2 className="font-semibold text-gray-950">Highlights</h2>
    <Button type="button" variant="outline" disabled={busy || !host.readSource}
      onClick={() => setOpen(true)}><Highlighter /> Edit in PDF</Button>
    {open && <AuthoritiesHighlightEditor product={product} choices={choices} host={host}
      onClose={() => setOpen(false)} onSaved={onSaved} />}
  </section>;
}

function AuthoritiesHighlightEditor({ product, choices: initialChoices, host, onClose, onSaved }: {
  product: AuthoritiesProduct; choices: Choice[]; host: AuthoritiesHost;
  onClose(): void; onSaved(product: AuthoritiesProduct): void;
}) {
  // A review edits one known revision; a concurrent write must not be silently overwritten.
  const [base] = useState(product);
  const [choices] = useState(initialChoices);
  const [role, setRole] = useState(choices[0].bindingRole);
  const [documents, setDocuments] = useState<Record<string,OpenPdf>>({});
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [focus, setFocus] = useState<{ id: string; request: number }>();
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<'discard'|'regenerate'|null>(null);
  const request = useRef<AbortController|null>(null);
  const cardRefs = useRef(new Map<string,HTMLLIElement>());
  const source = choices.find(choice => choice.bindingRole === role)!;
  const current = documents[role], marks = current?.history[current.position] ?? [];
  const dirty = Object.values(documents).some(document => document.position !== 0);
  const disabled = saving || loading || !current || current.stale;
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
  const close = () => { if (!saving) { if (dirty) setConfirmation('discard'); else onClose(); } };

  useEffect(() => {
    setSelectedId(null); setFocus(undefined); setError('');
    if (documents[role]) return;
    const abort = new AbortController(); request.current?.abort(); request.current=abort; setLoading(true);
    void (async () => {
      if (!host.readSource) throw new Error('This source cannot be opened.');
      const blob = await host.readSource(base, source.bindingRole);
      const bytes = new Uint8Array(await blob.arrayBuffer()); abort.signal.throwIfAborted();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
        .map(value => value.toString(16).padStart(2,'0')).join('');
      if (hash !== source.sourceSha256) throw new Error('This PDF changed. Relink the source before editing highlights.');
      const saved = base.state.authorities[source.authorityId].annotations?.[role];
      const stale = !!saved && saved.sourceSha256 !== hash;
      let set = saved && !stale ? decodeAnnotationSet(saved) : emptyAnnotationSet(hash);
      let unresolved: OpenPdf['unresolved'] = [], warning = '';
      if (!saved && base.state.settings.passageMarking !== 'none') {
        try {
          if (!host.prepareAnnotations) throw new Error('Automatic marking is unavailable.');
          const prepared = await host.prepareAnnotations(base,source.authorityId,role,blob,abort.signal);
          set=prepared.annotations; unresolved=prepared.unresolved;
          if(set.sourceSha256!==hash) throw new Error('The marking source does not match this PDF.');
        } catch (cause) {
          abort.signal.throwIfAborted(); set=emptyAnnotationSet(hash);
          warning=`Automatic highlights could not be prepared. You can mark this PDF manually. ${errorMessage(cause)}`;
        }
      }
      try { if(!saved) set={...set,marks:await annotationExcerpts(bytes,set.marks,abort.signal)}; }
      catch { abort.signal.throwIfAborted(); }
      abort.signal.throwIfAborted();
      setDocuments(values => ({...values,[role]:{bytes,set,history:[set.marks],position:0,unresolved,warning,stale}}));
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

  async function regenerate() {
    setConfirmation(null); if(!current || !host.prepareAnnotations) return;
    const abort = new AbortController(); request.current?.abort(); request.current=abort; setLoading(true); setError('');
    try {
      const result=await host.prepareAnnotations(base,source.authorityId,role,
        new Blob([current.bytes.slice().buffer],{type:'application/pdf'}),abort.signal);
      if(result.annotations.sourceSha256!==source.sourceSha256) throw new Error('The source changed. Reopen this PDF.');
      const next=[...result.annotations.marks,...(current.stale ? [] : marks.filter(mark=>mark.origin==='manual'))];
      changeDocument(document=>({...document,set:result.annotations,history:document.stale ? [[],next]
        : [...document.history.slice(0,document.position+1),next],position:document.stale ? 1 : document.position+1,
        unresolved:result.unresolved,stale:false,warning:''}));
      setSelectedId(null);
    } catch(cause) { if(!abort.signal.aborted) setError(errorMessage(cause)); }
    finally { if(!abort.signal.aborted) setLoading(false); }
  }
  async function save() {
    if(saving || loading) return;
    const entries:Entry[]=choices.flatMap(choice=>{
      const document=documents[choice.bindingRole];
      const unchanged = document?.position === 0 && base.state.authorities[choice.authorityId].annotations?.[choice.bindingRole];
      return document && !document.stale && !unchanged ? [{authorityId:choice.authorityId,bindingRole:choice.bindingRole,
        annotations:{...document.set,marks:document.history[document.position]}}] : [];
    });
    if(!entries.length) { onClose(); return; }
    setSaving(true);setError('');
    try {
      const next=await host.act(base.id,base.revision,{type:'set-annotations',entries});
      onSaved(next);onClose();
    } catch(cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  }
  return <>
    <Modal open onClose={close} breadcrumbs={['Highlights']} size="2xl"
      className="h-[calc(100dvh-2rem)] max-w-[96rem]"
      primaryAction={{label:saving?'Saving…':'Save and close',disabled:saving||loading,onClick:()=>void save()}}
      cancelAction={{label:'Cancel',disabled:saving,onClick:close}}
      footerStatus={<span role={error?'alert':'status'} className={cn('text-sm',error?'text-red-800':'text-gray-500')}>
        {error || (loading?'Preparing PDF…':dirty?'Unsaved changes':'')}</span>}>
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={event=>{
        const input=event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]');
        if(input || disabled) return;
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z') {
          event.preventDefault();event.stopPropagation();if(event.shiftKey)redo();else undo();
        } else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y') {event.preventDefault();redo();}
        else if((event.key==='Delete'||event.key==='Backspace')&&selectedId) {event.preventDefault();remove(selectedId);}
        else if(event.key==='Escape'&&selectedId) {event.preventDefault();event.stopPropagation();setSelectedId(null);}
      }}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 pb-3">
          <label className="min-w-48 flex-1"><span className="sr-only">Authority PDF</span>
            <select aria-label="Authority PDF" value={role} disabled={saving||loading}
              onChange={event=>setRole(event.target.value)} className="h-9 w-full min-w-0 rounded border border-gray-300 bg-white px-2 text-sm">
              {choices.map(choice=><option key={choice.bindingRole} value={choice.bindingRole}>{choice.title}</option>)}
            </select></label>
          {([{value:'select',label:'Select',Icon:MousePointer2},{value:'highlight',label:'Highlight text',Icon:Highlighter},
            {value:'draw',label:'Draw highlight',Icon:Pencil}] as const).map(({value,label,Icon})=><Button key={value}
              type="button" variant={tool===value?'default':'outline'} aria-pressed={tool===value} disabled={disabled}
              onClick={()=>setTool(value)} className="h-9"><Icon />{label}</Button>)}
          <label><span className="sr-only">Remove highlighting</span>
            <select aria-label="Remove highlighting" value={tool.startsWith('erase')?tool:''} disabled={disabled}
              onChange={event=>setTool(event.target.value as AnnotationTool)} className="h-9 rounded border border-gray-300 bg-white px-2 text-sm">
              <option value="" disabled>Erase…</option><option value="erase-text">Erase selected text</option><option value="erase-area">Erase area</option>
            </select></label>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Undo" disabled={disabled||!current?.position} onClick={undo}><Undo2 /></Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Redo" disabled={disabled||current.position>=current.history.length-1} onClick={redo}><Redo2 /></Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(16rem,1fr)_minmax(8rem,.45fr)] md:grid-cols-[minmax(0,1fr)_19rem] md:grid-rows-1">
          <div className="flex min-h-0 min-w-0 pt-3 md:pr-3">
            {current ? <PdfView key={role} doc={null} bytes={current.bytes} rounded={false} ariaLabel="Authority PDF editor"
              annotationEditor={{marks:current.stale?[]:marks,tool,selectedId,focus,disabled,
                onSelect:setSelectedId,onCreate:(fragments,text)=>{
                  const id=crypto.randomUUID();edit([...marks,{id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:text,
                    rgb:[1,.92,.6],opacity:.45,fragments}]);setSelectedId(id);
                },onErase:fragments=>{edit(eraseAnnotations(marks,fragments));setSelectedId(null);}}} />
              : <div className="grid min-h-48 flex-1 place-items-center bg-gray-100 text-sm text-gray-600" role="status">{loading?'Preparing PDF…':'PDF unavailable'}</div>}
          </div>
          <aside aria-label="Highlights" className="min-h-0 overflow-y-auto border-t border-gray-200 py-3 md:border-l md:border-t-0 md:pl-3">
            {current?.stale && <p role="alert" className="mb-3 text-sm text-red-800">This PDF was replaced. Reset its highlights before editing; the old coordinates cannot be reused safely.</p>}
            {current?.warning && <p role="alert" className="mb-3 text-sm text-amber-900">{current.warning}</p>}
            <ul className="space-y-2">{!current?.stale && marks.map(mark=><li key={mark.id}
              ref={node=>{if(node)cardRefs.current.set(mark.id,node);else cardRefs.current.delete(mark.id);}}
              className={cn('flex min-h-24 rounded border',mark.id===selectedId?'border-red-700 bg-red-50':'border-gray-200 bg-white')}>
              <button type="button" aria-pressed={mark.id===selectedId} className="min-w-0 flex-1 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                onClick={()=>{setSelectedId(mark.id);setFocus(value=>({id:mark.id,request:(value?.request??0)+1}));}}>
                <span className="block text-sm font-medium">{mark.label}</span>
                {mark.excerpt && <span className="mt-1 line-clamp-2 text-sm text-gray-700">{mark.excerpt}</span>}
                <span className="mt-1 block text-xs text-gray-500">PDF page {mark.fragments.map(f=>f.pageNumber).join(', ')}</span>
              </button>
              <Button type="button" variant="ghost" size="icon-sm" className="m-1 shrink-0" disabled={disabled}
                aria-label={`Delete ${mark.label}`} onClick={()=>remove(mark.id)}><Trash2 /></Button>
            </li>)}</ul>
            {!marks.length && current && !current.stale && <p className="py-4 text-sm text-gray-500">No highlights. Select text or draw on the PDF to add one.</p>}
            {!!current?.unresolved.length && <details className="mt-4 border-t border-gray-200 pt-3">
              <summary className="cursor-pointer text-sm text-amber-900">Not located automatically ({current.unresolved.length})</summary>
              {current.unresolved.map((item,index)=><p key={index} className="mt-2 text-sm"><strong>{item.label}</strong>{item.excerpt&&` — ${item.excerpt}`}</p>)}
            </details>}
            {current && <Button type="button" variant="ghost" className="mt-4 h-auto whitespace-normal text-xs" disabled={saving||loading||!host.prepareAnnotations}
              onClick={()=>setConfirmation('regenerate')}><RotateCcw />{current.stale?'Reset for this PDF':'Regenerate automatic highlights'}</Button>}
          </aside>
        </div>
      </div>
    </Modal>
    <Modal open={!!confirmation} onClose={()=>setConfirmation(null)} breadcrumbs={[confirmation==='discard'?'Discard changes?':'Regenerate highlights?']}
      className="h-auto max-h-[calc(100dvh-2rem)]" cancelAction={{label:'Cancel',onClick:()=>setConfirmation(null)}}
      primaryAction={{label:confirmation==='discard'?'Discard':'Regenerate',onClick:()=>{
        if(confirmation==='discard')onClose();else void regenerate();}}}>
      <p className="pb-4 text-sm text-gray-700">{confirmation==='discard'?'Your unsaved highlight edits will be discarded.':current?.stale
        ?'The old highlight positions belong to a different PDF. Start again on this version.'
        :'This replaces the automatic highlights, including edits to them. Custom highlights are kept.'}</p>
    </Modal>
  </>;
}
