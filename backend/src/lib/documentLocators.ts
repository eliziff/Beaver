import { structureNative, type NativeDocument, type NativeNode } from "./structureNative";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";

type Locator = LegalEvidenceReceipt["locator"];

const pageIndexes = new WeakMap<NativeDocument, NativeNode[]>();

function pageLocator(document: NativeDocument, start: number, end: number): Locator | undefined {
  let pages = pageIndexes.get(document);
  if (!pages) {
    pages = structureNative().documentAnchors(document).filter((node) => node.kind === "page");
    pageIndexes.set(document, pages);
  }
  const page = pages.find((node) => node.query_ranges.some((range) => range.start <= start && range.end >= end))
    ?? pages.find((node) => node.query_ranges.some((range) => range.start < end && range.end > start));
  return page?.label != null ? { kind: "page", label: page.label } : undefined;
}

/** Legal pinpoint provenance belongs to the structure owner, including detached markers. */
export function provenBlockLocator(
  document: NativeDocument,
  node: NativeNode | null,
  span: { start: number; end: number },
): Locator | undefined {
  if (node?.kind === "page" && node.label != null) return { kind: "page", label: node.label };
  if (node?.label != null && node.prints_label && ["paragraph", "section", "footnote"].includes(node.kind))
    return { kind: node.kind as Locator["kind"], label: node.label };
  return pageLocator(document, span.start, span.end);
}
