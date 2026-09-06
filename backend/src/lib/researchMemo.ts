import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentStore } from "./documentStore";
import { createLegalEvidenceCitationsFromEntries, createLegalSourceSearchCitations } from "./chat/citations";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { readResearchEvidenceParts, type ResearchFile, type ResearchSource } from "./researchFile";

/** Memo links carry the same presentation produced for assistant citations. */
export function researchMemoCitation(file: ResearchFile, source: ResearchSource, receipt?: LegalEvidenceReceipt) {
  const reference = source.reference;
  const citation = receipt ? createLegalEvidenceCitationsFromEntries([{ receipt }])[0]
    : reference.kind === "document" ? { authority: reference.title ?? reference.id }
    : createLegalSourceSearchCitations([{ provider: reference.provider, identifier: reference.id,
      source_type: reference.kind, title: reference.title, citation: reference.citation,
      collection: reference.collection, url: reference.url }])[0];
  if (!citation) throw new ApplicationError(400, "This source cannot be cited.");
  const params = new URLSearchParams({ provider: reference.provider, source_id: reference.id,
    citation: reference.citation ?? reference.id, research_file: file.document.id, research_source: source.id,
    doc_type: reference.kind === "legislation" ? "laws" : reference.kind === "journal" ? "articles"
      : reference.kind === "hansard" ? "hansard" : "cases", language: reference.language ?? "en" });
  if (reference.collection) params.set("dataset", reference.collection);
  if (reference.title) params.set("title", reference.title);
  if (!["a2aj", "journal"].includes(reference.provider)) {
    const target = citation.url ?? reference.url;
    if (typeof target === "string") params.set("external_url", target);
  }
  if (receipt) { params.set("evidence_id", receipt.evidence_id); params.set("locator", receipt.locator.label); }
  if (reference.kind === "document") {
    params.set("document_id", reference.id); params.set("version_id", reference.versionId);
    if (receipt?.locator.sheet) params.set("sheet", receipt.locator.sheet);
    if (receipt?.locator.cells) params.set("cells", receipt.locator.cells);
  }
  for (const key of ["authority", "short_authority", "source_class", "pinpoint", "locator_kind", "locator_separator"])
    if (typeof citation[key] === "string") params.set(key, citation[key]);
  const title = typeof reference.title === "string" ? reference.title : "";
  const authority = typeof citation.authority === "string" ? citation.authority
    : title && reference.citation && title.toLowerCase() !== reference.citation.toLowerCase()
      ? `${title}, ${reference.citation}` : title || reference.citation || reference.id;
  const label = typeof citation.pinpoint === "string" && !authority.toLowerCase().includes(citation.pinpoint.toLowerCase())
    ? `${authority}${citation.locator_separator ?? " at "}${citation.pinpoint}` : authority;
  const href = `${reference.kind === "document" ? "/library" : "/sources/view"}?${params}`;
  return { href, label, markdown: `[${label.replace(/[\r\n]+/gu, " ").replace(/([\\[\]])/gu, "\\$1")}](<${href}>)` };
}

export async function readResearchMemoCitation(documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile, sourceId: string, evidenceId?: string) {
  const source = file.state.sources[sourceId];
  if (!source) throw new ApplicationError(404, "Research source not found");
  if (!evidenceId) return researchMemoCitation(file, source);
  const evidence = (await readResearchEvidenceParts(documents, scope, file, [sourceId])).get(sourceId)?.[evidenceId];
  if (!evidence) throw new ApplicationError(404, "Saved passage not found");
  return researchMemoCitation(file, source, evidence.receipt);
}
