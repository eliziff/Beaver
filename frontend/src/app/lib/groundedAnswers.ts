import type { Citation } from "./citations";
import type { LegalEvidenceReceipt } from "../../../../backend/src/lib/researchContract";

export type { GroundedClaim, GroundedAnswer } from "../../../../backend/src/lib/groundedAnswer";
/** The evidence receipt the server attests; the browser only reads it. */
export type GroundedEvidence = LegalEvidenceReceipt;

export function evidenceCitation(receipt: GroundedEvidence, ref: number): Citation | null {
  if (!receipt.span_text) return null;
  const { kind, label, sheet, cells } = receipt.locator;
  const locator: Pick<Extract<Citation, { kind: "a2aj" }>, "locator_kind" | "locator" | "pinpoint"> = kind === "paragraph" || kind === "page" || kind === "section" || kind === "footnote"
    ? { locator_kind: kind, locator: label, pinpoint: kind === "page" ? `p. ${label.replace(/^page\s*/iu, "")}`
        : kind === "paragraph" ? `para ${label.replace(/^par(?:agraph)?\s*/iu, "")}` : label } : {};
  const common = { ref, source_class: receipt.source_class, ...locator };
  if (receipt.provider === "library") return {
    ...common, kind: "document", document_id: receipt.stable_source_id,
    version_id: receipt.version ?? undefined, filename: receipt.name ?? receipt.citation,
    ...(kind === "document" && label !== "document" && { pinpoint: label }),
    quotes: [{ quote: receipt.span_text,
      ...(kind === "page" ? { page: label.replace(/^page\s*/iu, "") } : {}),
      ...(sheet ? { sheet } : {}), ...(cells ? { cell: cells } : {}) }],
  };
  const legal = { ...common, citation: receipt.citation, external_url: receipt.external_url,
    quotes: [{ quote: receipt.span_text }] };
  if (receipt.provider === "a2aj" || receipt.provider === "citator") return {
    ...legal, kind: "a2aj", name: receipt.name, dataset: receipt.dataset,
  };
  if (["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"].includes(receipt.provider)) return {
    ...legal, kind: "public_legal", provider: receipt.provider as Extract<Citation, { kind: "public_legal" }>["provider"],
    identifier: receipt.source_reference?.id ?? receipt.stable_source_id,
    title: receipt.name,
  };
  return null;
}

