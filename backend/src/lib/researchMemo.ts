import { ApplicationError, type ApplicationScope } from "./applicationError";
import { z } from "zod";
import { renderCitedBlocks } from "./groundedAnswer";
import { textField } from "./textField";
import { researchFindingReferenceSchema } from "./researchFindingReference";
import type { ResearchFinding } from "./researchChat";
import { legalEvidenceResourceReference } from "./chat/legalEvidence";
import { researchSourceResource } from "./researchFile";
import type { DocumentStore } from "./documentStore";
import { createLegalEvidenceCitationsFromEntries, createLegalSourceSearchCitations } from "./chat/citations";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { readResearchEvidenceParts, type ResearchFile, type ResearchSource } from "./researchFile";

/** Memo links carry the same presentation produced for assistant citations. */
export function researchMemoCitation(file: ResearchFile, source: ResearchSource, receipt?: LegalEvidenceReceipt) {
  const reference = source.reference;
  const citation: Record<string, unknown> = receipt ? createLegalEvidenceCitationsFromEntries([{ receipt }])[0]
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

/** Copy saved research, rather than asking a model to reproduce its prose or links. */
export const researchMemoFindingsSchema = z.object({
  title: textField(200),
  references: z.array(researchFindingReferenceSchema).min(1).max(500),
  mode: z.enum(["append", "replace"]).default("append"),
}).strict();

export function researchFindingsMarkdown(file: ResearchFile, findings: readonly ResearchFinding[]) {
  const sources = new Map(Object.values(file.state.sources).map(source => [researchSourceResource(source.reference), source])),
    cited = new Map<string, string>(), seen = new Set<string>(), blocks: { text: string; citations: string[] }[] = [];
  const citation = (receipt: LegalEvidenceReceipt) => {
    if (!cited.has(receipt.evidence_id)) {
      const source = sources.get(legalEvidenceResourceReference(receipt) ?? "");
      if (!source) throw new ApplicationError(409, "A finding's supporting source is unavailable");
      cited.set(receipt.evidence_id, researchMemoCitation(file, source, receipt).markdown);
    }
    return cited.get(receipt.evidence_id)!;
  };
  for (const finding of findings) {
    const receipts = new Map(finding.evidence.map(receipt => [receipt.evidence_id, receipt]));
    for (const claim of finding.answer.claims) {
      // A jointly supported claim can occur in several source rows. Copy that exact claim once;
      // equal words with different support remain separate. No semantic deduplication.
      const key = JSON.stringify([claim.text, [...new Set(claim.evidence_ids)].sort()]);
      if (seen.has(key)) continue;
      seen.add(key);
      const links = [...new Set(claim.evidence_ids)].map(id => {
        const receipt = receipts.get(id);
        if (!receipt) throw new ApplicationError(409, "An original supporting passage is unavailable");
        return citation(receipt);
      });
      blocks.push({ text: claim.text, citations: links });
    }
    if (!finding.answer.claims.length) {
      const value = finding.answer.value, text = finding.answer.summary ||
        (value != null ? Array.isArray(value) ? value.join("\n") : String(value) :
          finding.answer.outcome === "not_found" ? "Not found in the reviewed material." : "");
      if (!text) continue;
      const source = sources.get(finding.resource);
      if (!source) throw new ApplicationError(409, "The finding's source is unavailable");
      const key = JSON.stringify([finding.reference, text]);
      if (seen.has(key)) continue;
      seen.add(key);
      // A source-level review outcome is not a quotation or a passage proving absence.
      blocks.push({ text: `${finding.question.title}: ${text}${
        finding.answer.coverage === "partial" ? " (Partial review.)" : ""}`,
        citations: [researchMemoCitation(file, source).markdown] });
    }
  }
  if (!blocks.length) throw new ApplicationError(400, "The selected findings contain no research to copy");
  return renderCitedBlocks(blocks);
}
