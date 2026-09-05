import type { Document } from "@/app/components/shared/types";

export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null; order: number; scope: "source" | "highlight" };
export type ResearchSourceReference = { provider: string; family?: string; id: string;
  part?: string; kind: "case" | "legislation" | "journal" | "hansard";
  title?: string | null; citation?: string | null; alternateCitation?: string | null;
  date?: string | null; collection?: string | null; language?: "en" | "fr";
  url?: string | null };
export type ResearchSource = { id: string; reference: ResearchSourceReference;
  labelIds: string[]; badge: string; badgeColor?: string; note: string;
  passages: (ResearchPartReference & { labelCounts: Record<string, number>;
    unlabelledCount: number }) | null };
export type ResearchEvidenceReceipt = { evidence_id: string; provider: string;
  stable_source_id: string; source_sha256: string; span_sha256: string;
  block_id: string; span_text: string | null; citation: string; name: string | null;
  external_url: string | null; locator: { kind: string; label: string } };
export type ResearchEvidence = { receipt: ResearchEvidenceReceipt; sourceId: string;
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
export type ResearchFileState = { schemaVersion: "beaver.research.v2";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  queries: ResearchPartReference | null; note: string };
export type ResearchFile = { document: Document; versionId: string;
  workingRevision: number; state: ResearchFileState };
export type ResearchQueryCoverage = { complete: boolean; next_after: string | null;
  attempted_sources: number; selected_sources: number };
export type ResearchQueryResult = { file: ResearchFile; receipt: ResearchQueryReceipt; coverage: ResearchQueryCoverage };
export type ResearchPageItem = { kind: "passage"; index: number; value: ResearchEvidence }
  | { kind: "query"; index: number; value: ResearchQueryReceipt };
export type ResearchActionResult = ResearchFile & { sourceId?: string; evidenceId?: string };
export type ResearchQueryInput = { text?: string; after?: string; syntax: "literal" | "terms";
  target: "sources" | "passages"; sourceIds?: string[]; labelIds?: string[];
  unlabelled?: boolean; limit?: number;
  rules?: Array<{ phrase: string; direction: "before" | "after";
    unit: "sentence" | "line" | "paragraph" | "chars"; chars?: number;
    slot: string }>; conflict?: "prompt" | "first" | "longer" | "shorter" | "append" };
export type ResearchAction =
  | { type: "label"; id?: string; name: string; parentId?: string | null;
      color?: string | null; order?: number; scope?: "source" | "highlight" }
  | { type: "remove"; kind: "label" | "source"; id: string }
  | { type: "remove"; kind: "evidence"; id: string; sourceId: string }
  | { type: "source"; reference: ResearchSourceReference; labelIds?: string[];
      badge?: string; badgeColor?: string; note?: string }
  | { type: "annotate"; kind: "source"; id: string; labelIds?: string[];
      badge?: string; badgeColor?: string; note?: string }
  | { type: "annotate"; kind: "evidence"; id: string; sourceId: string;
      labelIds?: string[]; note?: string }
  | { type: "passage"; sourceId: string; locator: { kind: "paragraph" | "section" | "page" | "footnote";
      value: string; endValue?: string }; quote: string }
  | { type: "note"; markdown: string };

export const newResearchState = (): ResearchFileState => ({ schemaVersion: "beaver.research.v2",
  labels: {}, sources: {}, queries: null, note: "" });
export const researchMarkdown = (title: string, state = newResearchState()) =>
  `# ${title}\n\n0 sources · 0 passages · 0 saved searches\n\n` +
  `<!-- beaver-research:v2\n${JSON.stringify(state)}\n-->\n`;
export const isResearchDocument = (document: Document) =>
  document.file_type === "md" && document.filename.toLowerCase().endsWith(".research.md");
export const researchSourceKey = (value: ResearchSourceReference) => JSON.stringify([
  value.provider, value.family ?? null, value.id, value.part ?? null, value.kind,
  value.collection === value.provider ? null : value.collection ?? null, value.language ?? "en",
]);
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
      : reference.kind === "journal" ? "articles" : "cases",
    language: reference.language ?? "en", ...(reference.collection ? {
      dataset: reference.collection } : {}), ...(research ? {
      research_file: research.fileId, research_source: research.sourceId } : {}),
  })}`;
