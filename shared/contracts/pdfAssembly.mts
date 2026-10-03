import type { PDFDict, PDFDocument, PDFFont, PDFObject, PDFPage, PDFRef, SaveOptions, StandardFonts } from "pdf-lib";

type PdfOutlineDictionary = { dictionary: Array<[string, PdfOutlineValue]> };
export type PdfOutlineValue = number | boolean | null | { name: string } | { literal: string } |
  { hex: string } | { array: PdfOutlineValue[] } | PdfOutlineDictionary;
export type PdfOutline = { title: string; children?: PdfOutline[] } & (
  { pageIndex: number; view?: PdfOutlineValue[]; action?: never } |
  { pageIndex?: never; view?: never; action: PdfOutlineDictionary });
export type PdfPageNumberPosition = "top-right" | "top-centre" | "bottom-right" | "bottom-centre";
export type PdfIndexTarget = { page: PDFPage; rect: number[]; targetPageIndex: number };
export type PdfAssemblyContext<Font extends string> = {
  document: PDFDocument; fonts: Record<Font, PDFFont>; starts: Map<string, number>;
};
export type PdfAssemblyPart<Font extends string> = {
  id: string; source?: Uint8Array | PDFDocument; pageIndices?: number[];
  ocrTextByPage?: string[]; ocrFont?: Font;
  draw?: (context: PdfAssemblyContext<Font>) => void | Promise<void>;
  decorate?: (page: PDFPage, sourceIndex: number, context: PdfAssemblyContext<Font>) => void;
};
export type PdfAssemblyInput<Font extends string> = {
  document?: PDFDocument;
  fonts: Record<Font, StandardFonts | Uint8Array>;
  fontkit?: Parameters<PDFDocument["registerFontkit"]>[0];
  parts: PdfAssemblyPart<Font>[];
  before?: (context: PdfAssemblyContext<Font>) => void | Promise<void>;
  after?: (context: PdfAssemblyContext<Font>) => void | Promise<void>;
  links?: Array<PdfIndexTarget | { page: PDFPage; rect: number[]; url: string }>;
  outlines?: (context: PdfAssemblyContext<Font>) => PdfOutline[];
  openBookmarks?: boolean; pageLabels?: number;
  pageNumbers?: { font: Font; start: number; position: PdfPageNumberPosition;
    size?: number; inset?: number; offset?: number };
  saveOptions?: SaveOptions; signal?: AbortSignal;
};
export type PdfAssemblyResult = { bytes: Uint8Array; pageCount: number };
export type PdfVolumeLimits = { maxPages?: number; maxBytes?: number };

export function splitPdfPageRanges<T extends { pageIndices: number[] }>(items: T[], size: number) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("A PDF volume must have room for a source page.");
  const volumes: T[][] = [];
  let used = size;
  for (const item of items) for (let index = 0; index < item.pageIndices.length;) {
    if (used === size) { volumes.push([]); used = 0; }
    const pageIndices = item.pageIndices.slice(index, index + size - used);
    volumes[volumes.length - 1].push({ ...item, pageIndices });
    used += pageIndices.length; index += pageIndices.length;
  }
  return volumes;
}

/** Nests a flat outline by level: each entry goes under the last shallower one. */
export function nestedOutline(entries: Array<{ title: string; level: number; pageIndex?: number }>) {
  const roots: PdfOutline[] = [], open: Array<{ level: number; node: PdfOutline }> = [];
  for (const { title, level, pageIndex } of entries) {
    if (pageIndex === undefined) continue;
    const node: PdfOutline = { title, pageIndex };
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const parent = open[open.length - 1]?.node;
    if (parent) (parent.children ??= []).push(node); else roots.push(node);
    open.push({ level, node });
  }
  return roots;
}

