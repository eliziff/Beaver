import type { PDFFont as PdfFont, PDFPage as PdfPage, Color as PdfColor } from "pdf-lib";
import type { AuthoritiesCover } from "../authorities-contract.d.ts";
import { mapOutline, pdfAssembly, splitPdfPageRanges, type PdfAssemblyInput,
  type PdfOutline } from "./pdfAssembly.mjs";

type PdfModule = typeof import("pdf-lib");
/** `italic`: how many of the name's first characters are italic, its style of cause or title. */
export type BookRow = { key: string; name: string; italic?: number; tab: string; sourceUrl?: string | null };
/** `header`: a line at the top of its first page in the book (an excerpt's currency, where the
 *  excerpt leaves out the page that states it). */
export type PreparedBookSource<Bytes = Uint8Array> = BookRow & {
  bytes: Bytes; pageIndices: number[]; ocrTextByPage?: string[]; header?: string;
  databaseReference: { url: string; host: string } | null;
  bookmarks: Array<{ title: string; pageIndex: number }>;
  /** The source's own outline: its publisher bookmarks, or the headings and sections read from it. */
  outline?: PdfOutline[];
};
export type PreparedAuthoritiesBook<Bytes = Uint8Array> = {
  filename: string; subtitle: string; documentTitle: string; bookTitle: string;
  federal: boolean; electronic: boolean; court: string; cover: AuthoritiesCover;
  coverLine: string | null;
  paperCover: { rgb: readonly [number, number, number]; dark: boolean } | null;
  /** The Alberta Rules of Court's filing cover in place of the plain one. */
  alberta?: boolean;
  /** What the index gives beside each citation: its tab, or its tab and the pages it fills. */
  indexShows?: "tabs" | "tabs-and-pages";
  /** A "TAB n" page before each authority, where its index link and bookmark land. */
  tabPages?: boolean;
  customCover?: Bytes; customIndex?: Bytes;
  coverPageCount: number; customIndexPages: number;
  /** The court's upload limits: a book past them is divided into volumes at tab boundaries, each
   *  cover saying which volume it is (`coverLabels`), and the index in every volume (`completeToc`)
   *  or the first alone. */
  limits?: { maxPages?: number; maxBytes?: number; completeToc?: boolean; coverLabels?: boolean };
  /** For printing on both sides: each tab page and each authority's first page on a right-hand page. */
  rightHandStarts?: boolean;
  groups: Array<{ label: string; entries: BookRow[] }>;
  sources: PreparedBookSource<Bytes>[];
};
/** `pageIndex`: an authority's first page; `tabPageIndex`: its tab page, or its first page without one. */
export type BuiltAuthorityBook = { role: "book" | `book-${number}`; filename: string;
  mimeType: "application/pdf"; bytes: Uint8Array; pageCount: number;
  placements: Array<{ key: string; pageIndex: number; tabPageIndex: number; sourcePageIndices: number[] }> };

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
  const showPages = input.indexShows === "tabs-and-pages", tabPages = !!input.tabPages;
  const rightHand = !!input.rightHandStarts;
  // Under headings where the authorities are grouped; one list, bookmarked tab by tab, where not.
  const grouped = groups.length > 1 || !!groups.length && groups[0].label !== "Authorities";
  // The index lists each citation in full, wrapped onto as many lines as it takes, and runs onto as
  // many pages as its entries fill. The Federal Court's index keeps its tab to the left and its
  // source link; any other gives the citation, a dot leader and the tab (and the pages) to the right.
  const margin = federal ? 99.21 : 72, bodySize = federal ? 12 : 11, leading = bodySize + 3;
  const titleX = federal ? margin + 52 : margin, sourceX = 447, pageRight = 612 - margin;
  const tabColumn = 58, pagesColumn = showPages ? 66 : 0;
  const scratch = await pdf.PDFDocument.create(), measure = { roman: await scratch.embedFont(pdf.StandardFonts.TimesRoman),
    italic: await scratch.embedFont(pdf.StandardFonts.TimesRomanItalic) };
  const tokens = groups.flatMap((group) => [
    ...grouped ? [{ label: group.label, entry: null as BookRow | null, lines: [] as ReturnType<typeof citationLines>,
      height: federal ? 27 : 30 }] : [],
    ...group.entries.map((entry) => {
      // Clear of the page numbers, and of the Federal Court's source link.
      const lines = citationLines(measure, entry.name, entry.italic ?? 0, bodySize, federal
        ? entry.sourceUrl ? sourceX - titleX - 8 : pageRight - titleX - (showPages ? 48 : 8)
        : pageRight - titleX - tabColumn - pagesColumn - 24);
      return { label: "", entry, lines, height: (federal ? 25 : 12) + (lines.length - (federal ? 1 : 0)) * leading };
    }),
  ]);
  const top = federal ? 670 : 680, bottom = federal ? 100 : 84, chunks: Array<typeof tokens> = [[]];
  let room = top - bottom;
  tokens.forEach((token, index) => {
    // A heading never ends a page.
    const needs = token.height + (token.entry ? 0 : tokens[index + 1]?.height ?? 0);
    if (chunks[chunks.length - 1].length && needs > room) { chunks.push([]); room = top - bottom; }
    chunks[chunks.length - 1].push(token); room -= token.height;
  });
  const readSourceOutlines = async (bytes: Uint8Array) => {
    signal?.throwIfAborted();
    const document = await pdf.PDFDocument.load(bytes, { updateMetadata: false });
    signal?.throwIfAborted();
    return engine.readOutlines(document);
  };
  const [sources, coverOutline, indexOutline] = await Promise.all([
    Promise.all(input.sources.map(async source => source.outline !== undefined ? source :
      { ...source, outline: await readSourceOutlines(source.bytes) })),
    customCover ? readSourceOutlines(customCover) : [],
    customIndex ? readSourceOutlines(customIndex) : [],
  ]);
  const all = sources.map((source) => ({ source, pageIndices: source.pageIndices }));
  // The pages an authority may add around its own: its tab page, and the blanks that start it on
  // the right.
  const added = (tabPages ? 1 : 0) + (rightHand ? tabPages ? 2 : 1 : 0);
  const singlePages = coverPageCount + (customIndexPages || chunks.length) +
    all.reduce((sum, item) => sum + item.pageIndices.length + added, 0) +
    (paperCover && !customCover ? 1 : 0);
  const splitOverhead = coverPageCount + (customIndexPages || chunks.length) +
    (limits?.coverLabels ? 1 : 0);
  if (limits?.maxPages && splitOverhead >= limits.maxPages) throw new Error(
    "The required volume front matter exceeds the filing page limit.");
  const volumes = limits?.maxPages && singlePages > limits.maxPages
    ? splitAtTabs(all, limits.maxPages - splitOverhead, added) : [all];
  let placements: BuiltAuthorityBook["placements"][] = [];
  const built = await engine.volumes(volumes, (volumes) => {
    const multi = volumes.length > 1, generatedToc = !customIndex;
    if (customIndex && multi && limits?.completeToc) throw new Error(
      "Remove the custom index so the builder can generate a complete index for every filing volume.");
    // The index opens every volume where the court wants it complete in each, else the first.
    const indexed = (volumeIndex: number) => generatedToc && (!volumeIndex || !!limits?.completeToc);
    const backPageCount = multi && limits?.coverLabels ? 1 : paperCover && !customCover ? 1 : 0;
    let globalStart = 0;
    const ranges = new Map<string, string[]>(), volumeOf = new Map<string, number>();
    const plans = volumes.map((slices, volumeIndex) => {
      let localStart = coverPageCount + customIndexPages + (indexed(volumeIndex) ? chunks.length : 0);
      const placed = slices.map((slice) => {
        // A tab page, and the blanks that put it on the right, open an authority, not each volume
        // it runs into.
        const opens = slice.pageIndices[0] === slice.source.pageIndices[0];
        const tabbed = tabPages && opens;
        if (opens && !volumeOf.has(slice.source.key)) volumeOf.set(slice.source.key, volumeIndex);
        const blankBefore = rightHand && opens && localStart % 2 ? 1 : 0;
        localStart += blankBefore;
        const tabStart = localStart, blankAfter = rightHand && tabbed ? 1 : 0;
        if (tabbed) localStart += 1 + blankAfter;
        const result = { ...slice, localStart, tabStart, tabbed, blankBefore, blankAfter };
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
    placements = plans.map(({ slices }) => slices.map(({ source, localStart, tabStart, pageIndices }) =>
      ({ key: source.key, pageIndex: localStart, tabPageIndex: tabStart, sourcePageIndices: pageIndices })));
    return plans.map((plan, volumeIndex): PdfAssemblyInput<"serif" | "serifItalic" | "serifBold" | "regular" | "bold"> => {
      const contentWidth = 612 - (2 * margin);
      const volumeLabel = `Volume ${volumeIndex + 1} of ${volumes.length}`;
      const localStarts = new Map(plan.slices.map(({ source, localStart }) => [source.key, localStart]));
      // Where the index and the bookmarks take a reader: the tab page, else the authority's first page.
      const tabStarts = new Map(plan.slices.filter(({ source, pageIndices }) => pageIndices[0] === source.pageIndices[0])
        .map(({ source, tabStart }) => [source.key, tabStart]));
      for (const { source, localStart } of plan.slices) if (!tabStarts.has(source.key)) tabStarts.set(source.key, localStart);
      const indexStart = coverPageCount + (generatedToc ? customIndexPages : 0);
      const indexPages = indexed(volumeIndex) ? chunks : [];
      const indexTitle = federal ? "Table of Contents" : "Index";
      const links: NonNullable<PdfAssemblyInput<string>["links"]> = [];
      return {
        signal, fonts: { serif: pdf.StandardFonts.TimesRoman, serifItalic: pdf.StandardFonts.TimesRomanItalic,
          serifBold: pdf.StandardFonts.TimesRomanBold,
          regular: federal ? pdf.StandardFonts.TimesRoman : pdf.StandardFonts.Helvetica,
          bold: federal ? pdf.StandardFonts.TimesRomanBold : pdf.StandardFonts.HelveticaBold },
        parts: plan.slices.map(({ source, pageIndices, tabbed, blankBefore, blankAfter }) => ({
          id: source.key, source: source.bytes, pageIndices, ocrFont: "regular",
          ocrTextByPage: source.ocrTextByPage,
          draw: tabbed || blankBefore ? ({ document, fonts }) => {
            if (blankBefore) document.addPage([612, 792]);
            if (tabbed) drawTabPage(document.addPage([612, 792]), source.tab, fonts.bold);
            if (blankAfter) document.addPage([612, 792]);
          } : undefined,
          decorate: source.databaseReference || source.header ? (page, index, { fonts }) => {
            if (source.header && index === source.pageIndices[0]) engine.drawPageNumber(page, source.header,
              fonts.regular, "top-centre", 8, 72, 24);
            if (!source.databaseReference) return;
            const { url, host } = source.databaseReference;
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
        before: async ({ document, fonts: { regular, bold, serif, serifItalic, serifBold } }) => {
          let coverBottom = 400;
          if (customCover) await engine.appendPages(document, customCover);
          else {
            const cover = document.addPage([612, 792]);
            if (paperCover) cover.drawRectangle({ x: 0, y: 0, width: 612, height: 792,
              color: pdf.rgb(...paperCover.rgb) });
            const ink = paperCover?.dark ? pdf.rgb(1, 1, 1) : pdf.rgb(.18, .18, .18);
            if (federal) coverBottom = drawFederalForm66Cover(pdf, cover, regular, bold, input.cover,
              input.court, documentTitle, coverLine, ink);
            else if (input.alberta) coverBottom = drawAlbertaCover(pdf, cover, regular, bold, input.cover,
              input.court, documentTitle);
            else {
              cover.drawRectangle({ x: 0, y: 0, width: 18, height: 792, color: ink });
              cover.drawLine({ start: { x: margin, y: 626 }, end: { x: 612 - margin, y: 626 },
                thickness: 2, color: ink });
              // The title wraps rather than losing its end; the subtitle follows its last line.
              const title = wrapped(bold, documentTitle, 28, contentWidth).slice(0, 4);
              coverField(pdf, cover, "Title", title.join("\n"),
                [margin - 4, 492 - (title.length - 1) * 34, contentWidth + 8, (title.length - 1) * 34 + 36], bold, 28, "left", ink);
              if (subtitle && bookTitle !== subtitle) cover.drawText(fit(serif, subtitle, 13, contentWidth),
                { x: margin, y: 462 - (title.length - 1) * 34, size: 13, font: serif, color: ink });
              coverBottom = 432 - (title.length - 1) * 34;
            }
          }
          if (multi && limits?.coverLabels) document.getPage(0).drawText(volumeLabel,
            { x: margin, y: Math.min(400, coverBottom), size: 12, font: bold });
          if (customIndex) await engine.appendPages(document, customIndex);
          indexPages.forEach((chunk, chunkIndex) => {
            const page = document.addPage([612, 792]);
            const heading = chunkIndex ? `${indexTitle} — continued` : indexTitle;
            if (federal) page.drawText(heading, { x: margin, y: 708, size: 12, font: bold });
            else page.drawText(heading.toUpperCase(), { x: (612 - serifBold.widthOfTextAtSize(heading.toUpperCase(), 13)) / 2,
              y: 724, size: 13, font: serifBold });
            let y = top;
            for (const token of chunk) {
              if (!token.entry) {
                if (federal) {
                  page.drawRectangle({ x: margin, y: y - 8, width: contentWidth, height: 22, color: pdf.rgb(.92, .92, .92) });
                  page.drawText(token.label.toUpperCase(), { x: margin + 8, y, size: 12, font: bold });
                  y -= 27;
                } else {
                  y -= 8;
                  page.drawText(token.label.toUpperCase(), { x: margin, y, size: bodySize, font: serifBold });
                  y -= 22;
                }
                continue;
              }
              const tabTarget = tabStarts.get(token.entry.key);
              const pageLabel = ranges.get(token.entry.key)?.join(", ") ?? "—";
              const last = y - (token.lines.length - 1) * leading;
              token.lines.forEach((line, index) => drawRuns(page, line, { x: titleX, y: y - index * leading,
                size: bodySize, roman: serif, italic: serifItalic }));
              if (federal) {
                // Only the Federal Court's index links each authority to its public source.
                const sourceUrl = token.entry.sourceUrl;
                page.drawText(pdfText(token.entry.tab), { x: margin + 6, y, size: 12, font: bold });
                if (sourceUrl) page.drawText("source", { x: sourceX, y, size: 12, font: regular });
                if (showPages) page.drawText(pageLabel, { x: pageRight - bold.widthOfTextAtSize(pageLabel, 12),
                  y, size: 12, font: bold });
                page.drawLine({ start: { x: titleX, y: last - 7 }, end: { x: pageRight, y: last - 7 },
                  thickness: .45, color: pdf.rgb(.82, .82, .82) });
                if (tabTarget !== undefined) links.push({ page, targetPageIndex: tabTarget,
                  rect: [margin, last - 10, sourceUrl ? sourceX - 5 : pageRight, y + 10] });
                if (sourceUrl) links.push({ page, url: sourceUrl, rect: [sourceX - 5, y - 10, 492, y + 10] });
                y -= token.height;
                continue;
              }
              // The citation, a dot leader, then the tab (and the pages) on its last line.
              // An authority in another volume is found there.
              const elsewhere = multi && volumeOf.get(token.entry.key) !== volumeIndex
                ? ` (Vol. ${(volumeOf.get(token.entry.key) ?? 0) + 1})` : "";
              const tab = pdfText(`${token.entry.tab}${elsewhere}`), tabWidth = serifBold.widthOfTextAtSize(tab, bodySize);
              page.drawText(tab, { x: pageRight - tabWidth, y: last, size: bodySize, font: serifBold });
              let leaderEnd = pageRight - tabWidth - 8;
              if (showPages) {
                const width = serif.widthOfTextAtSize(pageLabel, bodySize), right = pageRight - tabColumn;
                page.drawText(pageLabel, { x: right - width, y: last, size: bodySize, font: serif });
                leaderEnd = right - width - 8;
              }
              const lastLine = token.lines[token.lines.length - 1] ?? [];
              const leaderStart = titleX + lastLine.reduce((sum, run) =>
                sum + (run.italic ? serifItalic : serif).widthOfTextAtSize(run.text, bodySize), 0) + 6;
              const dot = serif.widthOfTextAtSize(" .", bodySize);
              const dots = Math.floor((leaderEnd - leaderStart) / dot);
              if (dots > 1) page.drawText(" .".repeat(dots), { x: leaderEnd - dots * dot, y: last,
                size: bodySize, font: serif });
              if (tabTarget !== undefined) links.push({ page, targetPageIndex: tabTarget,
                rect: [margin - 2, last - 4, pageRight + 2, y + bodySize] });
              y -= token.height;
            }
            if (!(federal && electronic)) {
              engine.drawPageNumber(page, plan.globalStart + coverPageCount + customIndexPages + chunkIndex + 1,
                regular, "bottom-centre", federal ? 12 : 9, 72, federal ? 75 : 36);
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
          engine.describeDocument(document, documentTitle, "Navigable book of legal authorities", "Beaver · pdf-lib");
          document.catalog.set(pdf.PDFName.of("Lang"), pdf.PDFHexString.fromText("en-CA"));
          // Where the index gives tabs, a PDF viewer's page box gives them too: "Tab 3-2" is the second
          // page of the authority at Tab 3. Where it gives book pages, the box gives those.
          if (!federal && !showPages) {
            const label = (prefix: string, start?: number) => document.context.obj({
              P: pdf.PDFString.of(pdfText(prefix)), ...(start ? { S: pdf.PDFName.of("D"), St: start } : {}) });
            const nums: unknown[] = [0, label("Cover")];
            if (indexPages.length || customIndex) nums.push(coverPageCount, label("Index ", 1));
            for (const { source, localStart, tabStart, tabbed, blankBefore, blankAfter, pageIndices } of plan.slices) {
              const tab = pdfNormalized(source.tab);
              if (blankBefore) nums.push(tabStart - 1, label(`${tab} blank`));
              if (tabbed) nums.push(tabStart, label(tab));
              if (blankAfter) nums.push(tabStart + 1, label(`${tab} blank`));
              nums.push(localStart, label(`${tab}-`, source.pageIndices.indexOf(pageIndices[0]) + 1));
            }
            if (backPageCount) nums.push(document.getPageCount() - 1, label("Back cover"));
            document.catalog.set(pdf.PDFName.of("PageLabels"), document.context.register(
              document.context.obj({ Nums: nums as never })));
          }
          dropUnreachable(pdf, document);
        },
        links, openBookmarks: true, pageLabels: !federal && !showPages ? undefined : plan.globalStart + 1,
        pageNumbers: federal && electronic ? { font: "regular", start: plan.globalStart + 1,
          position: "bottom-right", size: 12, inset: 99.21, offset: 54 } : undefined,
        outlines: () => [
          { title: documentTitle, pageIndex: 0,
            ...(coverOutline.length ? { children: coverOutline } : {}) },
          ...!indexPages.length && !customIndex ? [] : [{ title: indexTitle, pageIndex: indexStart,
            ...(indexOutline.length ? { children: mapOutline(indexOutline, pageIndex => coverPageCount + pageIndex) } : {}) }],
          ...groups.flatMap(({ label, entries }): PdfOutline[] => {
            const tabs = entries.filter(({ key }) => tabStarts.has(key)).map((entry): PdfOutline => {
              const slice = plan.slices.find(({ source }) => source.key === entry.key)!;
              const start = localStarts.get(entry.key)!, page = (pageIndex: number) => {
                const offset = slice.pageIndices.indexOf(pageIndex);
                return offset < 0 ? undefined : start + offset;
              };
              return { title: `${entry.tab} – ${entry.name}`, pageIndex: tabStarts.get(entry.key)!,
                children: [...mapOutline(slice.source.outline ?? [], page),
                  ...mapOutline(slice.source.bookmarks, page)] };
            });
            return !tabs.length ? [] : grouped ? [{ title: label, pageIndex: tabs[0].pageIndex as number, children: tabs }] : tabs;
          }),
        ],
        saveOptions: { useObjectStreams: true },
      };
    });
  }, limits, (volume, output) => {
    const count = volume.reduce((sum, item) => sum + item.pageIndices.length, 0);
    if (count < 2) throw new Error("One PDF page exceeds the court's electronic filing size limit.");
    // As many volumes as its size asks for, a little room left in each, each authority weighed by
    // its own PDF's bytes.
    const perPage = (item: typeof volume[number]) => item.source.bytes.byteLength / Math.max(1, item.source.pageIndices.length);
    const weight = volume.reduce((sum, item) => sum + item.pageIndices.length * perPage(item), 0);
    const parts = Math.max(2, Math.ceil(output.bytes.byteLength * 1.1 / (limits?.maxBytes || Infinity)));
    // Filled to nine tenths of the limit where the court gives one in bytes.
    return splitAtTabs(volume, limits?.maxBytes ? Math.min(weight / 2, limits.maxBytes * .9) : weight / parts, 0, perPage);
  });
  return built.map((output, index) => ({ ...output, placements: placements[index], role: index ? `book-${index + 1}` : "book",
    mimeType: "application/pdf", filename: volumes.length > 1 ? input.filename.replace(/\.pdf$/iu,
      `.volume-${index + 1}-of-${volumes.length}.pdf`) : input.filename }));
}

/** Leaves out of the file what nothing in it refers to: the pages, fonts and images a source's
 *  links to pages the book does not keep carried in when its pages were copied. */
export function dropUnreachable(pdf: PdfModule, document: import("pdf-lib").PDFDocument) {
  const { context } = document, reached = new Set<string>();
  const queue: unknown[] = [context.trailerInfo.Root, context.trailerInfo.Info, context.trailerInfo.Encrypt];
  while (queue.length) {
    const item = queue.pop();
    if (item instanceof pdf.PDFRef) {
      if (reached.has(item.toString())) continue;
      reached.add(item.toString()); queue.push(context.lookup(item));
    } else if (item instanceof pdf.PDFDict) queue.push(...item.values());
    else if (item instanceof pdf.PDFArray) queue.push(...item.asArray());
    else if (item instanceof pdf.PDFStream) queue.push(item.dict);
  }
  for (const [ref] of context.enumerateIndirectObjects()) if (!reached.has(ref.toString())) context.delete(ref);
}

/** Volumes of whole authorities, in order, each as many as fit in `size` pages (each taking `added`
 *  pages more than its own); only an authority longer than a volume is divided between volumes. */
function splitAtTabs<T extends { pageIndices: number[] }>(items: T[], size: number, added = 0,
  /** What one of an item's pages weighs against `size`: a page, or its share of its PDF's bytes. */
  perPage: (item: T) => number = () => 1) {
  const volumes: T[][] = [[]];
  let used = 0;
  for (const item of items) {
    const each = perPage(item), weight = (item.pageIndices.length + added) * each;
    if (used && used + weight > size) { volumes.push([]); used = 0; }
    if (weight <= size) { volumes[volumes.length - 1].push(item); used += weight; continue; }
    const parts = splitPdfPageRanges([item], Math.max(1, Math.floor(size / each) - added));
    parts.forEach((part, index) => {
      if (index) volumes.push([]);
      volumes[volumes.length - 1].push(...part);
    });
    used = parts[parts.length - 1].reduce((sum, part) => sum + part.pageIndices.length, 0) * each;
  }
  return volumes;
}

export function fit(font: PdfFont, value: string, size: number, width: number) {
  value = pdfText(value).replace(/\s+/gu, " ").trim();
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  let text = value;
  while (text && font.widthOfTextAtSize(`${text}…`, size) > width) text = text.slice(0, -1);
  return `${text}…`;
}

export const pdfNormalized = (value: string) => value.normalize("NFKC")
  .replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"')
  .replace(/[\u2010-\u2015\u2212]/gu, "-").replace(/\u2026/gu, "...");

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

type Measure = Pick<PdfFont, "widthOfTextAtSize">;
/** A citation's lines within `width`: runs of text, its first `italic` characters (the style of cause
 *  or title) in the italic font. Lines break between words; a word wider than a line is split. */
export function citationLines(fonts: { roman: Measure; italic: Measure }, value: string, italic: number,
  size: number, width: number) {
  type Run = { text: string; italic: boolean };
  const words: Run[][] = [[]];
  [value.slice(0, italic), value.slice(italic)].forEach((part, index) =>
    pdfText(part).split(/(\s+)/u).forEach((piece, at) => {
      if (at % 2) words.push([]);
      else if (piece) words[words.length - 1].push({ text: piece, italic: !index });
    }));
  const measure = ({ text, italic }: Run) => (italic ? fonts.italic : fonts.roman).widthOfTextAtSize(text, size);
  const lines: Run[][] = [[]];
  let used = 0;
  const put = (run: Run) => {
    const line = lines[lines.length - 1], last = line[line.length - 1];
    if (last?.italic === run.italic) last.text += run.text; else line.push({ ...run });
    used += measure(run);
  };
  for (const word of words.filter((runs) => runs.length)) {
    // A space between two italic words is italic too.
    const line = lines[lines.length - 1], space = { text: " ", italic: !!line[line.length - 1]?.italic && word[0].italic };
    const wide = word.reduce((sum, run) => sum + measure(run), 0);
    if (used && used + measure(space) + wide > width) { lines.push([]); used = 0; }
    if (used) put(space);
    for (const run of word) for (const character of wide > width ? run.text : [run.text]) {
      const piece = { text: character, italic: run.italic };
      if (used && used + measure(piece) > width) { lines.push([]); used = 0; }
      put(piece);
    }
  }
  return lines;
}

/** Draws one line of runs from `x`. */
export function drawRuns(page: PdfPage, runs: ReturnType<typeof citationLines>[number],
  options: { x: number; y: number; size: number; roman: PdfFont; italic: PdfFont; color?: PdfColor }) {
  let x = options.x;
  for (const { text, italic } of runs) {
    const font = italic ? options.italic : options.roman;
    page.drawText(text, { x, y: options.y, size: options.size, font, color: options.color });
    x += font.widthOfTextAtSize(text, options.size);
  }
}

function drawFederalForm66Cover(pdf: PdfModule, page: PdfPage, regular: PdfFont, bold: PdfFont,
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
  // The file number, the parties and the title are fields Acrobat fills in, each where it stands.
  const file = clean(cover.courtFileNumber), fileWidth = Math.max(90, regular.widthOfTextAtSize(file, 12) + 6);
  const label = "Court File No.";
  page.drawText(label, { x: width - margin - fileWidth - regular.widthOfTextAtSize(label, 12) - 2,
    y: height - 78, size: 12, font: regular, color });
  coverField(pdf, page, "Court file number", file, [width - margin - fileWidth, height - 82, fileWidth, 16], regular, 12, "left", color);
  centred(court, height - 118, bold);
  page.drawText("BETWEEN:", { x: margin, y: height - 157, size: 12, font: regular, color });
  let y = height - 193;
  cover.partyGroups.forEach(({ role, parties }, index) => {
    const names = wrapped(regular, clean(parties.join(", ")), 12, width - (2 * margin));
    coverField(pdf, page, `Parties ${index + 1}`, names.join("\n"),
      [margin - 4, y - 14 * (names.length - 1) - 5, width - 2 * margin + 8, 14 * names.length + 4], regular, 12, "center", color);
    y -= 14 * names.length;
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
  const titleLines = wrapped(bold, clean(title.toUpperCase()), 12, width - (2 * margin));
  coverField(pdf, page, "Title", titleLines.join("\n"),
    [margin - 4, y - 16 * (titleLines.length - 1) - 5, width - 2 * margin + 8, 16 * titleLines.length + 4], bold, 12, "center", color);
  y -= 16 * titleLines.length;
  if (filedBy) { y -= 10; centred(filedBy, y); y -= 16; }
  if (y < 135) throw new Error(
    "The Federal style of cause is too long for one Form 66 cover page.");
  return y - 10;
}

/** A cover's value as a form field Acrobat fills in, in the cover's own font where the value stands:
 *  `rect` is [x, y, width, height]; text on more than one line wraps. */
function coverField(pdf: PdfModule, page: PdfPage, name: string, value: string, rect: number[], font: PdfFont,
  size: number, align: "left" | "center", color: PdfColor) {
  const form = page.doc.getForm(), field = form.createTextField(name);
  field.setText(value);
  if (rect[3] > size * 1.6) field.enableMultiline();
  field.setAlignment(align === "center" ? pdf.TextAlignment.Center : pdf.TextAlignment.Left);
  field.addToPage(page, { x: rect[0], y: rect[1], width: rect[2], height: rect[3], font, textColor: color,
    backgroundColor: undefined, borderColor: undefined, borderWidth: 0 });
  field.setFontSize(size); field.updateAppearances(font);
  form.markFieldAsClean(field.ref);
  // The font its appearance names, where Acrobat finds it to redraw the value once edited.
  const { PDFName, PDFDict } = pdf, context = page.doc.context, acroForm = form.acroForm.dict;
  const resources = acroForm.lookupMaybe(PDFName.of("DR"), PDFDict) ?? context.obj({});
  const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict) ?? context.obj({});
  fonts.set(PDFName.of(font.name), font.ref); resources.set(PDFName.of("Font"), fonts);
  acroForm.set(PDFName.of("DR"), resources);
}

/** The page that opens an authority: its tab, large and alone. */
function drawTabPage(page: PdfPage, tab: string, font: PdfFont) {
  const text = pdfText(tab).toUpperCase(), size = Math.min(54, 468 / Math.max(1, font.widthOfTextAtSize(text, 1)));
  page.drawText(text, { x: (612 - font.widthOfTextAtSize(text, size)) / 2, y: 396 - size / 3, size, font });
}

/** The Alberta Rules of Court's cover (r 13.19): the court file number, court, judicial centre and
 *  parties, the document's title and the filing party's address for service, each beside its label,
 *  with the clerk's stamp box at the top right. Its values are plain text in a standard font, which
 *  a PDF editor retypes: the King's Bench Filing Digital Service refuses a PDF with form fields. */
function drawAlbertaCover(pdf: PdfModule, page: PdfPage, regular: PdfFont, bold: PdfFont,
  cover: AuthoritiesCover, court: string, title: string) {
  const left = 72, valueX = 214, right = 540, size = 10, leading = 13;
  const stamp = { x: 396, top: 740, bottom: 596 };
  page.drawRectangle({ x: stamp.x, y: stamp.bottom, width: right - stamp.x, height: stamp.top - stamp.bottom,
    borderColor: pdf.rgb(0, 0, 0), borderWidth: .75 });
  const stampLabel = "Clerk's Stamp";
  page.drawText(stampLabel, { x: stamp.x + (right - stamp.x - regular.widthOfTextAtSize(stampLabel, 8)) / 2,
    y: stamp.top - 12, size: 8, font: regular });
  const contact = cover.contact;
  const rows: Array<readonly [label: string, value: string, font?: PdfFont]> = [
    ["COURT FILE NUMBER", cover.courtFileNumber],
    ["COURT", court],
    ["JUDICIAL CENTRE", (cover.judicialCentre ?? "").toUpperCase()],
    ...cover.applicationUnder ? [["MATTER", cover.applicationUnder] as const] : [],
    ...cover.partyGroups.map(({ role, parties }) => [role.toUpperCase(), parties.join("\n")] as const),
    ["DOCUMENT", title.toUpperCase(), bold],
    ["ADDRESS FOR SERVICE AND CONTACT INFORMATION OF PARTY FILING THIS DOCUMENT",
      contact ? [contact.name, contact.address, contact.phone && `Telephone: ${contact.phone}`,
        contact.fax && `Fax: ${contact.fax}`, contact.email && `Email: ${contact.email}`]
        .filter(Boolean).join("\n") : ""],
  ];
  let y = 724;
  for (const [label, value, font = regular] of rows) {
    // A value beside the stamp box stops short of it.
    const width = (y > stamp.bottom ? stamp.x - 12 : right) - valueX;
    const labels = wrapped(bold, label, 8, valueX - left - 14), values = wrapped(font, value, size, width);
    labels.forEach((line, index) => page.drawText(line, { x: left, y: y - index * 10, size: 8, font: bold }));
    values.forEach((line, index) => page.drawText(line, { x: valueX, y: y - index * leading, size, font }));
    y -= Math.max(labels.length * 10, values.length * leading) + 16;
  }
  return y;
}
