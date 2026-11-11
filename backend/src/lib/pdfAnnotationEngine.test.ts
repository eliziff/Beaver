// The engine's annotation writer (shared/pdf-annotation-writer.mjs `annotatePdf`, an incremental update).
import { annotatePdf } from 'mike/shared/pdf-annotation-writer.mjs';
import { ANNOTATION_SCHEMA, type PdfAnnotation } from 'mike/shared/pdf-annotations.mjs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString, StandardFonts, degrees } from 'pdf-lib';
import { structureNative } from './structureNative';

const HASH = 'a'.repeat(64);
const marks: PdfAnnotation[] = [
  { id: 'one', kind: 'highlight', origin: 'manual', label: 'Para 1', excerpt: 'x', rgb: [1, .93, .45], opacity: .3,
    fragments: [{ pageNumber: 1, rects: [[.1, .2, .9, .25], [.1, .26, .6, .31]] }, { pageNumber: 2, rects: [[.05, .05, .5, .1]] },
      { pageNumber: 3, rects: [[.2, .3, .4, .35]] }, { pageNumber: 4, rects: [[.6, .7, .95, .72]] }] },
  { id: 'margin', kind: 'margin', origin: 'automatic', label: 'Page 5', excerpt: 'y', rgb: [.2, .5, 1], opacity: .45,
    fragments: [{ pageNumber: 1, rects: [[.02, .2, .04, .3], [.02, .5, .04, .6]] }, { pageNumber: 5, rects: [[.3, .3, .7, .6]] }] },
];

/** Five pages: rotations 0/90/180/270 with offset crop boxes, an inherited media box, and a page that already
 *  carries a link annotation (to stay). The catalog has a JavaScript open action. */
async function fixture() {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, rotation] of [0, 90, 180, 270, 0].entries()) {
    const page = document.addPage([400 + index * 10, 500]);
    page.drawText(`Page ${index + 1} text`, { x: 40, y: 350, size: 12, font });
    if (index) { page.setCropBox(10 + index, 20, 360, 440); page.setRotation(degrees(rotation)); }
  }
  const link = document.context.register(document.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 50],
    A: { S: 'URI', URI: PDFString.of('https://example.com') } }));
  document.getPage(4).node.set(PDFName.of('Annots'), document.context.obj([link]));
  document.catalog.set(PDFName.of('OpenAction'), document.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  return document.save({ useObjectStreams: false });
}

describe('engine PDF annotation writer', () => {
  it('disarms the PDF and keeps links that only move the reader', async () => {
    const bytes = await fixture();
    const out = annotatePdf(structureNative(), bytes, { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: HASH, marks }, 'ns', { disarm: true });
    const disarmed = await PDFDocument.load(out, { parseSpeed: Infinity });
    expect(disarmed.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(disarmed.context.lookup(disarmed.getPage(4).node.lookup(PDFName.of('Annots'), PDFArray).get(0) as PDFRef, PDFDict)
      .lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText()).toBe('https://example.com');
  });

  it('rejects a mark on a missing page', async () => {
    const bytes = await fixture(), value = structuredClone(marks[0]);
    value.fragments = [{ pageNumber: 9, rects: [[.1, .1, .2, .2]] }];
    expect(() => annotatePdf(structureNative(), bytes, { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: HASH, marks: [value] }, 'ns')).toThrow(/missing PDF page/);
  });
});
