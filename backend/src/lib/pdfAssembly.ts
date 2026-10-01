import type { PDFDict, PDFDocument, PDFFont, PDFObject, PDFPage, PDFRef, SaveOptions, StandardFonts } from "pdf-lib";

export type PdfOutline = { title: string; pageIndex: number; children?: PdfOutline[] };
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

/** An outline moved onto other pages: an entry whose page is gone gives way to its children. */
export function mapOutline(outline: PdfOutline[], page: (pageIndex: number) => number | undefined): PdfOutline[] {
  return outline.flatMap(({ title, pageIndex, children }) => {
    const mapped = children ? mapOutline(children, page) : [];
    const at = page(pageIndex);
    return at === undefined ? mapped : [{ title, pageIndex: at, ...(mapped.length ? { children: mapped } : {}) }];
  });
}

export function pdfAssembly(pdf: typeof import("pdf-lib")) {
  const { PDFHexString, PDFName, degrees, rgb } = pdf;

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
  function drawPageNumber(page: PDFPage, number: number, font: PDFFont,
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
    page.drawText(text, { x: crop.x + pageX, y: crop.y + pageY, size, font,
      rotate: degrees(angle), color: rgb(.12, .12, .12) });
  }

  function applyOcrText(page: PDFPage, font: PDFFont, value?: string) {
    if (!value?.trim()) return;
    const text = value.normalize("NFC").replace(/\t/gu, " ").slice(0, 60_000);
    for (const [index, chunk] of (text.match(/[\s\S]{1,1800}/gu) ?? []).entries()) {
      page.drawText(chunk, { x: 1, y: 1 + index % 4, size: 1, lineHeight: 1,
        maxWidth: Math.max(1, page.getWidth() - 2), font, opacity: 0 });
    }
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
        if (title && pageIndex !== undefined) result.push({ title: title.decodeText(),
          pageIndex: offset + pageIndex, ...(children.length ? { children } : {}) });
        else result.push(...children);
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

  function applyOutlines(document: PDFDocument, outlines: PdfOutline[], open: boolean) {
    const valid = outlines.filter((outline) =>
      outline.pageIndex >= 0 && outline.pageIndex < document.getPageCount());
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

  function outlineBranch(document: PDFDocument, outlines: PdfOutline[], parent: PDFRef) {
    const nodes = outlines.map((outline) => {
      const dict = document.context.obj({ Title: PDFHexString.fromText(outline.title),
        Parent: parent, Dest: [document.getPage(outline.pageIndex).ref, "Fit"] });
      return { outline, dict, ref: document.context.register(dict), descendants: 0 };
    });
    nodes.forEach((node, index) => {
      if (index) node.dict.set(PDFName.of("Prev"), nodes[index - 1].ref);
      if (index + 1 < nodes.length) node.dict.set(PDFName.of("Next"), nodes[index + 1].ref);
      const children = node.outline.children?.filter((child) =>
        child.pageIndex >= 0 && child.pageIndex < document.getPageCount()) ?? [];
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
        Type: "Action", S: "URI", URI: PDFHexString.fromText(target),
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
    const pages = await document.copyPages(loaded, indices);
    const references = new Map(indices.map((sourceIndex, index) =>
      [String(loaded.getPage(sourceIndex).ref), pages[index].ref]));
    const destination = destinationReader(loaded);
    pages.forEach((page, index) => {
      const original = loaded.getPage(indices[index]).node.lookupMaybe(PDFName.of("Annots"), pdf.PDFArray);
      const copied = page.node.lookupMaybe(PDFName.of("Annots"), pdf.PDFArray);
      for (let annotationIndex = (original?.size() ?? 0) - 1; annotationIndex >= 0; annotationIndex--) {
        if (!copied || annotationIndex >= copied.size()) continue;
        const source = original!.lookup(annotationIndex, pdf.PDFDict), target = copied.lookup(annotationIndex, pdf.PDFDict);
        const action = source.lookup(PDFName.of("A"));
        if (!source.has(PDFName.of("Dest")) && !(action instanceof pdf.PDFDict &&
            String(action.lookup(PDFName.of("S"))) === "/GoTo")) continue;
        const dest = destination(source), reference = dest && references.get(String(dest.get(0)));
        if (!dest || !reference) { copied.remove(annotationIndex); continue; }
        const remapped = document.context.obj([reference, ...dest.asArray().slice(1)]);
        if (source.has(PDFName.of("Dest"))) target.set(PDFName.of("Dest"), remapped);
        else target.lookup(PDFName.of("A"), pdf.PDFDict).set(PDFName.of("D"), remapped);
      }
    });
    pages.forEach((page, index) => { document.addPage(page); each?.(page, indices[index]); });
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
    if (input.outlines) applyOutlines(document, input.outlines(context), !!input.openBookmarks);
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
  return { drawPageNumber, applyOcrText, applyPageLabels, applyOutlines, readOutlines, addInternalLink,
    destinationReader, embedFonts, appendPages, assemble, volumes };
}
