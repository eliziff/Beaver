import type { NativePdfPassageGeometry } from './structureNative';
import { sha256 } from './hash';
import { ANNOTATION_SCHEMA, decodeAnnotationSet, validRect,
  type AnnotationFragment, type AnnotationRect, type PdfAnnotation,
  type AnnotationPreparation } from 'mike/shared/pdf-annotations.mjs';
export type { AnnotationPreparation } from 'mike/shared/pdf-annotations.mjs';

type Style = 'none' | 'margin' | 'paragraph' | 'text' | 'sidelined';
const labelFor = (kind: string, value: string) => `${kind === 'paragraph' ? 'para' : kind === 'section' ? 's' : 'p'} ${value}`;
const normal = (rect: number[], width: number, height: number): AnnotationRect =>
  [rect[0] / width, rect[1] / height, rect[2] / width, rect[3] / height]
    .map(v => Math.min(1, Math.max(0, v))) as AnnotationRect;

/** Both pre-build review and unreviewed exports use these exact initial marks. */
export function initialAuthorityAnnotations(input: {
  sourceSha256: string; style: Style; geometry?: NativePdfPassageGeometry;
  pages: Array<{ width: number; height: number }>; citedPages: Set<number>;
  exclusions?: ReadonlySet<string>;
}): AnnotationPreparation {
  const marks: PdfAnnotation[] = [], unlocated: string[] = [];
  const add = (kind: PdfAnnotation['kind'], label: string, excerpt: string, fragments: AnnotationFragment[]) => {
    fragments = fragments.map(f => ({ ...f, rects: f.rects.filter(validRect) })).filter(f => f.rects.length);
    if (!fragments.length) return;
    const identity = sha256(JSON.stringify([kind, label, excerpt, fragments])).slice(0, 32);
    if (marks.some(mark => mark.id === identity)) return;
    marks.push({ id: identity, kind, origin: 'automatic', label, excerpt: excerpt.slice(0, 2_000),
      rgb: kind === 'highlight' ? [1, .92, .6] : input.style === 'sidelined' ? [.08, .08, .08] : [.75, .08, .08],
      opacity: kind === 'highlight' ? .45 : .9, fragments });
  };
  if (input.geometry && input.geometry.sourceSha256 !== input.sourceSha256)
    throw new Error('Passage geometry belongs to a different PDF.');
  const targets = (input.geometry?.targets ?? []).filter(target =>
    !input.exclusions?.has(`${target.locatorKind.trim()}\0${target.locator.trim()}`));
  if (input.style !== 'none') for (const target of targets) {
    const label = labelFor(target.locatorKind, target.locator);
    const excerpt = target.pages.map(page => page.text ?? '').join(' ').trim().slice(0, 2_000);
    const found = target.status === 'found';
    const fragments = found ? target.pages.flatMap(page => {
      if (page.source !== 'native' || !input.pages[page.pageNumber - 1] || page.width <= 0 || page.height <= 0) return [];
      const rects = page.passageRects.map(r => normal(r, page.width, page.height)).filter(validRect);
      return rects.length ? [{ pageNumber: page.pageNumber, rects }] : [];
    }) : [];
    if (!fragments.length && target.locatorKind !== 'page') unlocated.push(label);
    if (input.style === 'paragraph') add('highlight', label, excerpt, fragments);
    if (input.style === 'margin' || input.style === 'sidelined') {
      add('margin', label, excerpt, fragments.map(fragment => {
        const width = input.pages[fragment.pageNumber - 1].width;
        const x = Math.max(0, Math.min(...fragment.rects.map(r => r[0])) - 7 / width);
        return { ...fragment, rects: [[x, Math.min(...fragment.rects.map(r => r[1])),
          x + 2 / width, Math.max(...fragment.rects.map(r => r[3]))]] };
      }));
    }
    if (input.style === 'text' || input.style === 'margin') for (const quote of target.quotes) {
      // Each quote is independent, even when several quotes cite the same paragraph/page.
      const quoteFragments = (quote.fragments ?? (quote.pageNumber ? [{ pageNumber: quote.pageNumber, rects: quote.rects }] : []))
        .flatMap(fragment => {
          const page = target.pages.find(page => page.pageNumber === fragment.pageNumber);
          return page && input.pages[page.pageNumber - 1] ? [{ pageNumber: page.pageNumber,
            rects: fragment.rects.map(rect => normal(rect, page.width, page.height)).filter(validRect) }] : [];
        });
      if (quote.status !== 'found' || !quoteFragments.length || quoteFragments.some(f => !f.rects.length)) continue;
      add('highlight', `${label} · Quote`, quote.text, quoteFragments);
    }
  }
  // Verified passage pages and explicit page citations anchor a page margin, and so
  // does a passage whose own extent could not be located: the page carries the mark.
  const marginal = input.style === 'margin' || input.style === 'sidelined';
  if (marginal || unlocated.length) {
    const allExcluded = !!input.geometry?.targets.length && !targets.length;
    if (!allExcluded) for (const [index, { width, height }] of input.pages.entries()) {
      const pageNumber = index + 1;
      const hasMark = marks.some(mark => mark.kind === 'margin' && mark.fragments.some(f => f.pageNumber === pageNumber));
      const hasTarget = marginal && targets.some(target => target.status === 'found' && target.pages.some(page => page.pageNumber === pageNumber));
      if (!hasMark && (input.citedPages.has(index) || hasTarget)) add('margin', 'Cited page', '', [{ pageNumber,
        rects: [[6.75 / width, 18 / height, 9.25 / width, 1 - 18 / height]] }]);
    }
  }
  const marked = marks.some(mark => mark.label === 'Cited page');
  return { annotations: decodeAnnotationSet({ schemaVersion: ANNOTATION_SCHEMA,
    sourceSha256: input.sourceSha256, marks }),
    pageMarked: marked ? [...new Set(unlocated)] : [] };
}
