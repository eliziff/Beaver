import type { ResearchFindingReference } from "@/app/lib/api/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import type { GroundedEvidence } from "@/app/lib/groundedAnswers";

export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null; order: number; scope: "source" | "highlight";
  definition?: string };
export type ResearchSourceReference = { id: string;
  title?: string | null; citation?: string | null; alternateCitation?: string | null;
  date?: string | null; collection?: string | null; language?: "en" | "fr";
  url?: string | null } & ({ provider: "library"; kind: "document"; versionId: string;
    family?: never; part?: never } | { provider: string; family?: string; part?: string;
    kind: "case" | "legislation" | "journal" | "hansard"; versionId?: never });
export type ResearchSource = { id: string; reference: ResearchSourceReference; collected?: boolean;
  labelIds: string[]; note: string;
  passages: (ResearchPartReference & { labelCounts: Record<string, number>;
    unlabelledCount: number }) | null };
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
export type ResearchPartReference = { count: number; sha256: string };
export type ResearchChange = { id: string; title: string; createdAt: string;
  executor: "human" | "assistant"; model?: string; status: "pending" | "applied" | "rejected"; undoOf?: string;
  counts: { labels: number; sources: number; passages: number; tables?: number; results?: number };
  changes: { target: "label" | "source" | "passage" | "workspace" | "table" | "result"; id: string; sourceId?: string;
    field: string; before: unknown; after: unknown }[] };
export type ResearchProposal = Pick<ResearchChange, "id" | "title" | "createdAt" | "executor" | "model" | "counts">;
export type ResearchFileState = { schemaVersion: "beaver.research.v2";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  queries: ResearchPartReference | null; note: string; tables?: string[]; chats?: string[];
  proposals?: ResearchProposal[]; history?: ResearchPartReference };
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
/** Library readers without block anchors address the whole projection with kind `document`. */
export type PassageLocator = { kind: "paragraph" | "section" | "page" | "footnote" | "document";
  value: string; endValue?: string };
export type ResearchAction =
  | { type: "label"; id?: string; name: string; parentId?: string | null;
      color?: string | null; order?: number; scope?: "source" | "highlight" }
  | { type: "remove"; kind: "label" | "source"; id: string }
  | { type: "remove"; kind: "evidence"; id: string; sourceId: string }
  | { type: "source"; reference: ResearchSourceReference; labelIds?: string[]; note?: string }
  | { type: "annotate"; kind: "source"; id: string; labelIds?: string[]; note?: string }
  | { type: "annotate"; kind: "evidence"; id: string; sourceId: string;
      labelIds?: string[]; note?: string }
  | ({ type: "passage"; sourceId: string; labelIds?: string[] }
      & ({ revision: string; start: number; end: number } | { quote: string }))
  | ({ type: "label-selection"; assign: string[]; mode: "add" | "remove" | "replace" } & ResearchSelection)
  | { type: "accept" | "reject" | "undo"; changeId: string }
  | { type: "note"; markdown: string; expectedMarkdown?: string }
  /** One atomic research change: all of it commits, or none of it does. */
  | { type: "batch"; title: string; propose?: boolean; actions: ResearchAction[] };

/** Receipt inventory counts are not highlight counts. */
export const researchHighlightCount = (source: ResearchSource) =>
  Object.values(source.passages?.labelCounts ?? {}).reduce((sum, count) => sum + count, 0);

export const newResearchState = (): ResearchFileState => ({ schemaVersion: "beaver.research.v2",
  labels: {}, sources: {}, queries: null, note: "" });
export const researchMarkdown = (title: string, state = newResearchState()) =>
  `# ${title}\n\n0 sources · 0 passages · 0 saved searches\n\n` +
  `<!-- beaver-research:v2\n${JSON.stringify(state)}\n-->\n`;
export const isResearchDocument = (document: Document) =>
  document.file_type === "md" && document.filename.toLowerCase().endsWith(".research.md");
export const researchSourceKey = (value: ResearchSourceReference) => value.kind === "document"
  ? `document://${encodeURIComponent(value.id)}/version/${encodeURIComponent(value.versionId)}`
  : `source://${encodeURIComponent(value.provider)}/${encodeURIComponent(JSON.stringify(value.provider === "a2aj"
      ? [value.id, value.kind === "legislation" ? "laws" : "cases", value.collection ?? "", value.language ?? "en"]
      : [value.id, value.kind, value.family ?? "", value.part ?? "",
        value.collection === value.provider ? "" : value.collection ?? "", value.language ?? "en"]))}`;
export function researchLabelPath(labels: Record<string, ResearchLabel>, id: string) {
  const path: ResearchLabel[] = [], seen = new Set<string>();
  let label: ResearchLabel | undefined = labels[id];
  while (label && !seen.has(label.id)) {
    path.unshift(label); seen.add(label.id);
    label = label.parentId ? labels[label.parentId] : undefined;
  }
  return path;
}
export const legalSourceViewerHref = (reference: ResearchSourceReference, research?: {
  fileId: string; sourceId: string }) => `/sources/view?${new URLSearchParams({
    provider: reference.provider, citation: reference.citation ?? reference.id,
    source_id: reference.id, doc_type: reference.kind === "legislation" ? "laws"
      : reference.kind === "journal" ? "articles" : reference.kind === "hansard" ? "hansard" : "cases",
    language: reference.language ?? "en", ...(reference.collection ? {
      dataset: reference.collection } : {}), ...(research ? {
      research_file: research.fileId, research_source: research.sourceId } : {}),
  })}`;
