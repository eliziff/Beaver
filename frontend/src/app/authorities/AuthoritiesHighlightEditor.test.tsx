import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import type { PdfCanvasProps } from '@/app/components/shared/views/PdfCanvas';
import { AuthoritiesHighlights } from './AuthoritiesHighlightEditor';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesProduct } from './types';
import { emptyAnnotationSet } from '../../../../shared/pdf-annotations.mjs';
import { createAuthoritiesDraft, validateAuthoritiesDraft } from '../../../../backend/src/lib/authoritiesDomain';

let viewer: PdfCanvasProps;

vi.mock('@/app/components/shared/views/PdfView', async () => {
  const { useState, useEffect } = await import('react');
  return { PdfView: (props: PdfCanvasProps) => {
    viewer = props;
    const [text, setText] = useState('');
    useEffect(() => {
      const abort = new AbortController();
      void props.loadRecognizedText?.(1, abort.signal).then(page => {
        if (!abort.signal.aborted) setText(page?.lines[0]?.words[0]?.text ?? '');
      });
      return () => abort.abort();
    }, [props.loadRecognizedText]);
    return <section aria-label={props.ariaLabel}>{text}</section>;
  } };
});

function fixture() {
  const hash = createHash('sha256').update('%PDF-scan').digest('hex');
  const draft = createAuthoritiesDraft({ kind: 'manual' });
  draft.settings.passageMarking = 'text';
  draft.authorityOrder = ['one', 'two'];
  for (const id of draft.authorityOrder) draft.authorities[id] = { id, key: id, kind: 'case',
    citation: id, name: id, displayName: null, evidenceIds: [], locators: [], sourceIdentity: null,
    excluded: false, source: { kind: 'attached', sources: [{ bindingRole: id, sourceSha256: hash,
      filename: `${id}.pdf`, language: 'en', origin: 'manual', sourceUrl: null }] } };
  for (const id of draft.authorityOrder) draft.bindings[id] = { kind: 'document', documentId: id,
    version: { versionId: `version-${id}`, sha256: hash } };
  expect(validateAuthoritiesDraft(draft)).toEqual([]);
  const product: AuthoritiesProduct = { id: 'draft', kind: 'authorities', revision: 1, title: 'Authorities',
    projectId: null, state: draft, outputs: {}, createdAt: '', updatedAt: '' };
  return {hash, product};
}

it('preserves saved highlights when their PDF no longer matches instead of regenerating them', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const {product} = fixture();
  const saved = {...emptyAnnotationSet('a'.repeat(64)), marks: [{id:'kept',kind:'highlight' as const,
    origin:'manual' as const,label:'Edited passage',excerpt:'Keep this edit',rgb:[1,1,0] as [number,number,number],
    opacity:.3,fragments:[{pageNumber:1,rects:[[.1,.1,.8,.2] as [number,number,number,number]]}]}]};
  product.state.authorities.one.annotations = {one:saved};
  const prepareAnnotations = vi.fn(), actOnDraft = vi.fn();
  const host = {readSource: async () => new Blob(['%PDF-scan']), prepareAnnotations,
    act:actOnDraft} as unknown as AuthoritiesHost;
  const view = render(<AuthoritiesHighlights first={false} onAction={vi.fn()} product={product} tabs={new Map()} host={host}
    busy={false} ocr={{tracked:{},begin:vi.fn(),stop:vi.fn()}} onSaved={vi.fn()} />);
  try {
    fireEvent.click(screen.getByRole('button', {name:'Edit in PDF'}));
    await screen.findByText(/Saved highlights belong to a different PDF/);
    expect(prepareAnnotations).not.toHaveBeenCalled();
    expect(actOnDraft).not.toHaveBeenCalled();
    expect(product.state.authorities.one.annotations.one).toEqual(saved);
    expect(screen.getByRole('button', {name:'Highlight text',exact:true})).toBeDisabled();
  } finally {
    view.unmount();
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
});

