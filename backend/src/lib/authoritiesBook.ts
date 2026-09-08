import type { PDFFont as PdfFont, PDFPage as PdfPage, Color as PdfColor } from "pdf-lib";
import type { AuthoritiesCover } from "mike/shared/authorities-contract.d.ts";
import { pdfAssembly, splitPdfPageRanges, type PdfAssemblyInput, type PdfOutline } from "./pdfAssembly";

type PdfModule = typeof import("pdf-lib");
export type BookRow = { key: string; name: string; tab: string; sourceUrl?: string | null };
export type PreparedBookSource<Bytes = Uint8Array> = BookRow & {
  bytes: Bytes; pageIndices: number[]; ocrTextByPage?: string[];
  databaseReference: { url: string; host: string } | null;
  bookmarks: Array<{ title: string; pageIndex: number }>;
};
export type PreparedAuthoritiesBook<Bytes = Uint8Array> = {
  filename: string; subtitle: string; documentTitle: string; bookTitle: string;
  federal: boolean; electronic: boolean; court: string; cover: AuthoritiesCover;
  allowIncomplete: boolean; coverLine: string | null;
  paperCover: { rgb: readonly [number, number, number]; dark: boolean } | null;
  customCover?: Bytes; customIndex?: Bytes;
  coverPageCount: number; customIndexPages: number;
  limits?: { maxPages: number; maxBytes: number; completeToc?: boolean; coverLabels?: boolean };
  groups: Array<{ label: string; entries: BookRow[] }>;
  sources: PreparedBookSource<Bytes>[];
};
export type BuiltAuthorityBook = { role: "book" | `book-${number}`; filename: string;
  mimeType: "application/pdf"; bytes: Uint8Array; pageCount: number };

export async function mapAuthorityBookBytes<From, To>(book: PreparedAuthoritiesBook<From>,
  convert: (bytes: From, role: string) => To | Promise<To>): Promise<PreparedAuthoritiesBook<To>> {
  return { ...book,
    customCover: book.customCover === undefined ? undefined : await convert(book.customCover, "book-cover"),
    customIndex: book.customIndex === undefined ? undefined : await convert(book.customIndex, "book-index"),
    sources: await Promise.all(book.sources.map(async (source, index) => ({ ...source,
      bytes: await convert(source.bytes, `book-source-${index}`) }))),
  };
}

