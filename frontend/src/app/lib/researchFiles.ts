import type { Document } from "@/app/components/shared/types";

export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null; order: number; scope: "source" | "highlight" };
export type ResearchSourceReference = { provider: string; family?: string; id: string;
  part?: string; kind: "case" | "legislation" | "journal" | "hansard";
  title?: string | null; citation?: string | null; alternateCitation?: string | null;
  date?: string | null; collection?: string | null; language?: "en" | "fr";
  url?: string | null };
export type ResearchSource = { id: string; reference: ResearchSourceReference;
  labelIds: string[]; badge: string; badgeColor?: string; note: string };
export type ResearchEvidenceReceipt = { evidence_id: string; provider: string;
  stable_source_id: string; source_sha256: string; span_sha256: string;
  block_id: string; span_text: string | null; citation: string; name: string | null;
  external_url: string | null; locator: { kind: string; label: string } };
export type ResearchEvidence = { receipt: ResearchEvidenceReceipt; sourceId: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = { query_id: string; call_id: string; tool: string;
  executed_at: string; model: string; input: Record<string, unknown>;
  sourceIds: string[]; evidenceIds: string[];
  failures: Array<{ sourceId: string; code: string }>; slots: Record<string, string[]> };
export type ResearchFileState = { schemaVersion: "beaver.research.v1";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  evidence: Record<string, ResearchEvidence>; queries: Record<string, ResearchQueryReceipt>;
  note: string };
export type ResearchFile = { document: Document; versionId: string; state: ResearchFileState };
export type ResearchQueryResult = { file: ResearchFile; queryId: string;
  counts: { attemptedSources: number; matchedSources: number; matches: number;
    failures: number }; failures: ResearchQueryReceipt["failures"] };
export type ResearchQueryInput = { text?: string; syntax: "literal" | "terms";
  target: "sources" | "passages"; sourceIds?: string[]; labelIds?: string[]; limit?: number;
  rules?: Array<{ phrase: string; direction: "before" | "after";
    unit: "sentence" | "line" | "paragraph" | "chars"; chars?: number;
    slot: string }>; conflict?: "prompt" | "first" | "longer" | "shorter" | "append" };
export type ResearchAction =
  | { type: "label"; id?: string; name: string; parentId?: string | null;
      color?: string | null; order?: number; scope?: "source" | "highlight" }
  | { type: "remove"; kind: "label" | "source" | "evidence"; id: string }
  | { type: "source"; reference: ResearchSourceReference }
  | { type: "annotate"; kind: "source" | "evidence"; id: string;
      labelIds?: string[]; badge?: string; badgeColor?: string; note?: string }
  | { type: "passage"; sourceId: string; locator: { kind: "paragraph" | "section" | "page" | "footnote";
      value: string; endValue?: string }; quote: string }
  | { type: "note"; markdown: string };

export const newResearchState = (): ResearchFileState => ({ schemaVersion: "beaver.research.v1",
  labels: {}, sources: {}, evidence: {}, queries: {}, note: "" });
export const researchMarkdown = (title: string, state = newResearchState()) =>
  `# ${title}\n\n0 sources · 0 passages · 0 saved searches\n\n` +
  `<!-- beaver-research:v1\n${JSON.stringify(state)}\n-->\n`;
export const isResearchDocument = (document: Document) =>
  document.file_type === "md" && document.filename.toLowerCase().endsWith(".research.md");
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
