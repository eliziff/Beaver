import type { PDFDocument, PDFFont, PDFRef, StandardFontEmbedder } from "pdf-lib";

type PdfModule = typeof import("pdf-lib");
export type ArialFace = "regular" | "bold" | "italic" | "boldItalic";
/** Arial's own font files, as the machine has them installed (never shipped with Beaver). */
export type ArialFaces = Partial<Record<ArialFace, Uint8Array>>;
/** A font a PDF assembly embeds: a standard font, a font file, or a font made in the document. */
export type PdfFontSource = import("pdf-lib").StandardFonts | Uint8Array
  | ((document: PDFDocument) => PDFFont | Promise<PDFFont>);

export const ARIAL_POSTSCRIPT_NAMES: Record<ArialFace, string> = {
  regular: "ArialMT", bold: "Arial-BoldMT", italic: "Arial-ItalicMT", boldItalic: "Arial-BoldItalicMT" };

// Arial's advance widths for WinAnsi codes 32 to 255, in thousandths of an em; its italics share them.
const REGULAR = "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,552,400,549,333,333,333,576,537,333,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,549,611,556,556,556,556,500,556,500";
const BOLD = "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,552,400,549,333,333,333,576,556,333,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,549,611,611,611,611,611,556,611,556";
const BOXES: Record<ArialFace, number[]> = { regular: [-665, -325, 2000, 1040], bold: [-628, -376, 2000, 1056],
  italic: [-517, -325, 1359, 998], boldItalic: [-560, -376, 1390, 1018] };

/** Arial for a PDF: its own file embedded as a subset where the machine has it (as Word and Chrome
 *  write it), else a reference to Arial by name with Arial's metrics, which a reader shows in its own
 *  Arial. Either way lines are measured with Arial's widths. */
export function arialFont(pdf: PdfModule, face: ArialFace, faces?: ArialFaces): PdfFontSource {
  const bytes = faces?.[face];
  // A subset is named by a tag of six capitals before the font's own name ("KQWZBH+ArialMT").
  const tag = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  return bytes ? (document) => document.embedFont(bytes, { subset: true, customName: `${tag()}+${ARIAL_POSTSCRIPT_NAMES[face]}` })
    : (document) => arialReference(pdf, document, face);
}

function arialReference(pdf: PdfModule, document: PDFDocument, face: ArialFace): PDFFont {
  const bold = face === "bold" || face === "boldItalic", italic = face === "italic" || face === "boldItalic";
  const widths = (bold ? BOLD : REGULAR).split(",").map(Number), name = ARIAL_POSTSCRIPT_NAMES[face];
  // Helvetica's WinAnsi encoder stands in for Arial's: the same codes, measured with Arial's widths.
  const embedder = pdf.StandardFontEmbedder.for(
    pdf.StandardFonts.Helvetica as unknown as Parameters<typeof pdf.StandardFontEmbedder.for>[0]);
  const [ascent, descent] = [905, -212];
  Object.assign(embedder, {
    fontName: name,
    widthOfTextAtSize: (text: string, size: number) => (embedder as unknown as {
      encodeTextAsGlyphs(text: string): Array<{ code: number }> }).encodeTextAsGlyphs(text)
      .reduce((sum, { code }) => sum + (widths[code - 32] ?? 0), 0) * size / 1000,
    heightOfFontAtSize: (size: number, options: { descender?: boolean } = {}) =>
      (ascent - (options.descender === false ? 0 : descent)) * size / 1000,
    sizeOfFontAtHeight: (height: number) => 1000 * height / (ascent - descent),
    embedIntoContext: (context: PDFDocument["context"], ref?: PDFRef) => {
      const font = context.obj({ Type: "Font", Subtype: "TrueType", BaseFont: name, FirstChar: 32, LastChar: 255,
        Widths: widths, Encoding: "WinAnsiEncoding",
        FontDescriptor: context.register(context.obj({ Type: "FontDescriptor", FontName: name,
          Flags: 32 + (italic ? 64 : 0), FontBBox: BOXES[face], ItalicAngle: italic ? -12 : 0,
          Ascent: ascent, Descent: descent, CapHeight: 716, XHeight: 519, StemV: bold ? 153 : 80 })) });
      if (!ref) return context.register(font);
      context.assign(ref, font);
      return ref;
    },
  } satisfies Partial<StandardFontEmbedder> & Record<string, unknown>);
  const font = pdf.PDFFont.of(document.context.nextRef(), document, embedder);
  (document as unknown as { fonts: PDFFont[] }).fonts.push(font);
  return font;
}
