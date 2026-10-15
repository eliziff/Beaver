import { structureNative, type NativeDocument, type NativeDocumentBlock } from "./structureNative";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";

type Locator = LegalEvidenceReceipt["locator"];
type Block = Pick<NativeDocumentBlock, "kind" | "label" | "ranges" | "printedLabel">;

const pageIndexes = new WeakMap<NativeDocument, Array<Block>>();

function pageLocator(document: NativeDocument, start: number, end: number): Locator | undefined {
  let pages = pageIndexes.get(document);
  if (!pages) {
    pages = structureNative().documentAnchors(document).filter((anchor) => anchor.kind === "page");
    pageIndexes.set(document, pages);
  }
  const page = pages.find(({ ranges }) => ranges.some((range) => range.start <= start && range.end >= end))
    ?? pages.find(({ ranges }) => ranges.some((range) => range.start < end && range.end > start));
  return page ? { kind: "page", label: page.label } : undefined;
}

/** Legal pinpoint provenance belongs to the structure owner, including detached markers. */
export function provenBlockLocator(
  document: NativeDocument,
  block: Block | null,
  span: { start: number; end: number },
): Locator | undefined {
  if (block?.kind === "page") return { kind: "page", label: block.label };
  if (block?.printedLabel && ["paragraph", "section", "footnote"].includes(block.kind))
    return { kind: block.kind as Locator["kind"], label: block.label };
  return pageLocator(document, span.start, span.end);
}
