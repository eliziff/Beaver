import type { ResearchFindingReference } from "@/app/lib/api/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import type { GroundedEvidence } from "@/app/lib/groundedAnswers";

import type { ResearchFileState } from "../../../../backend/src/lib/researchContract";
export type { ResearchLabel, ResearchSourceReference, ResearchSource, ResearchPartReference,
  ResearchFileState, PublicResearchFileAction as ResearchAction } from "../../../../backend/src/lib/researchContract";
import type { ResearchSource, ResearchSourceReference } from "../../../../backend/src/lib/researchContract";
export type ResearchEvidenceReceipt = GroundedEvidence;
export type ResearchEvidence = { receipt: ResearchEvidenceReceipt; sourceId: string; highlightId?: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = { query_id: string; call_id: string;
  tool: "search_sources" | "Read"; executed_at: string; model: string;
  executor_version: "legal-source-search-v1" | "legal-source-pattern-v1";
  input: Record<string, unknown>; results: Array<{ rank: number;
    resource: string } | { rank: number; evidence_id: string }>;
  sourceIds: string[]; matchedSourceIds: string[]; evidenceIds: string[];
  failures: Array<{ sourceId: string; code: string }>; slots: Record<string, string[]>;
  sourceFingerprints?: Record<string, string[]>;
  sourceReferences?: Record<string, ResearchSourceReference>;
  labelPaths?: Record<string, string> };
export type ResearchChange = { id: string; title: string; createdAt: string;
  executor: "human" | "assistant"; model?: string; status: "pending" | "applied" | "rejected"; undoOf?: string;
  counts: { labels: number; sources: number; passages: number; tables?: number; results?: number };
  changes: { target: "label" | "source" | "passage" | "workspace" | "table" | "result"; id: string; sourceId?: string;
    field: string; before: unknown; after: unknown }[] };
export type ResearchProposal = Pick<ResearchChange, "id" | "title" | "createdAt" | "executor" | "model" | "counts">;
export type ResearchFile = { document: Document; versionId: string;
  workingRevision: number; state: ResearchFileState };
export type ResearchQueryCoverage = { complete: boolean; next_after: string | null;
  attempted_sources: number; selected_sources: number };
export type ResearchQueryResult = { file: ResearchFile; receipt: ResearchQueryReceipt; coverage: ResearchQueryCoverage };
export type ResearchPageItem = { kind: "passage" | "evidence"; index: number; value: ResearchEvidence }
  | { kind: "query"; index: number; value: ResearchQueryReceipt }
  | { kind: "change"; index: number; value: ResearchChange };
export type ResearchActionResult = ResearchFile & { sourceId?: string; evidenceId?: string; receipt?: ResearchEvidenceReceipt };
export type ResearchSelection = { target: "sources" | "passages"; sourceIds?: string[];
  evidenceIds?: string[]; labelIds?: string[]; unlabelled?: boolean;
  members?: { sourceId: string; evidenceIds?: string[] }[]; findingRefs?: ResearchFindingReference[] };
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
