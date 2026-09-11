import type { Document } from "@/app/lib/api/documents";

export type { ResearchLabel, ResearchSourceReference, ResearchSource, ResearchPartReference,
  ResearchFileState, PublicResearchFileAction as ResearchAction, ResearchEvidence,
  ResearchQueryReceipt, ResearchChange, ResearchPageItem,
  ResearchSelection } from "../../../../backend/src/lib/researchContract";
import type { ResearchSource, ResearchChange, ResearchQueryReceipt, ResearchFileOf,
  ResearchFileState, ResearchSourceReference, ResearchSelection,
  LegalEvidenceReceipt } from "../../../../backend/src/lib/researchContract";
export type ResearchEvidenceReceipt = LegalEvidenceReceipt;
export type ResearchProposal = Pick<ResearchChange, "id" | "title" | "createdAt" | "executor" | "model" | "counts">;
export type ResearchFile = ResearchFileOf<Document>;
export type ResearchQueryCoverage = { complete: boolean; next_after: string | null;
  attempted_sources: number; selected_sources: number };
export type ResearchQueryResult = { file: ResearchFile; receipt: ResearchQueryReceipt; coverage: ResearchQueryCoverage };
export type ResearchActionResult = ResearchFile & { sourceId?: string; evidenceId?: string; receipt?: ResearchEvidenceReceipt };
export type ResearchQueryInput = ResearchSelection & { text?: string; after?: string; syntax: "literal" | "terms";
  limit?: number;
  rules?: Array<{ phrase: string; direction: "before" | "after" | "around";
    unit: "sentence" | "line" | "paragraph" | "chars"; chars?: number;
    slot?: string }>; conflict?: "prompt" | "first" | "longer" | "shorter" | "append" };
/** Receipt inventory counts are not highlight counts. */
export const researchHighlightCount = (source: ResearchSource) =>
  Object.values(source.passages?.labelCounts ?? {}).reduce((sum, count) => sum + count, 0);

export const newResearchState = (): ResearchFileState => ({ schemaVersion: "beaver.research.v2",
  labels: {}, sources: {}, queries: null, note: "" });
export const isResearchDocument = (document: Document) =>
  document.file_type === "md" && document.filename.toLowerCase().endsWith(".research.md");
export { researchSourceKey } from "../../../../backend/src/lib/resourceReferences";

export { researchLabelPath } from "../../../../backend/src/lib/researchLabels";
export const legalSourceViewerHref = (reference: ResearchSourceReference, research?: {
  fileId: string; sourceId: string }) => `/sources/view?${new URLSearchParams({
    provider: reference.provider, citation: reference.citation ?? reference.id,
    source_id: reference.id, doc_type: reference.kind === "legislation" ? "laws"
      : reference.kind === "journal" ? "articles" : reference.kind === "hansard" ? "hansard" : "cases",
    language: reference.language ?? "en", ...(reference.collection ? {
      dataset: reference.collection } : {}), ...(research ? {
      research_file: research.fileId, research_source: research.sourceId } : {}),
  })}`;
