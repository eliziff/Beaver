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
  const view = render(<AuthoritiesHighlights product={product} tabs={new Map()} host={host} busy={false} ocr={ocr} onSaved={vi.fn()} />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Edit in PDF' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('region', { name: 'Authority PDF editor' })).toBeVisible();
    expect(await screen.findByText('Retained OCR')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Highlight text', exact: true })).toBeEnabled();
    const signal = prepare.mock.calls[0][4] as AbortSignal;
    fireEvent.change(screen.getByRole('combobox', { name: 'Authority PDF' }), { target: { value: 'two' } });
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
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
  const view = render(<StrictMode><AuthoritiesHighlights product={product} tabs={new Map()} host={host}
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
