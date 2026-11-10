// The engine's annotation writer (shared/pdf-annotation-writer.mjs `annotatePdf`, an incremental update): each mark's
// annotations sit where rectToPdfQuad puts its rects on every page geometry, with the fields and printable appearance
// the earlier pdf-lib writer gave them.
import { annotatePdf } from 'mike/shared/pdf-annotation-writer.mjs';
import { ANNOTATION_SCHEMA, quadBounds, rectToPdfQuad, type PdfAnnotation } from 'mike/shared/pdf-annotations.mjs';
import { removeActiveContent } from 'mike/shared/runtime/pdfAssembly.mjs';
import { describe, expect, it } from 'vitest';
import * as pdf from 'pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
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

const round = (value: number) => Math.round(value * 100) / 100;
const numbers = (array: PDFArray | undefined) => array?.asArray().map(item => round((item as PDFNumber).asNumber()));
/** What a viewer reads of each annotation the writers add (links already on the page are left out). */
function annotations(document: PDFDocument) {
  return document.getPages().map(page => (page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.asArray() ?? [])
    .map(ref => document.context.lookup(ref, PDFDict)).filter(a => String(a.get(PDFName.of('Subtype'))) !== '/Link').map(a => {
      const appearance = document.context.lookup(a.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))) as PDFRawStream;
      const gs = appearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS0'), PDFDict);
      const ops = new TextDecoder().decode(decodePDFRawStream(appearance).decode()).replace(/-?\d+(\.\d+)?/g, n => String(round(+n)));
      return { subtype: String(a.get(PDFName.of('Subtype'))), rect: numbers(a.lookup(PDFName.of('Rect'), PDFArray)),
        quads: numbers(a.lookupMaybe(PDFName.of('QuadPoints'), PDFArray)), color: numbers(a.lookup(PDFName.of('C'), PDFArray)),
        interior: numbers(a.lookupMaybe(PDFName.of('IC'), PDFArray)), opacity: round(a.lookup(PDFName.of('CA'), PDFNumber).asNumber()),
        flags: a.lookup(PDFName.of('F'), PDFNumber).asNumber(), border: numbers(a.lookup(PDFName.of('Border'), PDFArray)),
        name: a.lookup(PDFName.of('NM'), PDFHexString).decodeText(), bbox: numbers(appearance.dict.lookup(PDFName.of('BBox'), PDFArray)),
        blend: String(gs.get(PDFName.of('BM'))), fill: round(gs.lookup(PDFName.of('ca'), PDFNumber).asNumber()), ops };
    }));
}

/** What each page should carry: the earlier pdf-lib writer's output, as data. */
function expected(document: PDFDocument, ns: string) {
  const pages: ReturnType<typeof annotations> = document.getPages().map(() => []);
  for (const mark of marks) for (const fragment of mark.fragments) {
    const page = document.getPage(fragment.pageNumber - 1);
    const quads = fragment.rects.map(rect => rectToPdfQuad(rect, page.getCropBox(), page.getRotation().angle));
    const groups = mark.kind === 'highlight' ? [quads] : quads.map(quad => [quad]);
    for (const [part, group] of groups.entries()) {
      const [x0, y0, x1, y1] = quadBounds(group);
      const shapes = group.map(q => { const point = (o: number) => `${round(q[o] - x0)} ${round(q[o + 1] - y0)}`;
        return `${point(0)} m ${point(2)} l ${point(6)} l ${point(4)} l h f`; }).join('\n');
      pages[fragment.pageNumber - 1].push({ subtype: mark.kind === 'highlight' ? '/Highlight' : '/Square', rect: [x0, y0, x1, y1].map(round),
        quads: mark.kind === 'highlight' ? group.flat().map(round) : undefined, color: mark.rgb.map(round),
        interior: mark.kind === 'highlight' ? undefined : mark.rgb.map(round), opacity: round(mark.opacity), flags: 4, border: [0, 0, 0],
        name: `${ns}:${mark.id}:${fragment.pageNumber}:${part}`, bbox: [0, 0, round(x1 - x0), round(y1 - y0)], blend: '/Multiply',
        fill: round(mark.opacity), ops: `q /GS0 gs ${mark.rgb.map(round).join(' ')} rg\n${shapes}\nQ` });
    }
  }
  return pages;
}

describe('engine PDF annotation writer', () => {
  it('writes each mark where rectToPdfQuad places it on every rotation and crop, after the original bytes', async () => {
    const bytes = await fixture(), set = { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: HASH, marks };
    const out = annotatePdf(structureNative(), bytes, set, 'ns');
    expect(Buffer.from(out.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true);
    const written = await PDFDocument.load(out, { parseSpeed: Infinity });
    expect(annotations(written).flat()).toHaveLength(7);
    expect(annotations(written)).toEqual(expected(await PDFDocument.load(bytes, { parseSpeed: Infinity }), 'ns'));
    // The page's own link stays beside the new mark.
    expect(written.getPage(4).node.lookup(PDFName.of('Annots'), PDFArray).size()).toBe(2);
  });

  it('disarms like removeActiveContent and keeps links that only move the reader', async () => {
    const bytes = await fixture();
    const out = annotatePdf(structureNative(), bytes, { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: HASH, marks }, 'ns', { disarm: true });
    const disarmed = await PDFDocument.load(out, { parseSpeed: Infinity });
    expect(disarmed.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    const viaLib = await PDFDocument.load(bytes, { parseSpeed: Infinity });
    removeActiveContent(pdf, viaLib);
    expect(viaLib.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    const link = (d: PDFDocument) => d.context.lookup(d.getPage(4).node.lookup(PDFName.of('Annots'), PDFArray).get(0) as PDFRef, PDFDict)
      .lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText();
    expect(link(disarmed)).toBe('https://example.com');
    expect(link(viaLib)).toBe('https://example.com');
  });

  it('rejects a mark on a missing page', async () => {
    const bytes = await fixture(), value = structuredClone(marks[0]);
    value.fragments = [{ pageNumber: 9, rects: [[.1, .1, .2, .2]] }];
    expect(() => annotatePdf(structureNative(), bytes, { schemaVersion: ANNOTATION_SCHEMA, sourceSha256: HASH, marks: [value] }, 'ns')).toThrow(/missing PDF page/);
  });
});
