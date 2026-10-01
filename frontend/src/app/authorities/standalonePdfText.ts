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

/** The cited pages first, then the other scanned pages in passes of 4, 8 and then 16 pages, so the
 * count moves every few seconds (a pass costs about a second more than its pages, which take about
 * half a second each). A source whose scanned pages are unknown is recognized whole. */
function phases(priority: number[] | undefined, scanned: number[] | undefined) {
  const first = priority?.length ? [[priority]] : [];
  if (!scanned) return [...first, [undefined]];
  const rest = scanned.filter(page => !priority?.includes(page)), passes: number[][] = [];
  for (let at = 0, size = 4; at < rest.length; at += size, size = Math.min(16, size * 2)) passes.push(rest.slice(at, at + size));
  return passes.length ? [...first, passes] : first;
}

export async function prepareSourceText(product: AuthoritiesProduct, role: string, file: File,
  priority: number[] | undefined, scanned: number[] | undefined, signal: AbortSignal,
  completed: (count: number) => void) {
  const binding = product.state.bindings[role];
  if (binding.kind !== 'local-file') return;
  const hash = binding.lastSeen.sha256;
  if (!hash) return;
  const draft = JSON.stringify(product.state);
  const recognize = async (pages: number[] | undefined) => {
    signal.throwIfAborted();
    const form = new FormData();
    form.append('draft', draft); form.append('role', role);
    form.append('file', file, file.name); form.append('prepareOnly', 'true');
    if (pages) form.append('pages', JSON.stringify(pages));
    const result = await (await apiResponse('/authorities-runtime/source-text',
      {method:'POST',body:form,signal})).json() as PdfRecognizedText;
    const retained = new Map((text.get(hash) ?? []).map(page => [page.pageNumber, page]));
    for (const page of result.pages) retained.set(page.pageNumber, page);
    text.set(hash, [...retained.values()]); completed(scanned ? scanned.filter(page=>retained.has(page)).length : retained.size);
  };
  // Each phase holds the runtime's one recognition slot from its first pass to its last.
  for (const passes of phases(priority, scanned)) {
    signal.throwIfAborted();
    waiting.set(hash, (waiting.get(hash) ?? 0) + 1);
    let queued = true;
    const settle = () => { if (queued) { queued = false; waiting.set(hash, waiting.get(hash)! - 1); } };
    await onePass(async () => { settle(); for (const pages of passes) await recognize(pages); }, signal).finally(settle);
  }
}

export async function readSourceText(hash: string, pages?: number[]): Promise<PdfRecognizedText> {
  return {pages:(text.get(hash) ?? []).filter(page => !pages || pages.includes(page.pageNumber))};
}
