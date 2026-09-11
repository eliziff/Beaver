import { z } from "zod";
import { legalSourceReferenceSchema, type LegalSourceReference } from "./legalSources/reference";
import { researchFindingReferenceSchema } from "./researchFindingReference";
const counts = z.object({ labels: z.number().int().nonnegative(), sources: z.number().int().nonnegative(),
  passages: z.number().int().nonnegative(), tables: z.number().int().nonnegative().optional(),
  results: z.number().int().nonnegative().optional() }).strict();
export const researchChangeSummarySchema = z.object({ id: z.string().uuid(), title: z.string().min(1).max(200),
  createdAt: z.string().datetime(), executor: z.enum(["human", "assistant"]), model: z.string().optional(), counts }).strict();
type ResearchChangeSummary = z.infer<typeof researchChangeSummarySchema>;

export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null; order: number; scope: "source" | "highlight";
  definition?: string };
export type ResearchPartReference = { count: number; sha256: string };
export type ResearchSourceReference = LegalSourceReference | {
  provider: "library"; kind: "document"; id: string; versionId: string;
  title?: string | null; citation?: string | null; date?: string | null;
  alternateCitation?: string | null;
  collection?: string | null; language?: "en" | "fr"; url?: string | null;
  family?: never; part?: never;
};
const source = z.union([legalSourceReferenceSchema, z.object({
  provider: z.literal("library"), kind: z.literal("document"), id: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200), title: z.string().max(2_000).nullable().optional(),
  citation: z.string().max(2_000).nullable().optional(), date: z.string().max(200).nullable().optional(),
  alternateCitation: z.string().max(2_000).nullable().optional(),
  collection: z.string().max(200).nullable().optional(), language: z.enum(["en", "fr"]).optional(),
  url: z.string().max(4_000).nullable().optional(),
}).strict()]);
export { source as researchSourceReferenceSchema };
/** Sources encountered while reading stay in the receipt registry until deliberately collected. */
export type ResearchSource = { id: string; reference: ResearchSourceReference; collected?: boolean;
  labelIds: string[]; note: string;
  passages: (ResearchPartReference & { labelCounts: Record<string, number>;
    unlabelledCount: number }) | null };
export type ResearchFileState = { schemaVersion: "beaver.research.v2";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  queries: ResearchPartReference | null; note: string; tables?: string[]; chats?: string[];
  history?: ResearchPartReference; proposals?: ResearchChangeSummary[] };
const uuid = z.string().uuid(), text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(uuid).max(10_000).transform((values) => [...new Set(values)]);
const offset = z.number().int().min(0).max(50_000_000);
export const researchMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("label"), id: uuid.optional(), name: text(200),
    parentId: uuid.nullable().optional(), color: z.string().regex(/^#[a-f0-9]{6}$/iu)
      .nullable().optional(), order: z.number().min(-1_000_000).max(1_000_000).optional(),
    scope: z.enum(["source", "highlight"]).optional(), definition: z.string().trim().max(20_000).optional() }).strict(),
  z.object({ type: z.literal("remove"), kind: z.enum(["label", "source", "evidence"]),
    id: text(200), sourceId: uuid.optional() }).strict(),
  z.object({ type: z.literal("source"), reference: source, labelIds: ids.optional(),
    note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("annotate"), kind: z.enum(["source", "evidence"]), id: text(200),
    sourceId: uuid.optional(), labelIds: ids.optional(),
    note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("passage"), sourceId: uuid, revision: text(200),
    start: offset, end: offset,
    labelIds: ids.optional() }).strict(),
  z.object({ type: z.literal("label-selection"), findingRefs: z.array(researchFindingReferenceSchema).max(500).optional(), target: z.enum(["sources", "passages"]),
    sourceIds: ids.optional(), evidenceIds: z.array(text(200)).max(100_000).optional(),
    members: z.array(z.object({ sourceId: uuid, evidenceIds: z.array(text(200)).max(100_000).optional() }).strict()).max(100_000).optional(),
    labelIds: ids.optional(), unlabelled: z.boolean().optional(), assign: ids,
    mode: z.enum(["add", "remove", "replace"]) }).strict(),
  z.object({ type: z.literal("note"), markdown: z.string().max(250_000), expectedMarkdown: z.string().max(250_000).optional() }).strict(),
]).superRefine((action, context) => {
  if (action.type === "label-selection" && action.target === "sources" && action.mode === "replace")
    context.addIssue({ code: "custom", message: "Source filings are additive; name each removal with mode:remove" });
  if ((action.type === "annotate" || action.type === "remove") &&
      action.kind === "evidence" && !action.sourceId)
    context.addIssue({ code: "custom", message: "Evidence changes require sourceId" });
});
export const researchFileActionSchema = z.union([researchMutationSchema,
  z.object({ type: z.literal("batch"), title: text(200), propose: z.boolean().optional(),
    actions: z.array(researchMutationSchema.refine((action) =>
      action.type === "source" || action.type === "label" || action.type === "annotate" || action.type === "label-selection" ||
      action.type === "remove" && action.kind === "label", "Batch changes collect sources or organize labels and assignments"))
      .min(1).max(400) }).strict(),
  z.object({ type: z.enum(["accept", "reject", "undo"]), changeId: uuid }).strict(),
]);
export type PublicResearchFileAction = z.infer<typeof researchFileActionSchema>;

