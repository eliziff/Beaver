import type { PDFDocument, PDFFont, PDFPage, PDFRef, SaveOptions, StandardFonts } from "pdf-lib";

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

export function pdfAssembly(pdf: typeof import("pdf-lib")) {
  const { PDFHexString, PDFName, degrees, rgb } = pdf;
  function drawPageNumber(page: PDFPage, number: number, font: PDFFont,
    position: PdfPageNumberPosition, size = 9, inset = 72, offset = 36) {
    const text = String(number), textWidth = font.widthOfTextAtSize(text, size);
    const crop = page.getCropBox(), angle = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = angle === 90 || angle === 270;
    const width = sideways ? crop.height : crop.width;
    const height = sideways ? crop.width : crop.height;
    const x = position.endsWith("right") ? width - inset - textWidth : (width - textWidth) / 2;
    const y = position.startsWith("top") ? height - offset : offset;
    const [pageX, pageY] = angle === 90 ? [y, x]
      : angle === 180 ? [crop.width - x, crop.height - y]
        : angle === 270 ? [crop.width - y, crop.height - x] : [x, y];
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
    fontkit?: Parameters<PDFDocument["registerFontkit"]>[0]) {
    if (fontkit) document.registerFontkit(fontkit);
    const fonts = {} as Record<Font, PDFFont>;
    const embedded = new Map<StandardFonts | Uint8Array, PDFFont>();
    for (const name of Object.keys(sources) as Font[]) {
      const source = sources[name];
      fonts[name] = embedded.get(source) ?? await document.embedFont(source,
        typeof source === "string" ? undefined : { subset: true });
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
    pages.forEach((page, index) => { document.addPage(page); each?.(page, indices[index]); });
    return pages;
  }

  async function assemble<Font extends string>(input: PdfAssemblyInput<Font>): Promise<PdfAssemblyResult> {
    input.signal?.throwIfAborted();
    const document = await pdf.PDFDocument.create();
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
  return { drawPageNumber, applyOcrText, applyPageLabels, applyOutlines, addInternalLink,
    embedFonts, appendPages, assemble, volumes };
}
