import type { PdfRecognizedText } from '@/app/lib/api/documents';

/** OCR coordinates already describe the rotated visible page, unlike PDF.js text transforms. */
export function renderRecognizedText(element: HTMLElement, page: PdfRecognizedText['pages'][number],
  width: number, height: number) {
  if (!(page.width > 0 && page.height > 0)) return;
  const measure = document.createElement('canvas').getContext('2d');
  for (const source of page.lines) {
    const line = document.createElement('div');
    line.style.display = 'contents'; line.dataset.legalText = String(page.pageNumber);
    for (const word of source.words) {
      const [x0,y0,x1,y1] = word.rect;
      if (!word.text.trim() || !word.rect.every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
      const span = document.createElement('span'), size = (y1-y0) / page.height * height;
      span.dataset.pdfTextRun = '';
      Object.assign(span.style, { left: `${x0 / page.width * width}px`, top: `${y0 / page.height * height}px`,
        fontSize: `${size}px`, fontFamily: 'sans-serif', height: `${size}px`, lineHeight: '1' });
      if (measure?.measureText) {
        measure.font = `${size}px sans-serif`;
        const advance = measure.measureText(word.text).width;
        if (advance > 0) span.style.transform = `scaleX(${(x1-x0) / page.width * width / advance})`;
      }
      span.textContent = `${word.text} `; line.append(span);
    }
    const end = document.createElement('br'); line.append(end); element.append(line);
  }
}