export async function renderAuthoritiesBook(pdf: PdfModule, input: PreparedAuthoritiesBook,
  signal?: AbortSignal): Promise<BuiltAuthorityBook[]> {
  const engine = pdfAssembly(pdf);
  const { federal, electronic, paperCover, coverLine, documentTitle, bookTitle, subtitle,
    customCover, customIndex, coverPageCount, customIndexPages, limits, groups } = input;
  const tokens = groups.flatMap((group) => [
    { label: group.label, entry: null as BookRow | null },
    ...group.entries.map((entry) => ({ label: "", entry })),
  ]);
  const chunks = Array.from({ length: Math.ceil(tokens.length / 23) }, (_, index) =>
    tokens.slice(index * 23, index * 23 + 23));
  const all = input.sources.map((source) => ({ source, pageIndices: source.pageIndices }));
  const singlePages = coverPageCount + (customIndexPages || chunks.length) +
    all.reduce((sum, item) => sum + item.pageIndices.length, 0) +
    (paperCover && !customCover ? 1 : 0);
  const splitOverhead = coverPageCount + (customIndexPages || chunks.length) +
    (limits?.coverLabels ? 1 : 0);
  if (limits && splitOverhead >= limits.maxPages) throw new Error(
    "The required Federal volume front matter exceeds the filing page limit.");
  const volumes = limits && singlePages > limits.maxPages
    ? splitPdfPageRanges(all, limits.maxPages - splitOverhead) : [all];
  const built = await engine.volumes(volumes, (volumes) => {
    const multi = volumes.length > 1, generatedToc = !customIndex;
    if (customIndex && multi && limits?.completeToc) throw new Error(
      "Remove the custom index so the builder can generate a complete index for every filing volume.");
    const indexPageCount = customIndexPages + (generatedToc ? chunks.length : 0);
    const backPageCount = multi && limits?.coverLabels ? 1 : paperCover && !customCover ? 1 : 0;
    let globalStart = 0;
    const ranges = new Map<string, string[]>();
    const plans = volumes.map((slices) => {
      let localStart = coverPageCount + indexPageCount;
      const placed = slices.map((slice) => {
        const result = { ...slice, localStart };
        const first = globalStart + localStart + 1, last = first + slice.pageIndices.length - 1;
        (ranges.get(slice.source.key) ?? ranges.set(slice.source.key, []).get(slice.source.key)!)
          .push(first === last ? String(first) : `${first}–${last}`);
        localStart += slice.pageIndices.length;
        return result;
      });
      const result = { slices: placed, globalStart };
      globalStart += localStart + backPageCount;
      return result;
    });
    return plans.map((plan, volumeIndex): PdfAssemblyInput<"serif" | "serifBold" | "regular" | "bold"> => {
      const margin = federal ? 99.21 : 72, contentWidth = 612 - (2 * margin);
      const volumeLabel = `Volume ${volumeIndex + 1} of ${volumes.length}`;
      const localStarts = new Map(plan.slices.map(({ source, localStart }) => [source.key, localStart]));
      const links: NonNullable<PdfAssemblyInput<string>["links"]> = [];
      return {
        signal, fonts: { serif: pdf.StandardFonts.TimesRoman, serifBold: pdf.StandardFonts.TimesRomanBold,
          regular: federal ? pdf.StandardFonts.TimesRoman : pdf.StandardFonts.Helvetica,
          bold: federal ? pdf.StandardFonts.TimesRomanBold : pdf.StandardFonts.HelveticaBold },
        parts: plan.slices.map(({ source, pageIndices }) => ({
          id: source.key, source: source.bytes, pageIndices, ocrFont: "regular",
          ocrTextByPage: source.ocrTextByPage,
          decorate: source.databaseReference ? (page, _index, { fonts }) => {
            const { url, host } = source.databaseReference!;
            const crop = page.getCropBox(), label = `FREE PUBLIC DATABASE: ${host}`;
            const size = 12, width = fonts.bold.widthOfTextAtSize(label, size) + 10;
            const x = crop.x + 99.21, y = crop.y + crop.height - 80;
            page.drawRectangle({ x: x - 5, y: y - 3, width, height: 18,
              color: pdf.rgb(1, 1, 1), borderColor: pdf.rgb(.15, .15, .15), borderWidth: .6,
              opacity: .94, borderOpacity: 1 });
            page.drawText(label, { x, y, size, font: fonts.bold, color: pdf.rgb(.08, .08, .08) });
            links.push({ page, rect: [x - 5, y - 3, x - 5 + width, y + 15], url });
          } : undefined,
        })),
        before: async ({ document, fonts: { regular, bold, serif } }) => {
          let coverBottom = 400;
          if (customCover) await engine.appendPages(document, customCover);
          else {
            const cover = document.addPage([612, 792]);
            if (paperCover) cover.drawRectangle({ x: 0, y: 0, width: 612, height: 792,
              color: pdf.rgb(...paperCover.rgb) });
            const ink = paperCover?.dark ? pdf.rgb(1, 1, 1) : pdf.rgb(.18, .18, .18);
            if (federal) coverBottom = drawFederalForm66Cover(cover, regular, bold, input.cover,
              input.court, documentTitle, coverLine, ink);
            else {
              cover.drawRectangle({ x: 0, y: 0, width: 18, height: 792, color: ink });
              cover.drawLine({ start: { x: margin, y: 626 }, end: { x: 612 - margin, y: 626 },
                thickness: 2, color: ink });
              cover.drawText(fit(bold, documentTitle, 28, contentWidth),
                { x: margin, y: 500, size: 28, font: bold, color: ink });
              if (bookTitle !== subtitle) cover.drawText(fit(serif, subtitle, 13, contentWidth),
                { x: margin, y: 462, size: 13, font: serif, color: ink });
            }
          }
          if (input.allowIncomplete) {
            const first = document.getPage(0), width = first.getWidth();
            first.drawRectangle({ x: 0, y: 0, width, height: 28, color: pdf.rgb(1, .94, .88) });
            first.drawText("DRAFT - INCOMPLETE SOURCES - NOT FOR FILING", {
              x: Math.min(24, width / 20), y: 10, size: Math.min(10, width / 48), font: bold,
              color: pdf.rgb(.55, .1, .06),
            });
          }
          if (multi && limits?.coverLabels) document.getPage(0).drawText(volumeLabel,
            { x: margin, y: Math.min(400, coverBottom), size: 12, font: bold });
          if (customIndex) await engine.appendPages(document, customIndex);
          if (generatedToc) chunks.forEach((chunk, chunkIndex) => {
            const page = document.addPage([612, 792]);
            page.drawText(chunkIndex ? "Table of Contents — continued" : "Table of Contents",
              { x: federal ? margin : 48, y: federal ? 708 : 730,
                size: federal ? 12 : 20, font: bold });
            let y = federal ? 670 : 690;
            for (const token of chunk) {
              if (!token.entry) {
                page.drawRectangle({ x: federal ? margin : 48, y: y - 8,
                  width: federal ? contentWidth : 516, height: 22, color: pdf.rgb(.92, .92, .92) });
                page.drawText(token.label.toUpperCase(), { x: federal ? margin + 8 : 56, y,
                  size: federal ? 12 : 8.5, font: bold });
                y -= 27; continue;
              }
              const bodySize = federal ? 12 : 8.8, tabX = federal ? margin + 6 : 54;
              const titleX = federal ? margin + 52 : 102, sourceX = federal ? 447 : 477;
              const pageRight = federal ? 612 - margin : 547;
              page.drawText(token.entry.tab, { x: tabX, y, size: federal ? 12 : 7.5, font: bold });
              page.drawText(fit(serif, token.entry.name, bodySize,
                token.entry.sourceUrl ? sourceX - titleX - 8 : pageRight - titleX - 28),
              { x: titleX, y, size: bodySize, font: serif });
              if (token.entry.sourceUrl) page.drawText("source", { x: sourceX, y,
                size: federal ? 12 : 7.5, font: regular, color: pdf.rgb(.55, .05, .05) });
              const pageLabel = ranges.get(token.entry.key)?.join(", ") ?? "—";
              const pageSize = federal ? 12 : 8;
              page.drawText(pageLabel, { x: pageRight - bold.widthOfTextAtSize(pageLabel, pageSize),
                y, size: pageSize, font: bold });
              page.drawLine({ start: { x: titleX, y: y - 7 },
                end: { x: federal ? 612 - margin : 564, y: y - 7 },
                thickness: .45, color: pdf.rgb(.82, .82, .82) });
              const start = localStarts.get(token.entry.key);
              if (start !== undefined) links.push({ page, targetPageIndex: start,
                rect: [federal ? margin : 48, y - 10,
                  token.entry.sourceUrl ? sourceX - 5 : federal ? 612 - margin : 564, y + 10] });
              if (token.entry.sourceUrl) links.push({ page, url: token.entry.sourceUrl,
                rect: [sourceX - 5, y - 10, federal ? 492 : 526, y + 10] });
              y -= 25;
            }
            if (!(federal && electronic)) {
              const value = String(plan.globalStart + coverPageCount + customIndexPages + chunkIndex + 1);
              const size = federal ? 12 : 8;
              page.drawText(value, { x: federal ? (612 - regular.widthOfTextAtSize(value, size)) / 2 : 540,
                y: federal ? 75 : 24, size, font: regular });
            }
          });
        },
        after: ({ document, fonts: { bold } }) => {
          if (backPageCount) {
            const back = document.addPage([612, 792]);
            if (paperCover) back.drawRectangle({ x: 0, y: 0, width: 612, height: 792,
              color: pdf.rgb(...paperCover.rgb) });
            if (multi && limits?.coverLabels) back.drawText(volumeLabel,
              { x: margin, y: 400, size: 12, font: bold });
          }
          document.setTitle(documentTitle); document.setSubject("Navigable book of legal authorities");
          document.setCreator("Beaver"); document.setProducer("Beaver · pdf-lib");
          document.setCreationDate(new Date(0)); document.setModificationDate(new Date(0));
          document.catalog.set(pdf.PDFName.of("Lang"), pdf.PDFHexString.fromText("en-CA"));
        },
        links, openBookmarks: true, pageLabels: plan.globalStart + 1,
        pageNumbers: federal && electronic ? { font: "regular", start: plan.globalStart + 1,
          position: "bottom-right", size: 12, inset: 99.21, offset: 54 } : undefined,
        outlines: () => [
          { title: documentTitle, pageIndex: 0 },
          { title: "Table of Contents", pageIndex: coverPageCount + (generatedToc ? customIndexPages : 0) },
          ...groups.flatMap(({ label, entries }): PdfOutline[] => {
            const local = entries.filter(({ key }) => localStarts.has(key));
            return local.length ? [{ title: label, pageIndex: localStarts.get(local[0].key)!,
              children: local.map((entry) => {
                const slice = plan.slices.find(({ source }) => source.key === entry.key)!;
                return { title: `${entry.tab} — ${entry.name}`, pageIndex: localStarts.get(entry.key)!,
                  children: slice.source.bookmarks.flatMap(({ title, pageIndex }) => {
                    const offset = slice.pageIndices.indexOf(pageIndex);
                    return offset < 0 ? [] : [{ title, pageIndex: localStarts.get(entry.key)! + offset }];
                  }) };
              }) }] : [];
          }),
        ],
        saveOptions: { useObjectStreams: false },
      };
    });
  }, limits, (volume) => {
    const count = volume.reduce((sum, item) => sum + item.pageIndices.length, 0);
    if (count < 2) throw new Error("One PDF page exceeds the Federal electronic filing size limit.");
    return splitPdfPageRanges(volume, Math.ceil(count / 2));
  });
  return built.map((output, index) => ({ ...output, role: index ? `book-${index + 1}` : "book",
    mimeType: "application/pdf", filename: volumes.length > 1 ? input.filename.replace(/\.pdf$/iu,
      `.volume-${index + 1}-of-${volumes.length}.pdf`) : input.filename }));
}

