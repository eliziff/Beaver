import { followedRequest } from '@/app/lib/api/client';
import type { PdfRecognizedText } from '@/app/lib/api/documents';
import type { AuthoritiesProduct } from './types';
import { oneAtATime } from '../../../../shared/one-at-a-time.mjs';

const text = new Map<string, PdfRecognizedText['pages']>();
// The runtime recognizes one pass at a time; a pass waits here, not in an upload slot.
const onePass = oneAtATime();
const waiting = new Map<string, number>();
/** Whether a recognition pass for this PDF is waiting behind another PDF's pass. */
export const recognitionWaiting = (hash: string) => (waiting.get(hash) ?? 0) > 0;

/** The cited pages first, then the rest of the scanned pages (or, when they are unknown, the
 * whole source) in one pass that reports each page as the engine recognizes it. */
function passes(priority: number[] | undefined, scanned: number[] | undefined) {
  const rest = scanned?.filter(page => !priority?.includes(page));
  return [...priority?.length ? [priority] : [], ...!rest ? [undefined] : rest.length ? [rest] : []];
}

export async function prepareSourceText(product: AuthoritiesProduct, role: string, file: File,
  priority: number[] | undefined, scanned: number[] | undefined, signal: AbortSignal,
  completed: (count: number) => void) {
  const binding = product.state.bindings[role];
  if (binding.kind !== 'local-file') return;
  const hash = binding.lastSeen.sha256;
  if (!hash) return;
  const draft = JSON.stringify(product.state);
  const retainedPages = () => new Map((text.get(hash) ?? []).map(page => [page.pageNumber, page]));
  const count = (retained: Map<number, unknown>) => scanned ? scanned.filter(page => retained.has(page)).length : retained.size;
  for (const pages of passes(priority, scanned)) {
    signal.throwIfAborted();
    waiting.set(hash, (waiting.get(hash) ?? 0) + 1);
    let queued = true;
    const settle = () => { if (queued) { queued = false; waiting.set(hash, waiting.get(hash)! - 1); } };
    await onePass(async () => {
      settle();
      const form = new FormData();
      form.append('draft', draft); form.append('role', role);
      form.append('file', file, file.name); form.append('prepareOnly', 'true');
      if (pages) form.append('pages', JSON.stringify(pages));
      // Pages done before this pass, plus the engine's count of this pass's pages.
      const before = retainedPages();
      const done = count(new Map([...before].filter(([page]) => !pages || !pages.includes(page))));
      const response = await followedRequest('/authorities-runtime/source-text',
        { method: 'POST', body: form, signal }, (message) => {
        const recognized = Number(message.split('/')[0]);
        if (Number.isFinite(recognized)) completed(Math.min(scanned?.length ?? Infinity, done + recognized));
      });
      const result = await response.json() as PdfRecognizedText;
      const retained = retainedPages();
      for (const page of result.pages) retained.set(page.pageNumber, page);
      text.set(hash, [...retained.values()]); completed(count(retained));
    }, signal).finally(settle);
  }
}

export async function readSourceText(hash: string, pages?: number[]): Promise<PdfRecognizedText> {
  return {pages:(text.get(hash) ?? []).filter(page => !pages || pages.includes(page.pageNumber))};
}
