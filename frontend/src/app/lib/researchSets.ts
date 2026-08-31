import type { WorkProduct, WorkProductMetadata } from "@/app/lib/workProducts";

export type ResearchActor = { kind: "human" | "model"; id: string;
  origin?: { type: "chat"; chatId: string; messageIds?: string[];
    callId?: string } };
export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null };
export type ResearchSourceReference = { provider: string; family?: string; id: string;
  part?: string; kind: "case" | "legislation" | "journal" | "hansard";
  title?: string | null; citation?: string | null; alternateCitation?: string | null;
  date?: string | null; collection?: string | null; language?: "en" | "fr";
  url?: string | null };
export type ResearchSource = { id: string; reference: ResearchSourceReference;
  labelIds: string[]; note: string };
export type ResearchLocator = { kind: "paragraph" | "section" | "page" | "footnote";
  value: string; endValue?: string };
export type ResearchEvidenceReceipt = { evidence_id: string; provider: string;
  stable_source_id: string; source_sha256: string; span_sha256: string;
  block_id: string; span_text: string | null; citation: string; name: string | null;
  external_url: string | null; locator: { kind: string; label: string } };
export type ResearchEvidence = { receipt: ResearchEvidenceReceipt; sourceId: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = { query_id: string; call_id: string; tool: string;
  executed_at: string; model: string; input: Record<string, unknown>;
  sourceIds: string[]; evidenceIds: string[];
  failures: Array<{ sourceId: string; code: string }> };
export type ResearchSetState = { schemaVersion: "beaver.research-set.v1";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  evidence: Record<string, ResearchEvidence>; queries: Record<string, ResearchQueryReceipt>;
  memo: string; audit: Array<{ at: string; actor: ResearchActor;
    action: string; targets: string[] }> };
export type ResearchSetProduct = WorkProduct<ResearchSetState>;
export type ResearchSetMetadata = WorkProductMetadata;
export const researchSetMetadata = ({ state: _state, outputs: _outputs,
  ...metadata }: ResearchSetProduct): ResearchSetMetadata => metadata;
export type ResearchSetQueryResult = { product: ResearchSetProduct; queryId: string;
  counts: { attemptedSources: number; matchedSources: number; matches: number;
    failures: number }; failures: ResearchQueryReceipt["failures"] };
export type ResearchSetQueryInput = { text: string; syntax: "literal" | "terms";
  target: "sources" | "passages"; sourceIds?: string[]; labelIds?: string[]; limit?: number };
export type ResearchSetAction =
  | { type: "label"; id?: string; name: string; parentId?: string | null;
      color?: string | null }
  | { type: "remove"; kind: "label" | "source" | "evidence"; id: string }
  | { type: "source"; reference: ResearchSourceReference }
  | { type: "annotate"; kind: "source" | "evidence"; id: string;
      labelIds?: string[]; note?: string }
  | { type: "passage"; sourceId: string; locator: ResearchLocator; quote: string }
  | { type: "memo"; markdown: string };

export function researchLabelPath(labels: Record<string, ResearchLabel>, id: string) {
  const path: ResearchLabel[] = [], seen = new Set<string>();
  let label: ResearchLabel | undefined = labels[id];
  while (label && !seen.has(label.id)) {
    path.unshift(label); seen.add(label.id);
    label = label.parentId ? labels[label.parentId] : undefined;
  }
  return path;
}
export const researchSourceTitle = ({ reference }: ResearchSource) =>
  reference.title || reference.citation || reference.id;
export const legalSourceViewerHref = (reference: ResearchSourceReference, research?: {
  setId: string; sourceId: string }) => `/sources/view?${new URLSearchParams({
    provider: reference.provider, citation: reference.citation ?? reference.id,
    source_id: reference.id, doc_type: reference.kind === "legislation" ? "laws"
      : reference.kind === "journal" ? "articles" : "cases",
    language: reference.language ?? "en",
    ...(reference.collection ? { dataset: reference.collection } : {}),
    ...(research ? { research_set: research.setId, research_source: research.sourceId } : {}),
  })}`;
export const sourceMatchesLabel = (source: { labelIds: string[] }, selected: string | null,
  labels: Record<string, ResearchLabel>) => !selected || source.labelIds.some((id) =>
    researchLabelPath(labels, id).some((label) => label.id === selected));