/** Providers whose documents are read directly; the rest carry attested or stored passages. */
export type DirectSourceProvider = "a2aj" | "courtlistener" | "tna" | "govuk-et" | "govinfo" | "hansard";
export type LegalSourceClass = "case" | "legislation" | "commentary";
export type LegalEvidenceReceipt = {
  evidence_id: string;
  provider: DirectSourceProvider | "citator" | "journal" | "library";
  jurisdiction: string;
  source_class: LegalSourceClass;
  stable_source_id: string;
  source_reference?: Pick<LegalSourceReference, "id" | "part" | "family">;
  source_sha256: string;
  scope: "document" | "passage";
  block_id: string;
  span?: { start: number; end: number };
  exact_span_sha256?: string;
  span_sha256: string;
  span_text: string | null;
  citation: string;
  target_citation?: string;
  name: string | null;
  dataset: string;
  language: "en" | "fr";
  version: string | null;
  external_url: string | null;
  locator: {
    kind: "document" | "paragraph" | "page" | "section" | "footnote" | "sheet" | "cell";
    label: string;
    sheet?: string;
    cells?: string;
  };
  resolver_version: "a2aj-inline-v1" | `${Exclude<DirectSourceProvider, "a2aj">}-span-v1` |
    "citator-analysis-v1" | "citator-noteup-v1" | "public-journal-v1" | "library-read-v1";
};
export type LegalResearchQueryReceipt = {
  query_id: string;
  call_id: string;
  tool: "search_sources" | "Read";
  executed_at: string;
  model: string;
  executor_version: "legal-source-search-v1" | "legal-source-pattern-v1";
  input: Record<string, unknown>;
  results: Array<
    | { rank: number; resource: string }
    | { rank: number; evidence_id: string }
  >;
};

/** No highlight label means an observation. One label means an intentional highlight of that type. */
export type ResearchEvidence = { receipt: LegalEvidenceReceipt; sourceId: string; highlightId?: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = LegalResearchQueryReceipt & { sourceIds: string[];
  matchedSourceIds: string[]; evidenceIds: string[]; failures: Array<{ sourceId: string; code: string }>;
  slots: Record<string, string[]>; sourceFingerprints?: Record<string, string[]>;
  sourceReferences?: Record<string, ResearchSourceReference>;
  labelPaths?: Record<string, string> };
/** The document is the store record on the server and the API document in the browser. */
export type ResearchFileOf<Document> = { document: Document; versionId: string;
  workingRevision: number; state: ResearchFileState };

const changeField = z.object({ target: z.enum(["label", "source", "passage", "workspace", "table", "result"]),
  id: z.string().min(1).max(200), sourceId: z.string().uuid().optional(),
  field: z.string().min(1).max(300), before: z.unknown(), after: z.unknown() }).strict();
export const researchChangeSchema = researchChangeSummarySchema.extend({ userId: z.string(),
  status: z.enum(["pending", "applied", "rejected"]), undoOf: z.string().uuid().optional(),
  resolvedBy: z.string().optional(), resolvedAt: z.string().datetime().optional(),
  changes: z.array(changeField).max(500_000) }).strict();
export type ResearchChangeField = z.infer<typeof changeField>;
export type ResearchChange = z.infer<typeof researchChangeSchema>;
export type { ResearchChangeSummary };
export type ResearchPageItem = { kind: "passage" | "evidence"; index: number; value: ResearchEvidence }
  | { kind: "query"; index: number; value: ResearchQueryReceipt }
  | { kind: "change"; index: number; value: ResearchChange };

const selectionIds = z.array(z.string().min(1).max(200)).max(100_000)
  .transform((values) => [...new Set(values)]);
export const researchSelectionSchema = z.object({ sourceIds: selectionIds.optional(), labelIds: selectionIds.optional(),
  findingRefs: z.array(researchFindingReferenceSchema).max(500).optional(),
  evidenceIds: selectionIds.optional(), target: z.enum(["sources", "passages"]), unlabelled: z.boolean().optional(),
  members: z.array(z.object({ sourceId: z.string().min(1).max(200), evidenceIds: selectionIds.optional() }).strict())
    .max(100_000).optional() }).strict();
export type ResearchSelection = z.infer<typeof researchSelectionSchema>;
