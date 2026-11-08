import { structureNative, type NativeDocument, type NativeNodeReading } from "./structureNative";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";

type Locator = LegalEvidenceReceipt["locator"];

const pageIndexes = new WeakMap<NativeDocument, NativeNodeReading[]>();

function pageLocator(document: NativeDocument, start: number, end: number): Locator | undefined {
  let pages = pageIndexes.get(document);
  if (!pages) {
    pages = structureNative().documentAnchors(document).filter(({ node }) => node.kind === "page");
    pageIndexes.set(document, pages);
  }
  const page = pages.find(({ ranges }) => ranges.some((range) => range.start <= start && range.end >= end))
    ?? pages.find(({ ranges }) => ranges.some((range) => range.start < end && range.end > start));
  return page?.node.label != null ? { kind: "page", label: page.node.label, ...page.fragment && { fragment: page.fragment } }
    : undefined;
}

/** Legal pinpoint provenance belongs to the structure owner, including detached markers. */
export function provenBlockLocator(
  document: NativeDocument,
  reading: NativeNodeReading | null,
  span: { start: number; end: number },
): Locator | undefined {
  const node = reading?.node, fragment = reading?.fragment ? { fragment: reading.fragment } : {};
  if (node?.kind === "page" && node.label != null) return { kind: "page", label: node.label, ...fragment };
  if (node?.label != null && reading?.prints_label && ["paragraph", "section", "footnote"].includes(node.kind))
    return { kind: node.kind as Locator["kind"], label: node.label, ...fragment };
  return pageLocator(document, span.start, span.end);
}