/** A source's outline: its publisher's bookmarks, with the headings read from its text where
 *  those bookmarks are only a frame (a judgment bookmarked by its parties and its reasons).
 *  Each heading the bookmarks do not name goes under the last bookmark that opens at or before
 *  its page. A lone bookmark ("Blank Page" on some printers' statutes) is no outline. */
export function sourceOutline(own: PdfOutline[], read: PdfOutline[]): PdfOutline[] {
  const flat = (items: PdfOutline[]): PdfOutline[] => items.flatMap(item => [item, ...flat(item.children ?? [])]);
  if (flat(own).filter(item => item.action === undefined).length < 2) {
    const external = (items: PdfOutline[]): PdfOutline[] => items.flatMap(item =>
      item.action !== undefined ? [item] : external(item.children ?? []));
    return [...external(own), ...read];
  }
  const key = (title: string) => title.toLowerCase().replace(/^\s*(?:[\p{N}.()]+|[ivxlcdm]+\.|\p{L}\.)\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const copy = (items: PdfOutline[]): PdfOutline[] => items.map(({ children, ...item }) =>
    ({ ...item, ...(children?.length ? { children: copy(children) } : {}) }));
  const frame = copy(own), local = flat(frame).filter(item => item.action === undefined);
  const named = new Set(local.map(({ title }) => key(title)));
  // A named heading gives way to its children.
  const unnamed = (items: PdfOutline[]): PdfOutline[] => items.flatMap(({ children, ...item }) => {
    const kept = unnamed(children ?? []);
    return named.has(key(item.title)) ? kept : [{ ...item, ...(kept.length ? { children: kept } : {}) }];
  });
  const headings = unnamed(read);
  if (flat(headings).length <= local.length) return own;
  const roots = [...frame], order = flat(frame);
  for (const heading of headings) {
    const at = heading.pageIndex;
    const parent = at === undefined ? undefined : order.filter(({ pageIndex }) =>
      pageIndex !== undefined && pageIndex <= at).at(-1);
    if (parent) (parent.children ??= []).push(heading); else roots.push(heading);
  }
  const byPage = (items: PdfOutline[]): PdfOutline[] => items.map(item => item.children
    ? { ...item, children: byPage(item.children) } : item).sort((left, right) =>
      left.pageIndex === undefined || right.pageIndex === undefined ? 0 : left.pageIndex - right.pageIndex);
  return byPage(roots);
}

/** An outline moved onto other pages: an entry whose page is gone gives way to its children. */
export function mapOutline(outline: PdfOutline[], page: (pageIndex: number) => number | undefined): PdfOutline[] {
  return outline.flatMap<PdfOutline>(({ children, ...entry }) => {
    const mapped = children ? mapOutline(children, page) : [];
    if (entry.action !== undefined) return [{ ...entry, ...(mapped.length ? { children: mapped } : {}) }];
    const at = page(entry.pageIndex);
    return at === undefined ? mapped : [{ ...entry, pageIndex: at, ...(mapped.length ? { children: mapped } : {}) }];
  });
}

export function pdfAssembly(pdf: typeof import("pdf-lib")) {
  const { PDFHexString, PDFName, degrees, rgb } = pdf;

  /** Plain PDF values survive both document contexts and the book worker's structured clone. */
  function readOutlineValue(document: PDFDocument, value: PDFObject | undefined,
    ancestors = new Set<PDFObject>()): PdfOutlineValue | undefined {
    const object = document.context.lookup(value);
    if (object === pdf.PDFNull) return null;
    if (object instanceof pdf.PDFNumber) return object.asNumber();
    if (object instanceof pdf.PDFBool) return object.asBoolean();
    if (object instanceof PDFName) return { name: object.decodeText() };
    if (object instanceof pdf.PDFString) return { literal: object.asString() };
    if (object instanceof PDFHexString) return { hex: object.asString() };
    if (!object || ancestors.has(object) || ancestors.size >= 64) return undefined;
    const next = new Set(ancestors).add(object);
    if (object instanceof pdf.PDFArray) {
      const array = object.asArray().map(item => readOutlineValue(document, item, next));
      return array.some(item => item === undefined) ? undefined : { array: array as PdfOutlineValue[] };
    }
    if (object instanceof pdf.PDFDict) {
      const dictionary: Array<[string, PdfOutlineValue]> = [];
      for (const [key, item] of object.entries()) {
        const copied = readOutlineValue(document, item, next);
        if (copied === undefined) return undefined;
        dictionary.push([key.decodeText(), copied]);
      }
      return { dictionary };
    }
    return undefined;
  }

  function writeOutlineValue(document: PDFDocument, value: PdfOutlineValue): PDFObject {
    if (value === null) return pdf.PDFNull;
    if (typeof value === "number") return pdf.PDFNumber.of(value);
    if (typeof value === "boolean") return value ? pdf.PDFBool.True : pdf.PDFBool.False;
    if ("name" in value) return PDFName.of(value.name);
    if ("literal" in value) return pdf.PDFString.of(value.literal);
    if ("hex" in value) return PDFHexString.of(value.hex);
    if ("array" in value) return document.context.obj(value.array.map(item => writeOutlineValue(document, item)));
    const dictionary = document.context.obj({});
    value.dictionary.forEach(([key, item]) => dictionary.set(PDFName.of(key), writeOutlineValue(document, item)));
    return dictionary;
  }

  /** Resolve local destinations, including the two PDF named-destination forms. */
  function destinationReader(document: PDFDocument) {
    const names = new Map<string, PDFObject>(), legacyNames = new Map<string, PDFObject>();
    const legacy = document.catalog.lookup(PDFName.of("Dests"));
    if (legacy instanceof pdf.PDFDict) legacy.entries().forEach(([key, value]) =>
      legacyNames.set(key.decodeText(), value));
    const visited = new Set<PDFDict>();
    const readNames = (value: PDFObject | undefined) => {
      const node = document.context.lookup(value);
      if (!(node instanceof pdf.PDFDict) || visited.has(node) || visited.size >= 10_000) return;
      visited.add(node);
      const entries = node.lookup(PDFName.of("Names")), children = node.lookup(PDFName.of("Kids"));
      if (entries instanceof pdf.PDFArray) for (let index = 0; index + 1 < entries.size(); index += 2) {
        const key = entries.lookup(index);
        if (key instanceof pdf.PDFString || key instanceof PDFHexString)
          names.set(key.decodeText(), entries.get(index + 1));
      }
      if (children instanceof pdf.PDFArray) children.asArray().forEach(readNames);
    };
    const dictionary = document.catalog.lookup(PDFName.of("Names"));
    if (dictionary instanceof pdf.PDFDict) readNames(dictionary.get(PDFName.of("Dests")));
    return (node: PDFDict) => {
      const action = node.lookup(PDFName.of("A"));
      let value = node.get(PDFName.of("Dest")) ?? (action instanceof pdf.PDFDict &&
        String(action.lookup(PDFName.of("S"))) === "/GoTo" ? action.get(PDFName.of("D")) : undefined);
      const seen = new Set<PDFObject>();
      while (value && !seen.has(value)) {
        seen.add(value);
        const destination = document.context.lookup(value);
        if (destination instanceof pdf.PDFArray) return destination;
        if (destination instanceof pdf.PDFDict) value = destination.get(PDFName.of("D"));
        else if (destination instanceof PDFName) value = legacyNames.get(destination.decodeText()) ?? names.get(destination.decodeText());
        else if (destination instanceof pdf.PDFString || destination instanceof PDFHexString)
          value = names.get(destination.decodeText()) ?? legacyNames.get(destination.decodeText());
        else return undefined;
      }
      return undefined;
    };
  }
  /** Draws a page number, or a running line such as a statute's currency, as page furniture. */
  function drawPageNumber(page: PDFPage, number: number | string, font: PDFFont,
    position: PdfPageNumberPosition, size = 9, inset = 72, offset = 36) {
    const text = String(number), textWidth = font.widthOfTextAtSize(text, size);
    const crop = page.getCropBox(), angle = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = angle === 90 || angle === 270;
    const width = sideways ? crop.height : crop.width;
    const height = sideways ? crop.width : crop.height;
    const x = position.endsWith("right") ? width - inset - textWidth : (width - textWidth) / 2;
    const y = position.startsWith("top") ? height - offset : offset;
    const [pageX, pageY] = angle === 90 ? [crop.width - y, x]
      : angle === 180 ? [crop.width - x, crop.height - y]
        : angle === 270 ? [y, crop.height - x] : [x, y];
    paginationArtifact(page, position.startsWith("top") ? "Header" : "Footer", () =>
      page.drawText(text, { x: crop.x + pageX, y: crop.y + pageY, size, font,
        rotate: degrees(angle), color: rgb(.12, .12, .12) }));
  }

  /** Draws a page number or running header as a pagination artifact, the marked content a PDF
   *  editor's header and footer tools and a screen reader take for page furniture, not text. */
  function paginationArtifact(page: PDFPage, kind: "Header" | "Footer", draw: () => void) {
    page.pushOperators(pdf.PDFOperator.of(pdf.PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of("Artifact"),
      page.doc.context.obj({ Type: "Pagination", Subtype: kind, Attached: [kind === "Header" ? "Top" : "Bottom"] }) as unknown as string]));
    draw();
    page.pushOperators(pdf.endMarkedContent());
  }

  /** A scan's recognized text as an invisible text layer (render mode 3): found by search and
   *  selection, never drawn over the page. */
  function applyOcrText(page: PDFPage, font: PDFFont, value?: string) {
    if (!value?.trim()) return;
    const lines = value.normalize("NFC").replace(/\t/gu, " ").slice(0, 60_000).split(/\r?\n/u)
      .filter((line) => line.trim());
    page.pushOperators(pdf.pushGraphicsState(), pdf.beginText(),
      pdf.setFontAndSize(page.node.newFontDictionary(font.name, font.ref), 1),
      pdf.setTextRenderingMode(pdf.TextRenderingMode.Invisible), pdf.setLineHeight(1), pdf.moveText(1, 1),
      ...lines.flatMap((line) => [pdf.showText(font.encodeText(line)), pdf.nextLine()]),
      pdf.endText(), pdf.popGraphicsState());
  }

  /** The PDF's own bookmarks, as titled, with the pages they open (shifted by `offset`). */
  function readOutlines(document: PDFDocument, offset = 0): PdfOutline[] {
    const pages = new Map(document.getPages().map((page, index) => [String(page.ref), index]));
    const destination = destinationReader(document);
    const seen = new Set<PDFDict>();
    const branch = (first: PDFDict | undefined): PdfOutline[] => {
      const result: PdfOutline[] = [];
      for (let node = first; node && !seen.has(node) && seen.size < 10_000;
        node = node.lookupMaybe(PDFName.of("Next"), pdf.PDFDict)) {
        seen.add(node);
        const title = node.lookupMaybe(PDFName.of("Title"), pdf.PDFString, pdf.PDFHexString);
        const dest = destination(node);
        const pageIndex = dest && pages.get(String(dest.get(0)));
        const children = branch(node.lookupMaybe(PDFName.of("First"), pdf.PDFDict));
        if (title && pageIndex !== undefined) {
          const view = dest!.asArray().slice(1).map(item => readOutlineValue(document, item));
          const fit = view.length === 1 && view[0] !== null && typeof view[0] === "object" &&
            "name" in view[0] && view[0].name === "Fit";
          result.push({ title: title.decodeText(), pageIndex: offset + pageIndex,
            ...(!fit && view.every(item => item !== undefined) ? { view: view as PdfOutlineValue[] } : {}),
            ...(children.length ? { children } : {}) });
        } else {
          const action = node.lookup(PDFName.of("A"));
          const copied = action instanceof pdf.PDFDict && String(action.lookup(PDFName.of("S"))) !== "/GoTo"
            ? readOutlineValue(document, action) : undefined;
          if (title && copied && typeof copied === "object" && "dictionary" in copied)
            result.push({ title: title.decodeText(), action: copied, ...(children.length ? { children } : {}) });
          else result.push(...children);
        }
      }
      return result;
    };
    return branch(document.catalog.lookupMaybe(PDFName.of("Outlines"), pdf.PDFDict)
      ?.lookupMaybe(PDFName.of("First"), pdf.PDFDict));
  }

  function applyPageLabels(document: PDFDocument, start: number) {
    document.catalog.set(PDFName.of("PageLabels"), document.context.register(
      document.context.obj({ Nums: [0, document.context.obj({ S: "D", St: start })] }),
    ));
  }

  type PageLabel = { style?: string; prefix?: string; start: number };

  /** Retain label rules, rather than formatting their Roman or alphabetic values ourselves. */
  function pageLabelReader(document: PDFDocument) {
    const rules = new Map<number, PageLabel>(), seen = new Set<PDFDict>();
    const read = (value: PDFObject | undefined) => {
      const node = document.context.lookup(value);
      if (!(node instanceof pdf.PDFDict) || seen.has(node) || seen.size >= 10_000) return;
      seen.add(node);
      const entries = node.lookup(PDFName.of("Nums")), children = node.lookup(PDFName.of("Kids"));
      if (entries instanceof pdf.PDFArray) for (let index = 0; index + 1 < entries.size(); index += 2) {
        const at = entries.lookup(index), label = entries.lookup(index + 1);
        if (!(at instanceof pdf.PDFNumber) || !(label instanceof pdf.PDFDict) ||
            !Number.isSafeInteger(at.asNumber()) || at.asNumber() < 0) continue;
        const style = label.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();
        const prefix = label.lookupMaybe(PDFName.of("P"), pdf.PDFString, PDFHexString)?.decodeText();
        const start = label.lookupMaybe(PDFName.of("St"), pdf.PDFNumber)?.asNumber() ?? 1;
        rules.set(at.asNumber(), { style, prefix, start });
      }
      if (children instanceof pdf.PDFArray) children.asArray().forEach(read);
    };
    read(document.catalog.get(PDFName.of("PageLabels")));
    const ordered = [...rules].sort(([left], [right]) => left - right);
    return (pageIndex: number): PageLabel => {
      let low = 0, high = ordered.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ordered[middle][0] <= pageIndex) low = middle + 1; else high = middle;
      }
      if (!low) return { style: "D", start: pageIndex + 1 };
      const [first, label] = ordered[low - 1];
      return { ...label, start: label.start + pageIndex - first };
    };
  }

  function writePageLabels(document: PDFDocument, labels: PageLabel[]) {
    const entries: Array<number | PDFDict> = [];
    let previous: PageLabel | undefined;
    labels.forEach((label, index) => {
      if (!previous || label.style !== previous.style || label.prefix !== previous.prefix ||
          label.style !== undefined && label.start !== previous.start + 1) {
        entries.push(index, document.context.obj({
          ...(label.style === undefined ? {} : { S: label.style, St: label.start }),
          ...(label.prefix === undefined ? {} : { P: PDFHexString.fromText(label.prefix) }),
        }));
      }
      previous = label;
    });
    document.catalog.set(PDFName.of("PageLabels"), document.context.register(
      document.context.obj({ Nums: entries })));
  }

  function applyOutlines(document: PDFDocument, outlines: PdfOutline[], open: boolean) {
    const valid = outlines.filter(outline => validOutline(document, outline));
    if (!valid.length) return;
    const root = document.context.obj({ Type: "Outlines" });
    const rootRef = document.context.register(root);
    const branch = outlineBranch(document, valid, rootRef);
    root.set(PDFName.of("First"), branch.first);
    root.set(PDFName.of("Last"), branch.last);
    root.set(PDFName.of("Count"), document.context.obj(branch.count));
    document.catalog.set(PDFName.of("Outlines"), rootRef);
    if (open) document.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  }

  function validOutline(document: PDFDocument, outline: PdfOutline) {
    return outline.action !== undefined || outline.pageIndex >= 0 && outline.pageIndex < document.getPageCount();
  }

  /** Append roots without rebuilding the target's existing actions, styles or collapsed branches. */
  function appendOutlines(document: PDFDocument, outlines: PdfOutline[]) {
    const valid = outlines.filter(outline => validOutline(document, outline));
    if (!valid.length) return;
    const root = document.catalog.lookupMaybe(PDFName.of("Outlines"), pdf.PDFDict);
    if (!root) { applyOutlines(document, valid, false); return; }
    const currentRoot = document.catalog.get(PDFName.of("Outlines"));
    const rootRef = currentRoot instanceof pdf.PDFRef ? currentRoot : document.context.register(root);
    const branch = outlineBranch(document, valid, rootRef);
    const seen = new Set<PDFDict>();
    let last: { object: PDFObject; node: PDFDict } | undefined, previous: PDFDict | undefined;
    for (let object = root.get(PDFName.of("First")); object;) {
      const node = document.context.lookup(object);
      if (!(node instanceof pdf.PDFDict) || seen.has(node) || seen.size >= 10_000) break;
      seen.add(node); previous = last?.node; last = { object, node };
      object = node.get(PDFName.of("Next"));
    }
    const counted = new Set<PDFDict>();
    const visibleCount = (first: PDFObject | undefined): number => {
      let count = 0;
      for (let object = first; object;) {
        const node = document.context.lookup(object);
        if (!(node instanceof pdf.PDFDict) || counted.has(node) || counted.size >= 10_000) break;
        counted.add(node); count++;
        if ((node.lookupMaybe(PDFName.of("Count"), pdf.PDFNumber)?.asNumber() ?? 0) >= 0)
          count += visibleCount(node.get(PDFName.of("First")));
        object = node.get(PDFName.of("Next"));
      }
      return count;
    };
    const count = root.lookupMaybe(PDFName.of("Count"), pdf.PDFNumber)?.asNumber() ??
      visibleCount(root.get(PDFName.of("First")));
    if (last) {
      const lastRef = last.object instanceof pdf.PDFRef ? last.object : document.context.register(last.node);
      if (previous) previous.set(PDFName.of("Next"), lastRef); else root.set(PDFName.of("First"), lastRef);
      last.node.set(PDFName.of("Next"), branch.first);
      document.context.lookup(branch.first, pdf.PDFDict).set(PDFName.of("Prev"), lastRef);
    } else root.set(PDFName.of("First"), branch.first);
    root.set(PDFName.of("Last"), branch.last);
    root.set(PDFName.of("Count"), document.context.obj(count + branch.count));
    document.catalog.set(PDFName.of("Outlines"), rootRef);
  }

  function outlineBranch(document: PDFDocument, outlines: PdfOutline[], parent: PDFRef) {
    const nodes = outlines.map((outline) => {
      const dict = document.context.obj({ Title: PDFHexString.fromText(outline.title),
        Parent: parent, ...(outline.action !== undefined ? { A: writeOutlineValue(document, outline.action) }
          : { Dest: [document.getPage(outline.pageIndex).ref,
            ...(outline.view?.map(value => writeOutlineValue(document, value)) ?? [PDFName.of("Fit")])] }) });
      return { outline, dict, ref: document.context.register(dict), descendants: 0 };
    });
    nodes.forEach((node, index) => {
      if (index) node.dict.set(PDFName.of("Prev"), nodes[index - 1].ref);
      if (index + 1 < nodes.length) node.dict.set(PDFName.of("Next"), nodes[index + 1].ref);
      const children = node.outline.children?.filter(child => validOutline(document, child)) ?? [];
      if (!children.length) return;
      const branch = outlineBranch(document, children, node.ref);
      node.dict.set(PDFName.of("First"), branch.first);
      node.dict.set(PDFName.of("Last"), branch.last);
      node.dict.set(PDFName.of("Count"), document.context.obj(branch.count));
      node.descendants = branch.count;
    });
    return { first: nodes[0].ref, last: nodes[nodes.length - 1].ref,
      count: nodes.reduce((sum, node) => sum + 1 + node.descendants, 0) };
  }

  function addInternalLink(page: PDFPage, rect: number[], target: PDFPage | string) {
    page.node.addAnnot(page.doc.context.register(page.doc.context.obj({
      Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0],
      ...(typeof target === "string" ? { A: page.doc.context.register(page.doc.context.obj({
        // A URI is 7-bit ASCII (ISO 32000 12.6.4.7), never a text string: a viewer reads an
        // encoded one as no address at all. Its characters past ASCII and the literal string's
        // own delimiters are percent-encoded.
        Type: "Action", S: "URI", URI: pdf.PDFString.of(target.replace(/[()\\]/gu, (character) =>
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replace(/[^\x21-\x7e]+/gu, encodeURIComponent)),
      })) } : { Dest: [target.ref, "Fit"] }),
    })));
  }

  async function embedFonts<Font extends string>(document: PDFDocument,
    sources: Record<Font, StandardFonts | Uint8Array>,
    fontkit?: Parameters<PDFDocument["registerFontkit"]>[0], subset = true) {
    if (fontkit) document.registerFontkit(fontkit);
    const fonts = {} as Record<Font, PDFFont>;
    const embedded = new Map<StandardFonts | Uint8Array, PDFFont>();
    for (const name of Object.keys(sources) as Font[]) {
      const source = sources[name];
      fonts[name] = embedded.get(source) ?? await document.embedFont(source,
        typeof source === "string" ? undefined : { subset });
      embedded.set(source, fonts[name]);
    }
    return fonts;
  }

  async function appendPages(document: PDFDocument, source: Uint8Array | PDFDocument,
    pageIndices?: number[], each?: (page: PDFPage, sourceIndex: number) => void) {
    const loaded = source instanceof Uint8Array
      ? await pdf.PDFDocument.load(source, { updateMetadata: false }) : source;
    const indices = pageIndices ?? loaded.getPageIndices();
    if (!indices.length) return [];
    const originalLabels = pageLabelReader(document), sourceLabels = pageLabelReader(loaded);
    const labels = [...document.getPageIndices().map(originalLabels), ...indices.map(sourceLabels)];
    const offset = document.getPageCount(), outlines = mapOutline(readOutlines(loaded), pageIndex => {
      const at = indices.indexOf(pageIndex);
      return at < 0 ? undefined : offset + at;
    });
    const pages = await document.copyPages(loaded, indices);
    const references = new Map(indices.map((sourceIndex, index) =>
      [String(loaded.getPage(sourceIndex).ref), pages[index].ref]));
    const destination = destinationReader(loaded);
    const destinationCopier = pdf.PDFObjectCopier.for(loaded.context, document.context);
    pages.forEach((page, index) => {
      const original = loaded.getPage(indices[index]).node.lookupMaybe(PDFName.of("Annots"), pdf.PDFArray);
      const copied = page.node.lookupMaybe(PDFName.of("Annots"), pdf.PDFArray);
      for (let annotationIndex = (original?.size() ?? 0) - 1; annotationIndex >= 0; annotationIndex--) {
        if (!copied || annotationIndex >= copied.size()) continue;
        const source = original!.lookup(annotationIndex, pdf.PDFDict), target = copied.lookup(annotationIndex, pdf.PDFDict);
        if (source.has(PDFName.of("P"))) target.set(PDFName.of("P"), page.ref);
        const action = source.lookup(PDFName.of("A"));
        if (!source.has(PDFName.of("Dest")) && !(action instanceof pdf.PDFDict &&
            String(action.lookup(PDFName.of("S"))) === "/GoTo")) continue;
        const dest = destination(source), reference = dest && references.get(String(dest.get(0)));
        if (!dest || !reference) { copied.remove(annotationIndex); continue; }
        const remapped = document.context.obj([reference,
          ...dest.asArray().slice(1).map((operand) => destinationCopier.copy(operand))]);
        if (source.has(PDFName.of("Dest"))) target.set(PDFName.of("Dest"), remapped);
        else target.lookup(PDFName.of("A"), pdf.PDFDict).set(PDFName.of("D"), remapped);
      }
    });
    pages.forEach((page, index) => { document.addPage(page); each?.(page, indices[index]); });
    writePageLabels(document, labels);
    appendOutlines(document, outlines);
    return pages;
  }

  async function assemble<Font extends string>(input: PdfAssemblyInput<Font>): Promise<PdfAssemblyResult> {
    input.signal?.throwIfAborted();
    const document = input.document ?? await pdf.PDFDocument.create();
    const context = { document, fonts: await embedFonts(document, input.fonts, input.fontkit),
      starts: new Map<string, number>() };
    await input.before?.(context);
    for (const part of input.parts) {
      input.signal?.throwIfAborted();
      context.starts.set(part.id, document.getPageCount());
      await part.draw?.(context);
      if (part.source) await appendPages(document, part.source, part.pageIndices, (page, index) => {
        if (part.ocrFont) applyOcrText(page, context.fonts[part.ocrFont], part.ocrTextByPage?.[index]);
        part.decorate?.(page, index, context);
      });
    }
    await input.after?.(context);
    const numbers = input.pageNumbers;
    if (numbers) document.getPages().forEach((page, index) => drawPageNumber(page,
      numbers.start + index, context.fonts[numbers.font], numbers.position,
      numbers.size, numbers.inset, numbers.offset));
    for (const link of input.links ?? [])
      addInternalLink(link.page, link.rect, "url" in link ? link.url : document.getPage(link.targetPageIndex));
    if (input.pageLabels !== undefined) applyPageLabels(document, input.pageLabels);
    if (input.outlines) {
      const outlines = input.outlines(context);
      document.catalog.delete(PDFName.of("Outlines"));
      applyOutlines(document, outlines, !!input.openBookmarks);
    }
    input.signal?.throwIfAborted();
    const bytes = await document.save(input.saveOptions);
    input.signal?.throwIfAborted();
    return { bytes, pageCount: document.getPageCount() };
  }

  async function volumes<Plan, Font extends string>(plans: Plan[],
    prepare: (plans: Plan[]) => PdfAssemblyInput<Font>[] | Promise<PdfAssemblyInput<Font>[]>,
    limits: PdfVolumeLimits | undefined,
    split: (plan: Plan, output: PdfAssemblyResult) => Plan[]) {
    while (true) {
      const inputs = await prepare(plans), built: PdfAssemblyResult[] = [];
      for (const input of inputs) built.push(await assemble(input));
      const oversized = built.findIndex(({ bytes, pageCount }) =>
        !!limits?.maxPages && pageCount > limits.maxPages ||
        !!limits?.maxBytes && bytes.byteLength > limits.maxBytes);
      if (oversized < 0) return built;
      const divided = split(plans[oversized], built[oversized]);
      if (divided.length < 2) throw new Error("The PDF could not be divided into filing-sized volumes.");
      plans.splice(oversized, 1, ...divided);
    }
  }
  return { drawPageNumber, paginationArtifact, applyOcrText, applyPageLabels, applyOutlines, readOutlines, addInternalLink,
    destinationReader, embedFonts, appendPages, assemble, volumes };
}