it('opens a readable scan before automatic marks, reads paused OCR and cancels abandoned preparation', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const {hash, product} = fixture();
  let finish!: (value: { annotations: ReturnType<typeof emptyAnnotationSet>; pageMarked: string[] }) => void;
  const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
  const prepare = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ annotations: emptyAnnotationSet(hash), pageMarked: [] });
  const text = vi.fn().mockResolvedValue({ pages: [{ pageNumber: 1, width: 400, height: 500,
    lines: [{ id: 'line', rect: [1, 2, 3, 4], words: [{ text: 'Retained OCR', rect: [1, 2, 3, 4] }] }] }] });
  const host = { readSource: vi.fn().mockResolvedValue(new Blob(['%PDF-scan'])),
    prepareAnnotations: prepare, readSourceText: text } as unknown as AuthoritiesHost;
  const ocr = { begin: vi.fn(), stop: vi.fn(), tracked: { one: { role: 'one', name: 'one',
    sourceSha256: hash, state: 'paused' as const, textlessPages: [1, 2], pages: [1], recognized: 1 } } };
  const view = render(<AuthoritiesHighlights first={false} onAction={vi.fn()} product={product} tabs={new Map()} host={host} busy={false} ocr={ocr} onSaved={vi.fn()} />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Edit in PDF' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Preparing highlights')).toBeVisible();
    expect(screen.queryByText(/No highlights\./)).toBeNull();
    expect(screen.getByRole('region', { name: 'Authority PDF editor' })).toBeVisible();
    expect(await screen.findByText('Retained OCR')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Highlight text', exact: true })).toBeEnabled();
    const dialog = screen.getByRole('dialog', { name: 'Highlights' });
    const selector = screen.getByRole('combobox', { name: 'Authority PDF' });
    const tool = screen.getByRole('button', { name: 'Highlight text', exact: true });
    selector.focus();
    const signal = prepare.mock.calls[0][4] as AbortSignal;
    fireEvent.change(screen.getByRole('combobox', { name: 'Authority PDF' }), { target: { value: 'two' } });
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog', { name: 'Highlights' })).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Highlight text', exact: true })).toBe(tool);
    expect(selector).toHaveFocus();
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ annotations: emptyAnnotationSet(hash), pageMarked: [] }); });
    expect(screen.getByRole('combobox', { name: 'Authority PDF' })).toHaveValue('two');
    fireEvent.change(screen.getByRole('combobox', { name: 'Authority PDF' }), { target: { value: 'one' } });
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(3)); // Resume abandoned preparation, not an empty 'loaded' entry.

  } finally {
    view.unmount();
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
});

it('serializes immutable save snapshots and retains batched edits, undo and retries under StrictMode', async () => {
  const scroll = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = vi.fn();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const {hash, product} = fixture();
  let prepared!: (value: {annotations: ReturnType<typeof emptyAnnotationSet>; pageMarked: string[]}) => void;
  const preparation = new Promise<Parameters<typeof prepared>[0]>(resolve => { prepared = resolve; });
  const writes: Array<{revision: number; action: Parameters<AuthoritiesHost['act']>[2];
    resolve: (value: AuthoritiesProduct) => void; reject: (error: Error) => void}> = [];
  const host = {readSource: async () => new Blob(['%PDF-scan']), prepareAnnotations: () => preparation,
    act: (_id: string, revision: number, action: Parameters<AuthoritiesHost['act']>[2]) =>
      new Promise<AuthoritiesProduct>((resolve, reject) => writes.push({revision, action, resolve, reject})),
  } as unknown as AuthoritiesHost;
  const view = render(<StrictMode><AuthoritiesHighlights first={false} onAction={vi.fn()} product={product} tabs={new Map()} host={host}
    busy={false} ocr={{tracked:{},begin:vi.fn(),stop:vi.fn()}} onSaved={vi.fn()} /></StrictMode>);
  const excerpts = (write: typeof writes[number]) => write.action.type === 'set-annotations'
    ? write.action.entries[0].annotations.marks.map(mark => mark.excerpt) : [];
  const fragments = [{pageNumber:1,rects:[[.1,.1,.8,.2] as [number,number,number,number]]}];
  try {
    fireEvent.click(screen.getByRole('button', {name:'Edit in PDF'}));
    await screen.findByRole('region', {name:'Authority PDF editor'});
    await waitFor(() => expect(viewer.annotationEditor?.disabled).toBe(false));
    const create = viewer.annotationEditor!.onCreate;
    act(() => { create(fragments,'First'); create(fragments,'Second'); });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(excerpts(writes[0])).toEqual(['First','Second']);
    act(() => viewer.annotationEditor!.onCreate(fragments,'Third'));
    fireEvent.click(screen.getByRole('button',{name:'Undo',exact:true}));
    fireEvent.click(screen.getByRole('button',{name:'Redo',exact:true}));
    await act(async () => prepared({annotations:emptyAnnotationSet(hash),pageMarked:[]}));
    expect(viewer.annotationEditor!.marks.map(mark=>mark.excerpt)).toEqual(['First','Second','Third']);
    expect(writes).toHaveLength(1);
    await act(async () => writes[0].resolve({...product,revision:2}));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map(write=>write.revision)).toEqual([1,2]);
    expect(excerpts(writes[1])).toEqual(['First','Second','Third']);
    await act(async () => writes[1].reject(new Error('Connection lost')));
    const retry = await screen.findByRole('button',{name:'Retry',exact:true});
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(writes).toHaveLength(3);
    expect(excerpts(writes[2])).toEqual(['First','Second','Third']);
    await act(async () => writes[2].resolve({...product,revision:3}));
    const closing = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(false);
  } finally {
    view.unmount(); HTMLElement.prototype.scrollIntoView = scroll;
    if (original) Object.defineProperty(globalThis,'crypto',original);
  }
});

