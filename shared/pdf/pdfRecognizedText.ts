export type RecognizedPage = { pageNumber: number; width: number; height: number;
  lines: Array<{ id: string; text?: string; rect: [number, number, number, number];
    words: Array<{ text: string; rect: [number, number, number, number] }> }> };

const REFERENCE = 100;

/** OCR coordinates already describe the rotated visible page, unlike PDF.js text transforms. */
export function renderRecognizedText(element: HTMLElement, page: RecognizedPage,
  width: number, height: number) {
  if (!(page.width > 0 && page.height > 0)) return;
  // Words are measured once at one size and scaled: setting a canvas font for every word of a
  // recognized page took tens of ms on the main thread.
  const measure = document.createElement('canvas').getContext('2d');
  if (measure) measure.font = `${REFERENCE}px sans-serif`;
  for (const source of page.lines) {
    const line = document.createElement('div');
    line.style.display = 'contents'; line.dataset.legalText = String(page.pageNumber);
    // Line-only providers still supply a real text run and its measured line box.
    const runs = source.words.length ? source.words : source.text?.trim()
      ? [{ text: source.text, rect: source.rect }] : [];
    for (const word of runs) {
      const [x0,y0,x1,y1] = word.rect;
      if (!word.text.trim() || !word.rect.every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
      const span = document.createElement('span'), size = (y1-y0) / page.height * height;
      span.dataset.pdfTextRun = '';
      Object.assign(span.style, { left: `${x0 / page.width * width}px`, top: `${y0 / page.height * height}px`,
        fontSize: `${size}px`, fontFamily: 'sans-serif', height: `${size}px`, lineHeight: '1' });
      if (measure?.measureText) {
        const advance = measure.measureText(word.text).width * size / REFERENCE;
        if (advance > 0) {
          span.style.width = `${advance}px`;
          span.style.transform = `scaleX(${(x1-x0) / page.width * width / advance})`;
        }
      }
      span.textContent = `${word.text} `; line.append(span);
    }
    const end = document.createElement('br'); line.append(end); element.append(line);
  }
}
