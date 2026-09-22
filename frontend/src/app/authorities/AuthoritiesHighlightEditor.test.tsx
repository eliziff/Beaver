import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import type { PdfCanvasProps } from '@/app/components/shared/views/PdfCanvas';
import { AuthoritiesHighlights } from './AuthoritiesHighlightEditor';
import type { AuthoritiesHost } from './host';
import type { AuthoritiesProduct } from './types';
import { emptyAnnotationSet } from '../../../../shared/pdf-annotations.mjs';
import { createAuthoritiesDraft, validateAuthoritiesDraft } from '../../../../backend/src/lib/authoritiesDomain';

vi.mock('@/app/components/shared/views/PdfView', () => ({ PdfView: (props: PdfCanvasProps) =>
  <section aria-label={props.ariaLabel}>{props.recognizedText?.pages[0]?.lines[0]?.words[0]?.text}</section> }));

it('opens a readable scan before automatic marks, reads paused OCR and cancels abandoned preparation', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
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
    const signal = prepare.mock.calls[0][4] as AbortSignal;
    fireEvent.change(screen.getByRole('combobox', { name: 'Authority PDF' }), { target: { value: 'two' } });
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ annotations: emptyAnnotationSet(hash), pageMarked: [] }); });
    expect(screen.getByRole('combobox', { name: 'Authority PDF' })).toHaveValue('two');
  } finally {
    view.unmount();
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
});
