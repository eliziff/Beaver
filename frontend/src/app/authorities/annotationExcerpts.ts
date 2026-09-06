import { getPdfJs, STANDARD_FONT_DATA_URL } from '@/app/components/shared/views/highlightQuote';
import type { PdfAnnotation } from '../../../../shared/pdf-annotations.mjs';
/** Excerpts are display-only; annotation geometry remains the authority for navigation/export. */
export async function annotationExcerpts(bytes: Uint8Array, marks: PdfAnnotation[], signal: AbortSignal) {
  const pending = marks.filter(mark => !mark.excerpt && mark.kind === 'highlight');
  if (!pending.length) return marks;
  const lib = await getPdfJs();
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false, standardFontDataUrl: STANDARD_FONT_DATA_URL });
  const cancel = () => { void task.destroy(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const pdf = await task.promise; signal.throwIfAborted();
    const excerpts = new Map<string, string>();
    const pages = [...new Set(pending.map(mark => mark.fragments[0].pageNumber))];
    for (const number of pages) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      const items = text.items.flatMap(item => {
        if (!('str' in item) || !item.str.trim()) return [];
        const box = viewport.convertToViewportRectangle([item.transform[4], item.transform[5],
          item.transform[4] + item.width, item.transform[5] + item.height]);
        return [{ text: item.str, x0: Math.min(box[0], box[2])/viewport.width,
          y0: Math.min(box[1], box[3])/viewport.height, x1: Math.max(box[0], box[2])/viewport.width,
          y1: Math.max(box[1], box[3])/viewport.height }];
      });
      for (const mark of pending) {
        const fragment = mark.fragments.find(fragment => fragment.pageNumber === number);
        if (!fragment || excerpts.has(mark.id)) continue;
        const words = items.filter(item => fragment.rects.some(([x0,y0,x1,y1]) =>
          Math.min(x1,item.x1)>Math.max(x0,item.x0) && Math.min(y1,item.y1)>Math.max(y0,item.y0)));
        excerpts.set(mark.id, words.map(item => item.text).join(' ').replace(/\s+/gu,' ').trim().slice(0, 2_000));
      }
    }
    return marks.map(mark => excerpts.get(mark.id) ? { ...mark, excerpt: excerpts.get(mark.id)! } : mark);
  } finally { signal.removeEventListener('abort', cancel); await task.destroy(); }
}
