import { validRect, type AnnotationFragment, type AnnotationRect } from '../../../../../../shared/pdf-annotations.mjs';

// Line selection adapted from Zotero reader's getClosestLine/getLineSelectionRect:
// https://github.com/zotero/reader/blob/2a0bc6554c1d595b1cd7d1a7c61c500a722a4e14/src/pdf/selection.js
// Copyright © 2020–2021 Corporation for Digital Scholarship. AGPL-3.0-only.
// PDF.js EOLs and OCR line breaks supply reading order; the DOM still owns character carets/copy.
type Run = { element: HTMLElement; rect: AnnotationRect };
export type TextLine = { rect: AnnotationRect; runs: Run[]; vertical: boolean };
const cache = new WeakMap<HTMLElement, { width: number; height: number; lines: TextLine[] }>();
const union = (a: AnnotationRect, b: AnnotationRect): AnnotationRect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const rectDistance = (r: AnnotationRect, x: number, y: number) =>
  Math.hypot(Math.max(r[0] - x, x - r[2], 0), Math.max(r[1] - y, y - r[3], 0));

/** Cache page-relative geometry, not screen positions or character-by-character layout reads. */
export function textLines(layer: HTMLElement, pageBox: DOMRect): TextLine[] {
  const cached = cache.get(layer);
  if (cached?.width === pageBox.width && cached.height === pageBox.height) return cached.lines;
  const lines: TextLine[] = [];
  let line: TextLine | undefined;
  for (const element of layer.querySelectorAll<HTMLElement>('[data-pdf-text-run],br')) {
    if (element.tagName === 'BR') { line = undefined; continue; }
    if (!element.textContent?.trim()) continue;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const rect: AnnotationRect = [box.left - pageBox.left, box.top - pageBox.top,
      box.right - pageBox.left, box.bottom - pageBox.top];
    const rotation = Number(layer.dataset.mainRotation || 0) +
      Number(element.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] || 0);
    const vertical = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    if (!line || line.vertical !== vertical) {
      line = { rect, runs: [], vertical }; lines.push(line);
    }
    line.rect = union(line.rect, rect); line.runs.push({ element, rect });
  }
  cache.set(layer, { width: pageBox.width, height: pageBox.height, lines });
  return lines;
}

/** Zotero's line-height band, clipped only along the writing direction at the selected endpoints. */
function lineSelectionRect(line: TextLine, selected: AnnotationRect): AnnotationRect {
  return line.vertical ? [line.rect[0], Math.max(line.rect[1], selected[1]), line.rect[2], Math.min(line.rect[3], selected[3])]
    : [Math.max(line.rect[0], selected[0]), line.rect[1], Math.min(line.rect[2], selected[2]), line.rect[3]];
}

/** Shared by the live blue selection and the saved annotation: neither paints individual words. */
export function selectedPdfFragments(pages: Iterable<HTMLElement>, range: Range): AnnotationFragment[] {
  const fragments: AnnotationFragment[] = [];
  for (const page of pages) {
    const layer = page.querySelector<HTMLElement>('.pdf-text-layer');
    if (!layer || !range.intersectsNode(layer)) continue;
    const box = page.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const rects: AnnotationRect[] = [];
    for (const line of textLines(layer, box)) {
      const first = line.runs[0].element, last = line.runs[line.runs.length - 1].element;
      const wholeLine = range.comparePoint(first, 0) === 0 && range.comparePoint(last, last.childNodes.length) === 0;
      let selected: AnnotationRect | undefined = wholeLine ? line.rect : undefined;
      for (const run of wholeLine ? [] : line.runs) {
        if (!range.intersectsNode(run.element)) continue;
        if (range.comparePoint(run.element, 0) === 0 &&
            range.comparePoint(run.element, run.element.childNodes.length) === 0) {
          selected = selected ? union(selected, run.rect) : run.rect;
          continue;
        }
        const walker = document.createTreeWalker(run.element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent || !range.intersectsNode(node)) continue;
          const part = document.createRange(); part.selectNodeContents(node);
          if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
            part.setStart(range.startContainer, range.startOffset);
          if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
            part.setEnd(range.endContainer, range.endOffset);
          if (part.collapsed) continue;
          for (const r of part.getClientRects()) {
            if (r.width < .1 || r.height < .1) continue;
            const rect: AnnotationRect = [r.left - box.left, r.top - box.top, r.right - box.left, r.bottom - box.top];
            selected = selected ? union(selected, rect) : rect;
          }
        }
      }
      if (selected) {
        const r = lineSelectionRect(line, selected);
        const normalized = r.map((v, i) => Math.max(0, Math.min(1, v / (i % 2 ? box.height : box.width)))) as AnnotationRect;
        if (validRect(normalized)) rects.push(normalized);
      }
    }
    if (rects.length) fragments.push({ pageNumber: Number(page.dataset.pageNumber), rects });
  }
  return fragments;
}

// Same-line/adjacency rules adapted from react-pdf-highlighter optimize-client-rects.ts
// (blob 4998deadebe5c34a4ca9ae167f557f0856bff241). MIT, © 2017 Artem Tyurin.
// Full notice: pdfSelectionGeometry.LICENSE. Bucketing replaces the upstream all-pairs passes.
/** Display old word-box marks as bands too, without rewriting saved annotations or bridging gutters. */
export function annotationLineBands(rects: AnnotationRect[], width: number, height: number): AnnotationRect[] {
  if (rects.length < 2 || !Number.isFinite(width + height) || width <= 0 || height <= 0) return rects;
  const rows = new Map<number, Array<{ top: number; bottom: number; rects: AnnotationRect[] }>>();
  for (const r of rects) {
    const top = r[1] * height, bottom = r[3] * height, bucket = Math.floor(top / 5);
    let row: { top: number; bottom: number; rects: AnnotationRect[] } | undefined;
    for (let b = bucket - 1; b <= bucket + 1 && !row; b++)
      row = rows.get(b)?.find(line => Math.abs(line.top - top) < 5 && Math.abs(line.bottom - bottom) < 5);
    if (!row) {
      row = { top, bottom, rects: [] };
      const items = rows.get(bucket) ?? []; items.push(row); rows.set(bucket, items);
    }
    row.rects.push(r);
  }
  const result: AnnotationRect[] = [];
  for (const rowsAtTop of rows.values()) for (const row of rowsAtTop) {
    let band: AnnotationRect | undefined;
    for (const r of row.rects.sort((a, b) => a[0] - b[0])) {
      if (band && (r[0] - band[2]) * width <= 10) {
        const joined = union(band, r); band.splice(0, 4, ...joined);
      } else { band = [...r]; result.push(band); }
    }
  }
  return result;
}
