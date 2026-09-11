import type { NativePdfPassageGeometry } from './structureNative';
import { sha256 } from './hash';
import { ANNOTATION_SCHEMA, decodeAnnotationSet, quadBounds, rectToPdfQuad, validRect,
  type AnnotationFragment, type AnnotationRect, type PdfAnnotation, type PdfAnnotationSet,
  type AnnotationPreparation } from 'mike/shared/pdf-annotations.mjs';
export type { AnnotationPreparation } from 'mike/shared/pdf-annotations.mjs';

type PdfModule = typeof import('pdf-lib');
type PdfDocument = import('pdf-lib').PDFDocument;
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

/** Standard editable annotations, with printable appearance streams; never alter page contents. */
export function writeAuthorityAnnotations(pdf: PdfModule, document: PdfDocument,
  set: PdfAnnotationSet, namespace: string) {
  const annotations = decodeAnnotationSet(set);
  for (const mark of annotations.marks) for (const fragment of mark.fragments) {
    if (fragment.pageNumber > document.getPageCount()) throw new Error('An annotation refers to a missing PDF page.');
    const page = document.getPage(fragment.pageNumber - 1);
    const quads = fragment.rects.map(rect => rectToPdfQuad(rect, page.getCropBox(), page.getRotation().angle));
    // Squares cannot express disconnected geometry; use one per margin segment.
    const groups = mark.kind === 'highlight' ? [quads] : quads.map(quad => [quad]);
    for (const [part, group] of groups.entries()) {
      const [x0, y0, x1, y1] = quadBounds(group), width = x1 - x0, height = y1 - y0;
      const shapes = group.map(q => {
        const point = (offset: number) => `${q[offset] - x0} ${q[offset + 1] - y0}`;
        return `${point(0)} m ${point(2)} l ${point(6)} l ${point(4)} l h f`;
      }).join('\n');
      const appearance = document.context.flateStream(
        `q /GS0 gs ${mark.rgb.join(' ')} rg\n${shapes}\nQ`, {
          Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height],
          Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: mark.opacity, CA: mark.opacity, BM: 'Multiply' } } },
        });
      const contents = mark.origin === 'manual' ? mark.excerpt || 'Custom highlight'
        : mark.label === 'Cited page' ? mark.label
        : mark.excerpt ? `Cited quote — ${mark.excerpt}` : `Cited passage — ${mark.label}`;
      const annotation = document.context.obj({ Type: 'Annot', Subtype: mark.kind === 'highlight' ? 'Highlight' : 'Square',
        Rect: [x0, y0, x1, y1], ...(mark.kind === 'highlight' ? { QuadPoints: group.flat() } : { IC: [...mark.rgb] }),
        C: [...mark.rgb], CA: mark.opacity, Border: [0, 0, 0], F: 4,
        NM: pdf.PDFHexString.fromText(`${namespace}:${mark.id}:${fragment.pageNumber}:${part}`),
        T: pdf.PDFHexString.fromText('Beaver'), Contents: pdf.PDFHexString.fromText(contents.slice(0, 2_000)),
        AP: { N: document.context.register(appearance) } });
      page.node.addAnnot(document.context.register(annotation));
    }
  }
}
