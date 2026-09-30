import { decodeAnnotationSet, quadBounds, rectToPdfQuad } from './pdf-annotations.mjs';

/** Standard editable annotations, with printable appearance streams; never alter page contents. */
export function writeAuthorityAnnotations(pdf, document, set, namespace, { author = 'Beaver', comments = true } = {}) {
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
        const point = (offset) => `${q[offset] - x0} ${q[offset + 1] - y0}`;
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
        ...(author && { T: pdf.PDFHexString.fromText(author) }),
        ...(comments && { Contents: pdf.PDFHexString.fromText(contents.slice(0, 2_000)) }),
        AP: { N: document.context.register(appearance) } });
      page.node.addAnnot(document.context.register(annotation));
    }
  }
}
