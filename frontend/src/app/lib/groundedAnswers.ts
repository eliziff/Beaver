import type { Citation, DocumentCitation } from "./citations";

export type GroundedAnswer = {
  claims: { text: string; evidence_ids: string[] }[];
  value?: string | number | boolean | string[] | null;
};
export type GroundedEvidence = {
  evidence_id: string;
  scope?: "document" | "passage";
  provider: string;
  stable_source_id: string;
  source_reference?: { id: string; family?: string; part?: string };
  source_sha256: string;
  span_sha256: string;
  block_id: string;
  span_text: string | null;
  citation: string;
  name: string | null;
  external_url: string | null;
  source_class?: "case" | "legislation" | "commentary";
  dataset?: string;
  language?: "en" | "fr";
  version?: string | null;
  locator: { kind: string; label: string; sheet?: string; cells?: string };
};

export function evidenceCitation(receipt: GroundedEvidence, ref: number): Citation | null {
  if (!receipt.span_text) return null;
  const { kind, label, sheet, cells } = receipt.locator;
  const locator: Pick<DocumentCitation, "locator_kind" | "locator" | "pinpoint"> = kind === "paragraph" || kind === "page" || kind === "section" || kind === "footnote"
    ? { locator_kind: kind, locator: label, pinpoint: kind === "page" ? `p. ${label.replace(/^page\s*/iu, "")}`
        : kind === "paragraph" ? `para ${label.replace(/^par(?:agraph)?\s*/iu, "")}` : label } : {};
  const common = { ref, source_class: receipt.source_class, ...locator };
  if (receipt.provider === "library") return {
    ...common, kind: "document", document_id: receipt.stable_source_id,
    version_id: receipt.version, filename: receipt.name ?? receipt.citation,
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

export function groundedAnswerMarkdown(answer: GroundedAnswer & { evidence: GroundedEvidence[] }) {
  const receipts = new Map(answer.evidence.map((receipt) => [receipt.evidence_id, receipt]));
  const byEvidence = new Map<string, Citation>();
  const text = answer.claims.map((claim) => {
    const references = [...new Set(claim.evidence_ids)].flatMap((id) => {
      let citation = byEvidence.get(id);
      if (!citation) {
        const receipt = receipts.get(id);
        citation = receipt ? evidenceCitation(receipt, byEvidence.size + 1) ?? undefined : undefined;
        if (citation) byEvidence.set(id, citation);
      }
      return citation ? [`[${citation.ref}]`] : [];
    });
    return `${claim.text}${references.length ? ` ${references.join("")}` : ""}`;
  }).join("\n\n");
  return { text, citations: [...byEvidence.values()] };
}
