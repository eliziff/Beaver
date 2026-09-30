import { apiResponse } from '@/app/lib/api/client';
import type { PdfRecognizedText } from '@/app/lib/api/documents';
import type { AuthoritiesProduct } from './types';

const text = new Map<string, PdfRecognizedText['pages']>();

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
    const result = await (await apiResponse('/authorities-runtime/source-text',
      {method:'POST',body:form,signal})).json() as PdfRecognizedText;
    const retained = new Map((text.get(hash) ?? []).map(page => [page.pageNumber, page]));
    for (const page of result.pages) retained.set(page.pageNumber, page);
    text.set(hash, [...retained.values()]); completed(scanned ? scanned.filter(page=>retained.has(page)).length : retained.size);
  }
}

export async function readSourceText(hash: string, pages?: number[]): Promise<PdfRecognizedText> {
  return {pages:(text.get(hash) ?? []).filter(page => !pages || pages.includes(page.pageNumber))};
}
