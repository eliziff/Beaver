import { structureNative, type NativeDocument, type NativeNodeReading } from "./structureNative";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";

type Locator = LegalEvidenceReceipt["locator"];

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
  const page = structureNative().documentPageAt(document, span.start, span.end);
  return page?.node.label != null ? { kind: "page", label: page.node.label, ...page.fragment && { fragment: page.fragment } }
    : undefined;
}
