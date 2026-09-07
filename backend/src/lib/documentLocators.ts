import { structureNative, type NativeDocument, type NativeDocumentBlock } from "./structureNative";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";

type Locator = LegalEvidenceReceipt["locator"];
type Block = Pick<NativeDocumentBlock, "kind" | "label" | "start" | "end">;

/**
 * A native paragraph, section or note label addresses a structural position in
 * the derived text, which is a legal address only when the source prints that
 * number. Judgments print `[4]` and are addressable; laid-out PDFs carry prose
 * ordinals that run far past their printed numbering — in a filed brief the
 * block printed "1." arrives as `par25` and the last is `par1002` — so a label
 * becomes a pinpoint only when the block's own opening marker confirms it.
 * Otherwise the page carries the citation, which is always true of the source.
 */
const PRINTED_MARKER = /^\s*[[(]?(\d{1,4})[\])]?\s*[.)]?\s/u;

const pageIndexes = new WeakMap<NativeDocument, Array<Omit<Block, "kind">>>();
const documentTexts = new WeakMap<NativeDocument, string>();

function pageIndex(document: NativeDocument) {
  let pages = pageIndexes.get(document);
  if (!pages) {
    pages = structureNative().documentAnchors(document)
      .filter((anchor) => anchor.kind === "page")
      .map(({ start, end, label }) => ({ start, end, label }));
    pageIndexes.set(document, pages);
  }
  return pages;
}

function documentText(document: NativeDocument) {
  let text = documentTexts.get(document);
  if (text === undefined) {
    text = structureNative().documentText(document);
    documentTexts.set(document, text);
  }
  return text;
}

function pageLocator(document: NativeDocument, start: number, end: number): Locator | undefined {
  const pages = pageIndex(document);
  const page = pages.find(({ start: from, end: to }) => from <= start && to >= end)
    ?? pages.find(({ start: from, end: to }) => from < end && to > start);
  return page ? { kind: "page", label: page.label } : undefined;
}

/**
 * The locator a span may honestly carry: the block's own pinpoint when the
 * source prints it, the containing page otherwise, and nothing when the
 * document has no pages either.
 */
export function provenBlockLocator(
  document: NativeDocument,
  block: Block | null,
  span: { start: number; end: number },
): Locator | undefined {
  if (!block) return pageLocator(document, span.start, span.end);
  if (block.kind === "page") return { kind: "page", label: block.label };
  if (!["paragraph", "section", "footnote"].includes(block.kind))
    return pageLocator(document, span.start, span.end);
  const marker = PRINTED_MARKER.exec(documentText(document).slice(block.start, block.end))?.[1];
  return marker && marker === /(\d{1,4})\s*$/u.exec(block.label)?.[1]
    ? { kind: block.kind as Locator["kind"], label: block.label }
    : pageLocator(document, span.start, span.end);
}