it('recovers a save whose response was lost instead of repeating its revision', async () => {
  const scroll = HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView = vi.fn();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const {hash, product} = fixture();
  const writes: Array<Parameters<AuthoritiesHost['act']>> = [];
  let stored = product;
  const onSaved = vi.fn();
  const host = {readSource: async () => new Blob(['%PDF-scan']),
    prepareAnnotations: async () => ({annotations: emptyAnnotationSet(hash), pageMarked: []}),
    // The write commits, but its response never arrives.
    act: async (...args: Parameters<AuthoritiesHost['act']>) => {
      writes.push(args);
      const action = args[2];
      if (action.type === 'set-annotations') stored = {...stored, revision: stored.revision + 1, state: {...stored.state,
        authorities: Object.fromEntries(Object.entries(stored.state.authorities).map(([id, authority]) => [id,
          action.entries[0].authorityId === id ? {...authority, annotations: {[action.entries[0].bindingRole]:
            action.entries[0].annotations}} : authority]))}};
      throw new Error('Connection lost');
    },
    drafts: {get: async () => stored},
  } as unknown as AuthoritiesHost;
  const view = render(<AuthoritiesHighlights first={false} onAction={vi.fn()} product={product} tabs={new Map()} host={host}
    busy={false} ocr={{tracked:{},begin:vi.fn(),stop:vi.fn()}} onSaved={onSaved} />);
  viewer = undefined as unknown as PdfCanvasProps; // not the previous test's editor
  try {
    fireEvent.click(screen.getByRole('button', {name:'Edit in PDF'}));
    await waitFor(() => expect(viewer?.annotationEditor?.disabled).toBe(false));
    act(() => viewer.annotationEditor!.onCreate([{pageNumber:1,rects:[[.1,.1,.8,.2]]}],'Kept'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({revision: 2})),
      {timeout: 5_000});
    expect(writes).toHaveLength(1);
    expect(screen.queryByRole('button',{name:'Retry',exact:true})).toBeNull();
    const closing = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(false);
  } finally {
    view.unmount(); HTMLElement.prototype.scrollIntoView = scroll;
    if (original) Object.defineProperty(globalThis,'crypto',original);
  }
});

it('asks for the marking on first entry and prepares saved highlights again once it is saved', async () => {
  const {hash, product} = fixture();
  const manual = {id:'mine',kind:'highlight' as const,origin:'manual' as const,label:'Custom highlight',excerpt:'Mine',
    rgb:[1,.92,.6] as [number,number,number],opacity:.45,fragments:[{pageNumber:1,rects:[[.1,.1,.8,.2] as [number,number,number,number]]}]};
  const stale = {...manual,id:'old',origin:'automatic' as const,label:'para 1'};
  product.state.authorities.one.annotations = {one:{...emptyAnnotationSet(hash),marks:[stale,manual]}};
  const first = {...product, id:'fresh', state:{...product.state, authorities:{...product.state.authorities,
    one:{...product.state.authorities.one, annotations:undefined}}}};
  const fresh = {...stale,id:'new',label:'para 1 · Quote'};
  const prepareAnnotations = vi.fn(async (draft: AuthoritiesProduct) =>
    ({annotations:{...emptyAnnotationSet(hash),marks:draft.state.settings.passageMarking === 'sidelined' ? [fresh] : []}, pageMarked: []}));
  const host = {readSource: async () => new Blob(['%PDF-scan']), prepareAnnotations} as unknown as AuthoritiesHost;
  const onAction = vi.fn();
  const props = {tabs:new Map(), host, busy:false, ocr:{tracked:{},begin:vi.fn(),stop:vi.fn()}, onSaved:vi.fn(), onAction};
  const unseen = render(<AuthoritiesHighlights first product={first} {...props} />);
  expect(screen.getByRole('group', {name:'Passage marking'})).toBeVisible();
  fireEvent.click(screen.getByRole('button', {name:'Continue'}));
  expect(screen.queryByRole('group', {name:'Passage marking'})).toBeNull();
  unseen.unmount();
  // A draft with no source PDF yet is still asked, and has nothing to edit.
  const bare = {...first, id:'bare', state:{...first.state, authorities:{}, authorityOrder:[]}};
  const empty = render(<AuthoritiesHighlights first product={bare} {...props} />);
  expect(screen.getByRole('group', {name:'Passage marking'})).toBeVisible();
  expect(screen.getByRole('button', {name:'Edit in PDF'})).toBeDisabled();
  empty.unmount();
  // A draft whose highlights were already reviewed opens closed, and the options reopen from the step.
  const view = render(<AuthoritiesHighlights first product={product} {...props} />);
  try {
    expect(screen.queryByRole('group', {name:'Passage marking'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name:'Highlighting options'}));
    fireEvent.click(screen.getByRole('radio', {name:/Black line/}));
    expect(onAction).toHaveBeenCalledWith({type:'set-settings', settings:{passageMarking:'sidelined'}});
    expect(prepareAnnotations).not.toHaveBeenCalled();
    view.rerender(<AuthoritiesHighlights first product={{...product, revision:2, state:{...product.state,
      settings:{...product.state.settings, passageMarking:'sidelined'}}}} {...props} />);
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith({type:'set-annotations', entries:[{authorityId:'one',
      bindingRole:'one', annotations:expect.objectContaining({marks:[fresh, manual]})}]}));
  } finally { view.unmount(); }
});
