import { apiResponse } from '@/app/lib/api/client';
import type { PdfRecognizedText } from '@/app/lib/api/documents';
import type { AuthoritiesProduct } from './types';
import { oneAtATime } from '../../../../shared/one-at-a-time.mjs';

const text = new Map<string, PdfRecognizedText['pages']>();
// The runtime recognizes one pass at a time; a pass waits here, not in an upload slot.
const onePass = oneAtATime();
const waiting = new Map<string, number>();
/** Whether a recognition pass for this PDF is waiting behind another PDF's pass. */
export const recognitionWaiting = (hash: string) => (waiting.get(hash) ?? 0) > 0;

export async function prepareSourceText(product: AuthoritiesProduct, role: string, file: File,
  priority: number[] | undefined, scanned: number[] | undefined, signal: AbortSignal,
  completed: (count: number) => void) {
  const binding = product.state.bindings[role];
  if (binding.kind !== 'local-file') return;
  const hash = binding.lastSeen.sha256;
  if (!hash) return;
  for (const pages of priority?.length ? [priority, undefined] : [undefined]) {
    signal.throwIfAborted();
    const form = new FormData();
    form.append('draft', JSON.stringify(product.state)); form.append('role', role);
    form.append('file', file, file.name); form.append('prepareOnly', 'true');
    if (pages) form.append('pages', JSON.stringify(pages));
    waiting.set(hash, (waiting.get(hash) ?? 0) + 1);
    let queued = true;
    const settle = () => { if (queued) { queued = false; waiting.set(hash, waiting.get(hash)! - 1); } };
    const result = await onePass(async () => { settle();
      return await (await apiResponse('/authorities-runtime/source-text',
        {method:'POST',body:form,signal})).json() as PdfRecognizedText; }, signal).finally(settle);
    const retained = new Map((text.get(hash) ?? []).map(page => [page.pageNumber, page]));
    for (const page of result.pages) retained.set(page.pageNumber, page);
    text.set(hash, [...retained.values()]); completed(scanned ? scanned.filter(page=>retained.has(page)).length : retained.size);
  }
}

export async function readSourceText(hash: string, pages?: number[]): Promise<PdfRecognizedText> {
  return {pages:(text.get(hash) ?? []).filter(page => !pages || pages.includes(page.pageNumber))};
}
