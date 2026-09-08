import type { PDFDocument, PDFFont, PDFPage, PDFRef } from "pdf-lib";

export type PdfOutline = { title: string; pageIndex: number; children?: PdfOutline[] };
export type PdfPageNumberPosition = "top-right" | "top-centre" | "bottom-right" | "bottom-centre";

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

  function addInternalLink(page: PDFPage, rect: number[], target: PDFPage) {
    page.node.addAnnot(page.doc.context.register(page.doc.context.obj({
      Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], Dest: [target.ref, "Fit"],
    })));
  }
  return { drawPageNumber, applyOcrText, applyPageLabels, applyOutlines, addInternalLink };
}