export function fit(font: PdfFont, value: string, size: number, width: number) {
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  let text = value;
  while (text && font.widthOfTextAtSize(`${text}…`, size) > width) text = text.slice(0, -1);
  return `${text}…`;
}

export const pdfNormalized = (value: string) => value.normalize("NFKC")
  .replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"')
  .replace(/[\u2013\u2014]/gu, "-").replace(/\u2026/gu, "...");

export const pdfText = (value: string) =>
  pdfNormalized(value).replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/gu, "?");

export function wrapped(font: PdfFont, value: string, size: number, width: number) {
  const lines: string[] = [];
  for (const raw of pdfText(value).split(/\r?\n/u)) {
    const words = raw.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawFederalForm66Cover(page: PdfPage, regular: PdfFont, bold: PdfFont,
  cover: AuthoritiesCover, court: string, title: string, filedBy: string | null,
  color: PdfColor) {
  const margin = 99.21, { width, height } = page.getSize();
  const clean = (value: string) => {
    const text = pdfNormalized(value);
    if (/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/u.test(text)) throw new Error(
      "The Federal cover contains characters unavailable in the prescribed court fonts.");
    return text;
  };
  const centred = (value: string, y: number, font = regular) => {
    const text = clean(value);
    page.drawText(text, { x: (width - font.widthOfTextAtSize(text, 12)) / 2,
      y, size: 12, font, color });
  };
  const file = clean(`Court File No. ${cover.courtFileNumber}`);
  page.drawText(file, { x: width - margin - regular.widthOfTextAtSize(file, 12),
    y: height - 78, size: 12, font: regular, color });
  centred(court, height - 118, bold);
  page.drawText("BETWEEN:", { x: margin, y: height - 157, size: 12, font: regular, color });
  let y = height - 193;
  cover.partyGroups.forEach(({ role, parties }, index) => {
    const names = wrapped(regular, clean(parties.join(", ")), 12, width - (2 * margin));
    names.forEach((name) => { centred(name, y); y -= 14; });
    y -= 20;
    const label = clean(role);
    page.drawText(label, { x: width - margin - regular.widthOfTextAtSize(label, 12),
      y, size: 12, font: regular, color });
    if (index < cover.partyGroups.length - 1) {
      centred("and", y - 26); y -= 52;
    } else y -= 32;
  });
  if (cover.applicationUnder) {
    for (const line of wrapped(regular, clean(
      `APPLICATION UNDER ${cover.applicationUnder}`), 12, width - (2 * margin))) {
      centred(line, y); y -= 15;
    }
    y -= 17;
  }
  y -= 8;
  for (const line of wrapped(bold, clean(title.toUpperCase()), 12, width - (2 * margin))) {
    centred(line, y, bold); y -= 16;
  }
  if (filedBy) { y -= 10; centred(filedBy, y); y -= 16; }
  if (y < 135) throw new Error(
    "The Federal style of cause is too long for one Form 66 cover page.");
  return y - 10;
}
