import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentRecord, DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { parseResourceReference, resourceReference, legalSourceResource } from "./resourceReferences";
import { legalEvidenceSourceReference, legalEvidenceResourceReference, type LegalEvidenceReceipt,
  storedLegalEvidenceReceipt, storedLegalResearchQueryReceipt,
  type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import { legalSourceReferenceSchema, type LegalSourceReference } from "./legalSources";
import { jsonRecord as record } from "./value";
import { recordResearchOperation,
  type ResearchOperationContext } from "./researchProvenance";
import { resolveResearchSelection } from "./researchSelection";
import { researchFindingReferenceSchema } from "./researchFindingReference";
import { RESEARCH_HISTORY_PART, readResearchHistory, researchChangeCounts, researchChangeSummary,
  researchChangeSummarySchema, researchStateChanges, assertResearchChangeBase,
  type ResearchChange, type ResearchChangeField, type ResearchChangeSummary } from "./researchHistory";
export { readResearchHistory } from "./researchHistory";

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
/** No highlight label means an observation. One label means an intentional highlight of that type. */
export type ResearchEvidence = { receipt: LegalEvidenceReceipt; sourceId: string; highlightId?: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = LegalResearchQueryReceipt & { sourceIds: string[];
  matchedSourceIds: string[]; evidenceIds: string[]; failures: Array<{ sourceId: string; code: string }>;
  slots: Record<string, string[]>; sourceFingerprints?: Record<string, string[]>;
  sourceReferences?: Record<string, ResearchSourceReference>;
  labelPaths?: Record<string, string> };
export const researchQueryReceipt = (receipt: LegalResearchQueryReceipt): ResearchQueryReceipt => ({
  sourceIds: [], matchedSourceIds: [], evidenceIds: receipt.results.flatMap((item) =>
    "evidence_id" in item ? [item.evidence_id] : []), failures: [], slots: {}, ...receipt,
});
export type ResearchFileState = { schemaVersion: "beaver.research.v2";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  queries: ResearchPartReference | null; note: string; tables?: string[]; chats?: string[];
  history?: ResearchPartReference; proposals?: ResearchChangeSummary[] };
export type ResearchFile = { document: DocumentRecord;
  versionId: string; workingRevision: number; state: ResearchFileState };
export type ResearchPageItem = { kind: "passage" | "evidence"; index: number; value: ResearchEvidence }
  | { kind: "query"; index: number; value: ResearchQueryReceipt }
  | { kind: "change"; index: number; value: ResearchChange };

const uuid = z.string().uuid(), text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(uuid).max(10_000).transform((values) => [...new Set(values)]);
const offset = z.number().int().min(0).max(50_000_000);
const researchMutationSchema = z.discriminatedUnion("type", [
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
  // A reader that renders the canonical text sends offsets in the revision it served; one that
  // renders the original file sends the text it captured instead.
  z.object({ type: z.literal("passage"), sourceId: uuid, revision: text(200).optional(),
    start: offset.optional(), end: offset.optional(), quote: text(50_000).optional(),
    labelIds: ids.optional() }).strict(),
  z.object({ type: z.literal("label-selection"), findingRefs: z.array(researchFindingReferenceSchema).max(500).optional(), target: z.enum(["sources", "passages"]),
    sourceIds: ids.optional(), evidenceIds: z.array(text(200)).max(100_000).optional(),
    members: z.array(z.object({ sourceId: uuid, evidenceIds: z.array(text(200)).max(100_000).optional() }).strict()).max(100_000).optional(),
    labelIds: ids.optional(), unlabelled: z.boolean().optional(), assign: ids,
    mode: z.enum(["add", "remove", "replace"]) }).strict(),
  z.object({ type: z.literal("note"), markdown: z.string().max(250_000), expectedMarkdown: z.string().max(250_000).optional() }).strict(),
]).superRefine((action, context) => {
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
export type ResearchFileAction = PublicResearchFileAction | { type: "merge";
  evidence?: LegalEvidenceReceipt[]; queries?: ResearchQueryReceipt[];
  sources?: ResearchSourceReference[]; labels?: Record<string, string[]>; tables?: string[]; chats?: string[] };

const SOURCE_PART = (id: string) => `source.${id}.json`, QUERIES_PART = "queries.json";
export const researchSourceKey = (value: ResearchSourceReference) => value.kind === "document"
  ? resourceReference.document(value.id, value.versionId) : legalSourceResource(value);
export const researchLabelPath = (state: ResearchFileState, id: string) => { const names: string[] = [], seen = new Set<string>();
  for (let next: ResearchLabel | undefined = state.labels[id]; next && !seen.has(next.id);
    next = next.parentId ? state.labels[next.parentId] : undefined) { names.unshift(next.name); seen.add(next.id); }
  return names.join(" / "); };
const queryLabelIds = (query: ResearchQueryReceipt) => new Set([
  ...(Array.isArray(query.input.label_ids) ? query.input.label_ids : []),
  ...(Array.isArray(query.input.rules) ? query.input.rules.flatMap((value) => {
    const rule = record(value); return typeof rule?.slot === "string" ? [rule.slot] : []; }) : []),
  ...Object.values(query.slots).flat(),
].filter((id): id is string => typeof id === "string"));
const sourceTuple = (value: string) => { try { const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : null; } catch { return null; } };
export const researchSourceResource = researchSourceKey;
export function researchReferenceFromEvidence(receipt: LegalEvidenceReceipt): ResearchSourceReference | null {
  const resource = legalEvidenceResourceReference(receipt), parsed = resource && parseResourceReference(resource);
  return parsed && parsed.kind === "document" ? { provider: "library", kind: "document",
    id: parsed.documentId, versionId: parsed.versionId, title: receipt.name ?? receipt.citation }
    : legalEvidenceSourceReference(receipt);
}
export const researchSourceFromResource = (value: string): LegalSourceReference | null => {
  const resource = parseResourceReference(value); if (resource?.kind !== "source") return null;
  const { provider, sourceId } = resource, tuple = sourceTuple(sourceId), kind = tuple?.[1];
  if (provider === "a2aj") {
    return typeof tuple?.[0] === "string" && (kind === "cases" || kind === "laws")
      ? { provider, id: tuple[0], citation: tuple[0], kind: kind === "laws" ? "legislation" : "case",
          collection: typeof tuple[2] === "string" && tuple[2] ? tuple[2] : null,
          ...((tuple[3] === "en" || tuple[3] === "fr") ? { language: tuple[3] } : {}) } : null; }
  if (typeof tuple?.[0] === "string" &&
      (kind === "case" || kind === "legislation" || kind === "journal" || kind === "hansard"))
    return { provider, id: tuple[0], kind,
      ...(typeof tuple[2] === "string" && tuple[2] ? { family: tuple[2] } : {}),
      ...(typeof tuple[3] === "string" && tuple[3] ? { part: tuple[3] } : {}),
      collection: typeof tuple[4] === "string" && tuple[4] ? tuple[4] : null,
      ...((tuple[5] === "en" || tuple[5] === "fr") ? { language: tuple[5] } : {}) };
  if (provider === "courtlistener-opinion") { const tuple = sourceTuple(sourceId);
    return tuple && Number.isSafeInteger(Number(tuple[0])) && Number.isSafeInteger(Number(tuple[1]))
      ? { provider: "courtlistener", id: String(tuple[0]), part: String(tuple[1]), kind: "case" }
      : null; }
  if (provider === "courtlistener") return Number.isSafeInteger(Number(sourceId)) && Number(sourceId) > 0
    ? { provider, id: sourceId, kind: "case" } : null;
  if (["tna", "govuk-et", "govinfo"].includes(provider)) return { provider, id: sourceId, kind: "case" };
  return provider === "journal" || provider === "hansard"
    ? { provider, id: sourceId, kind: provider } : null;
};
export const researchQuerySources = (queries: LegalResearchQueryReceipt[]) => [...new Map(queries
  .flatMap(({ results }) => results.flatMap((item) => "resource" in item
    ? researchSourceFromResource(item.resource) ?? [] : []))
  .map((reference) => [researchSourceKey(reference), reference])).values()];
const get = <T>(values: Record<string, T>, id: string, label: string) => {
  const value = values[id]; if (!value) throw new Error(`${label} not found.`); return value;
};
const validIds = (value: unknown, prefix = "") => Array.isArray(value) && value.length <= 10_000 &&
  new Set(value).size === value.length && value.every((id) =>
    typeof id === "string" && id.startsWith(prefix));
const validPart = (value: unknown, max: number) => { const item = record(value); return !!item &&
  Number.isInteger(item.count) && Number(item.count) > 0 && Number(item.count) <= max &&
  typeof item.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256); };
const validPassages = (value: unknown, labels: Record<string, unknown>) => { const item = record(value),
  counts = record(item?.labelCounts), count = Number(item?.count); return validPart(value, 100_000) &&
    !!counts && Object.keys(counts).length <= 10_000 && Object.entries(counts).every(([id, value]) =>
      uuid.safeParse(id).success && record(labels[id])?.scope === "highlight" &&
      Number.isInteger(value) && Number(value) > 0 && Number(value) <= count) &&
    Number.isInteger(item?.unlabelledCount) && Number(item?.unlabelledCount) >= 0 &&
    Number(item?.unlabelledCount) <= count; };
const checkedLabels = (state: ResearchFileState, values: string[], scope?: ResearchLabel["scope"]) => {
  if (values.some((id) => !state.labels[id] || scope && state.labels[id].scope !== scope))
    throw new Error("Label not found in this scope.");
  const unique = [...new Set(values)];
  if (scope === "highlight" && unique.length > 1)
    throw new ApplicationError(400, "Choose one highlight type for a passage");
  return unique;
};
/** The part count includes receipts; only typed selections count as saved highlights. */
export const researchHighlightCount = (source: ResearchSource) =>
  Object.values(source.passages?.labelCounts ?? {}).reduce((sum, count) => sum + count, 0);
const addSource = (state: ResearchFileState, reference: ResearchSourceReference,
  index?: Map<string, ResearchSource>) => {
  const parsed = source.safeParse(reference); if (!parsed.success) throw new Error("Invalid research source.");
  const key = researchSourceKey(parsed.data), found = index?.get(key) ?? (!index
    ? Object.values(state.sources).find((item) => researchSourceKey(item.reference) === key) : undefined);
  if (found) return found;
  const value: ResearchSource = { id: randomUUID(), reference: structuredClone(parsed.data),
    labelIds: [], collected: false, note: "", passages: null };
  state.sources[value.id] = value; index?.set(key, value); return value;
};

export const createResearchFileState = (): ResearchFileState => ({
  schemaVersion: "beaver.research.v2", labels: {}, sources: {}, queries: null, note: "",
});

function decodeResearchFileState(value: unknown): ResearchFileState | null {
  const state = record(value), labels = record(state?.labels), sources = record(state?.sources);
  if (state?.schemaVersion !== "beaver.research.v2" || !labels || !sources ||
      !(state.queries === null || validPart(state.queries, 10_000)) ||
      (state.tables !== undefined && !validIds(state.tables)) ||
      (state.chats !== undefined && !validIds(state.chats)) ||
      (state.history !== undefined && !validPart(state.history, 10_000)) ||
      (state.proposals !== undefined && !researchChangeSummarySchema.array().max(100).safeParse(state.proposals).success) ||
      typeof state.note !== "string" || state.note.length > 250_000 ||
      Object.keys(labels).length > 10_000 || Object.keys(sources).length > 10_000) return null;
  const validLabels = (value: unknown) => validIds(value) &&
    (value as string[]).every((id) => uuid.safeParse(id).success && labels[id]);
  if (Object.entries(labels).some(([id, value]) => { const item = record(value); return !item ||
      item.id !== id || !uuid.safeParse(id).success || typeof item.name !== "string" ||
      !item.name || item.name.length > 200 || !(item.parentId === null ||
        typeof item.parentId === "string" && uuid.safeParse(item.parentId).success) ||
      !(item.color === null || typeof item.color === "string" && /^#[a-f0-9]{6}$/iu.test(item.color)) ||
      !Number.isInteger(item.order) || Number(item.order) < 0 || Number(item.order) > 1_000_000 ||
      (item.definition !== undefined && (typeof item.definition !== "string" || item.definition.length > 20_000)) ||
      (item.scope !== "source" && item.scope !== "highlight"); })) return null;
  if (Object.values(labels).some((value) => { const parent = record(value)?.parentId;
    return typeof parent === "string" && (!labels[parent] ||
      record(labels[parent])?.scope !== record(value)?.scope); })) return null;
  const visitedLabels = new Set<string>();
  for (const id of Object.keys(labels)) { const seen = new Set<string>(); let next: string | null = id;
    while (next && !visitedLabels.has(next)) { if (seen.has(next)) return null; seen.add(next);
      next = record(labels[next])?.parentId as string | null; }
    seen.forEach((labelId) => visitedLabels.add(labelId)); }
  if (Object.entries(sources).some(([id, value]) => { const item = record(value); return !item ||
      item.id !== id || !uuid.safeParse(id).success || !source.safeParse(item.reference).success ||
      (item.collected !== undefined && typeof item.collected !== "boolean") ||
      !validLabels(item.labelIds) || (item.labelIds as string[]).some((labelId) =>
        record(labels[labelId])?.scope !== "source") || typeof item.note !== "string" ||
      item.note.length > 50_000 ||
      !(item.passages === null || validPassages(item.passages, labels));
    })) return null;
  if (Object.values(sources).reduce<number>((sum, value) =>
    sum + Number(record(record(value)?.passages)?.count ?? 0), 0) > 100_000) return null;
  return state as ResearchFileState;
}

const validQuery = (id: string, value: unknown) => { const item = record(value),
  receipt = storedLegalResearchQueryReceipt(item),
  sourceIds = new Set(Array.isArray(item?.sourceIds) ? item.sourceIds as string[] : []),
  evidenceIds = new Set(Array.isArray(item?.evidenceIds) ? item.evidenceIds as string[] : []);
  return !!item && !!receipt && receipt.query_id === id && validIds(item.sourceIds) &&
    (item.sourceIds as string[]).every((value) => uuid.safeParse(value).success) &&
    validIds(item.matchedSourceIds) && (item.matchedSourceIds as string[]).every((value) =>
      uuid.safeParse(value).success && sourceIds.has(value)) &&
    validIds(item.evidenceIds, "e_") &&
    (item.sourceFingerprints === undefined || !!record(item.sourceFingerprints) &&
      Object.entries(item.sourceFingerprints as Record<string, unknown>).every(([sourceId, hashes]) =>
        sourceIds.has(sourceId) && Array.isArray(hashes) && hashes.length <= 10_000 &&
        new Set(hashes).size === hashes.length && hashes.every((hash) =>
          typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)))) &&
    (item.sourceReferences === undefined || !!record(item.sourceReferences) &&
      Object.entries(item.sourceReferences as Record<string, unknown>).every(([sourceId, reference]) =>
        sourceIds.has(sourceId) && source.safeParse(reference).success)) &&
    (item.labelPaths === undefined || !!record(item.labelPaths) &&
      Object.keys(item.labelPaths as Record<string, unknown>).length <= 10_000 &&
      Object.entries(item.labelPaths as Record<string, unknown>).every(([labelId, path]) =>
        uuid.safeParse(labelId).success && typeof path === "string" && !!path.trim() && path.length <= 1_000)) &&
    !!record(item.slots) && Object.entries(item.slots as Record<string, unknown>).every(
      ([evidenceId, slots]) => evidenceIds.has(evidenceId) && Array.isArray(slots) && slots.length <= 100 &&
        slots.every((slot) => typeof slot === "string" && !!slot && slot.length <= 200)) &&
    Array.isArray(item.failures) && item.failures.length <= 10_000 && item.failures.every((failure) => {
      const row = record(failure); return !!row && typeof row.sourceId === "string" &&
        uuid.safeParse(row.sourceId).success && sourceIds.has(row.sourceId) &&
        typeof row.code === "string" && !!row.code &&
        row.code.length <= 200; }); };
const parseJson = (bytes: Buffer) => { try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { return null; } };
const decodeSourcePart = (bytes: Buffer, sourceId: string) => {
  const part = record(parseJson(bytes)), evidence = record(part?.evidence);
  if (part?.schemaVersion !== "beaver.research-source.v1" || part.sourceId !== sourceId || !evidence ||
      Object.keys(evidence).length > 100_000 || Object.entries(evidence).some(([id, value]) => {
        const item = record(value), receipt = storedLegalEvidenceReceipt(item?.receipt); return !item ||
          !receipt || (item.highlightId ?? receipt.evidence_id) !== id ||
          (item.highlightId !== undefined && (typeof item.highlightId !== "string" ||
            !item.highlightId.startsWith(`${receipt.evidence_id}:`) || item.highlightId.length > 200)) ||
          item.sourceId !== sourceId || !validIds(item.labelIds) ||
          (item.labelIds as string[]).length > 1 || !(item.labelIds as string[]).every((label) => uuid.safeParse(label).success) ||
          typeof item.note !== "string" || item.note.length > 50_000; })) return null;
  return evidence as Record<string, ResearchEvidence>;
};
const decodeQueriesPart = (bytes: Buffer) => {
  const part = record(parseJson(bytes)), queries = record(part?.queries);
  return part?.schemaVersion === "beaver.research-queries.v1" && queries &&
    Object.keys(queries).length <= 10_000 && !Object.entries(queries).some(([id, value]) =>
      !validQuery(id, value)) ? queries as Record<string, ResearchQueryReceipt> : null;
};
const encodeSourcePart = (sourceId: string, evidence: Record<string, ResearchEvidence>) =>
  Buffer.from(JSON.stringify({ schemaVersion: "beaver.research-source.v1", sourceId, evidence }));
const passageFacets = (state: ResearchFileState, evidence: Record<string, ResearchEvidence>) => {
  const labelCounts: Record<string, number> = {}; let unlabelledCount = 0;
  Object.values(evidence).forEach(({ labelIds }) => { const valid = labelIds.filter((id) =>
    state.labels[id]?.scope === "highlight"); if (!valid.length) unlabelledCount++;
    valid.forEach((id) => { labelCounts[id] = (labelCounts[id] ?? 0) + 1; }); });
  return { labelCounts, unlabelledCount };
};
const encodeQueriesPart = (queries: Record<string, ResearchQueryReceipt>) =>
  Buffer.from(JSON.stringify({ schemaVersion: "beaver.research-queries.v1", queries }));
const corrupt = (): never => { throw new ApplicationError(409,
  "Research data changed or is unavailable.", { code: "revision_conflict" }); };

export function researchFileMarkdown(title: string, state: ResearchFileState) {
  let passages = 0, sources = 0;
  for (const item of Object.values(state.sources)) { if (item.collected) sources++; passages += researchHighlightCount(item); }
  const note = state.note.trim();
  return `# ${title.replace(/[\r\n#]/gu, " ").trim() || "Research"}\n\n` +
    `${sources} source${sources === 1 ? "" : "s"} · ${passages} passage${passages === 1 ? "" : "s"} · ` +
    `${state.queries?.count ?? 0} saved search${state.queries?.count === 1 ? "" : "es"}\n\n` +
    `${note ? `${note}\n\n` : ""}<!-- beaver-research:v2\n${JSON.stringify(state)}\n-->\n`;
}

export function parseResearchFile(value: Buffer | string) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value,
    marker = "<!-- beaver-research:v2\n", start = text.lastIndexOf(marker),
    end = text.indexOf("\n-->", start + marker.length);
  if (start < 0 || end <= start) return null;
  try { return decodeResearchFileState(JSON.parse(text.slice(start + marker.length, end))); }
  catch { return null; }
}

export async function readResearchFile(documents: DocumentStore, scope: ApplicationScope,
  documentId: string): Promise<ResearchFile | null> {
  const [document, file] = await Promise.all([
    documents.metadata(scope, documentId), documents.read(scope, documentId, null, false),
  ]), state = file?.fileType === "md" ? parseResearchFile(file.bytes) : null;
  if (!document || !file || !state || document.current_version_id !== file.version.id ||
      document.current_working_revision !== file.version.working_revision) return null;
  return { document: { ...document, filename: file.version.filename,
      file_type: file.version.file_type, size_bytes: file.version.size_bytes,
      source_sha256: file.version.source_sha256 }, versionId: file.version.id,
    workingRevision: file.version.working_revision, state };
}

const readEvidenceBatch = async (documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile, unique: string[]) => {
  const names = unique.filter((id) => get(file.state.sources, id, "Source").passages)
    .map(SOURCE_PART), parts = names.length ? await documents.readParts(
      scope, file.document.id, file.versionId, names) ?? corrupt() : [];
  const byName = new Map(parts.map((part) => [part.name, part]));
  return new Map(unique.map((sourceId) => { const ref = file.state.sources[sourceId].passages;
    if (!ref) return [sourceId, {}] as const;
    const part = byName.get(SOURCE_PART(sourceId)), evidence = part?.sha256 === ref.sha256
      ? decodeSourcePart(part.bytes, sourceId) : null;
    if (!evidence || Object.keys(evidence).length !== ref.count) corrupt();
    Object.values(evidence!).forEach((item) => { item.labelIds = item.labelIds.filter((id) =>
      file.state.labels[id]?.scope === "highlight"); });
    return [sourceId, evidence!] as const; }));
};

export async function visitResearchEvidenceParts(documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile, sourceIds: string[], visit: (
    batch: Map<string, Record<string, ResearchEvidence>>) => boolean | void | Promise<boolean | void>) {
  const read = async (ids: string[]): Promise<boolean> => {
    let batch: Map<string, Record<string, ResearchEvidence>>;
    try { batch = await readEvidenceBatch(documents, scope, file, ids); } catch (error) {
      if (!(error instanceof ApplicationError) || error.status !== 413 || ids.length < 2) throw error;
      const middle = Math.ceil(ids.length / 2);
      return await read(ids.slice(0, middle)) && await read(ids.slice(middle));
    }
    return await visit(batch) !== false;
  };
  const unique = [...new Set(sourceIds)];
  for (let at = 0; at < unique.length; at += 100)
    if (!await read(unique.slice(at, at + 100))) break;
}

export async function readResearchEvidenceParts(documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile, sourceIds: string[]) {
  const unique = [...new Set(sourceIds)];
  if (unique.length > 100) throw new Error("At most 100 research sources may be read at once.");
  const values = new Map<string, Record<string, ResearchEvidence>>();
  await visitResearchEvidenceParts(documents, scope, file, unique, (batch) =>
    batch.forEach((value, key) => values.set(key, value)));
  return values;
}

export async function readResearchQueries(documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile) {
  const ref = file.state.queries; if (!ref) return [];
  const parts = await documents.readParts(scope, file.document.id, file.versionId, [QUERIES_PART]),
    part = parts?.[0], queries = part?.sha256 === ref.sha256 ? decodeQueriesPart(part.bytes) : null;
  if (!queries || Object.keys(queries).length !== ref.count) corrupt();
  return Object.values(queries!);
}

export async function pageResearchItems(documents: DocumentStore, scope: ApplicationScope,
  file: ResearchFile, kind: "passages" | "evidence" | "queries" | "history", offset = 0, limit = 50,
  sourceIds?: string[]) {
  offset = Math.max(0, Math.trunc(offset)); limit = Math.max(1, Math.min(200, Math.trunc(limit)));
  if (kind === "history") { const values = (await readResearchHistory(documents, scope, file)).reverse(), total = values.length;
    return { items: values.slice(offset, offset + limit).map((value, index): ResearchPageItem =>
      ({ kind: "change", index: offset + index, value })), total,
      nextOffset: offset + limit < total ? offset + limit : null }; }
  if (kind === "queries") { const total = file.state.queries?.count ?? 0,
    values = offset < total ? (await readResearchQueries(documents, scope, file)).reverse() : [];
    return { items: values.slice(offset, offset + limit).map((value, index): ResearchPageItem =>
      ({ kind: "query", index: offset + index, value })), total,
      nextOffset: offset + limit < total ? offset + limit : null }; }
  const countItems = (item: ResearchSource) => kind === "evidence" ? item.passages?.count ?? 0 : researchHighlightCount(item);
  const sources = (sourceIds ?? Object.keys(file.state.sources)).map((id) =>
    get(file.state.sources, id, "Source")), total = sources.reduce((sum, item) =>
      sum + countItems(item), 0), items: ResearchPageItem[] = [];
  let skip = offset, available = 0;
  const selected: Array<{ source: ResearchSource; skip: number }> = [];
  for (const source of sources) { const count = countItems(source);
    if (skip >= count) { skip -= count; continue; }
    selected.push({ source, skip }); available += count - skip; skip = 0;
    if (available >= limit) break;
  }
  const skips = new Map(selected.map(({ source, skip }) => [source.id, skip]));
  await visitResearchEvidenceParts(documents, scope, file, selected.map(({ source }) => source.id),
    (batch) => { for (const [sourceId, evidence] of batch) {
      const take = Object.values(evidence).filter((item) => kind === "evidence" || item.labelIds.length > 0).slice(skips.get(sourceId),
        (skips.get(sourceId) ?? 0) + limit - items.length), base = items.length;
      items.push(...take.map((value, index) => ({ kind: kind === "evidence" ? "evidence" as const : "passage" as const,
        index: offset + base + index, value })));
      if (items.length === limit) return false;
    } });
  return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
}

const applyLabel = (state: ResearchFileState, action: Extract<PublicResearchFileAction,
  { type: "label" }>) => {
  const id = action.id ?? randomUUID(), previous = state.labels[id],
    scope = action.scope ?? previous?.scope ?? "source",
    parentId = action.parentId === undefined ? previous?.parentId ?? null : action.parentId;
  if (previous && previous.scope !== scope) throw new Error("A label's scope cannot change.");
  if (parentId && get(state.labels, parentId, "Parent label").scope !== scope)
    throw new Error("Parent labels must share a scope.");
  const ancestors = new Set<string>();
  for (let parent = parentId; parent; parent = state.labels[parent]?.parentId) {
    if (parent === id || ancestors.has(parent)) throw new Error("A label cannot contain itself.");
    ancestors.add(parent);
  }
  const siblings = Object.values(state.labels).filter((label) => label.parentId === parentId &&
    label.scope === scope && label.id !== id);
  state.labels[id] = { id, name: action.name, parentId, scope,
    definition: action.definition ?? previous?.definition ?? "",
    color: scope === "highlight" ? action.color ?? previous?.color ??
      ["#d6b85a", "#86a5b6", "#93ab87", "#c49b9b"][Object.values(state.labels).filter((label) => label.scope === "highlight").length % 4]
      : action.color === undefined ? previous?.color ?? null : action.color,
    order: action.order ?? previous?.order ?? Math.max(-1, ...siblings.map(({ order }) => order)) + 1 };
  const normalize = (parent: string | null) => Object.values(state.labels)
    .filter((label) => label.parentId === parent && label.scope === scope)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .forEach((label, order) => { label.order = order; });
  normalize(parentId); if (previous && previous.parentId !== parentId) normalize(previous.parentId);
  return id;
};

export async function saveResearchFile(documents: DocumentStore, scope: ApplicationScope,
  documentId: string, expectedVersionId: string, expectedWorkingRevision: number,
  action: ResearchFileAction, assistant?: { turnVersionId?: string; turnId?: string },
  context?: ResearchOperationContext) {
  const current = await readResearchFile(documents, scope, documentId);
  return !current || current.versionId !== expectedVersionId ||
    current.workingRevision !== expectedWorkingRevision ? null
    : commitResearchFile(documents, scope, current, action, assistant, context);
}

export async function commitResearchFile(documents: DocumentStore, scope: ApplicationScope,
  current: ResearchFile, raw: ResearchFileAction,
  assistant?: { turnVersionId?: string; turnId?: string },
  context?: ResearchOperationContext): Promise<ResearchFile | null> {
  let state: ResearchFileState = { ...current.state };
  const request = raw.type === "merge" ? raw : researchFileActionSchema.parse(raw),
    executor = context?.executor ?? (assistant ? "assistant" : "human"),
    actions = request.type === "batch" ? request.actions :
      request.type === "accept" || request.type === "reject" || request.type === "undo" ? [] : [request],
    loaded = new Map<string, Record<string, ResearchEvidence>>(), originalEvidence: Record<string, ResearchEvidence> = {},
    puts: Array<{ name: string; bytes: Buffer; expectedSha256: string }> = [], removes: string[] = [];
  const ownLabels = () => state.labels === current.state.labels
    ? state.labels = structuredClone(state.labels) : state.labels;
  const ownSources = () => state.sources === current.state.sources
    ? state.sources = { ...state.sources } : state.sources;
  const ownSource = (id: string) => { const sources = ownSources(), item = get(sources, id, "Source");
    if (item === current.state.sources[id]) sources[id] = { ...item, labelIds: [...item.labelIds] };
    return sources[id]; };
  let passageDelta = 0;
  if (request.type === "merge" && ((request.sources?.length ?? 0) > 10_000 ||
      (request.evidence?.length ?? 0) > 100_000 || (request.queries?.length ?? 0) > 10_000 ||
      request.sources?.some((value) => !source.safeParse(value).success) ||
      request.evidence?.some((value) => !storedLegalEvidenceReceipt(value))))
    throw new ApplicationError(400, "Research file limits exceeded");
  let queries: Record<string, ResearchQueryReceipt> | undefined;
  const loadQueries = async () => queries ??= Object.fromEntries((await readResearchQueries(
    documents, scope, current)).map((value) => [value.query_id, value]));
  const loadSources = async (sourceIds: string[]) => {
    const unique = [...new Set(sourceIds)].filter((id) => !loaded.has(id));
    for (let at = 0; at < unique.length; at += 100) { const batch = unique.slice(at, at + 100),
      existing = batch.filter((id) => current.state.sources[id]), parts =
        await readResearchEvidenceParts(documents, scope, current, existing);
      batch.forEach((id) => { const evidence = parts.get(id) ?? {}; loaded.set(id, evidence);
        Object.entries(evidence).forEach(([id, item]) => { originalEvidence[id] = structuredClone(item); }); }); }
  };
  const clearPart = (name: string) => {
    for (let index = puts.length - 1; index >= 0; index--) if (puts[index].name === name) puts.splice(index, 1);
    for (let index = removes.length - 1; index >= 0; index--) if (removes[index] === name) removes.splice(index, 1);
  };
  const writeSource = (sourceId: string) => { const evidence = loaded.get(sourceId)!, item =
    ownSource(sourceId), previous = item.passages?.count ?? 0,
    count = Object.keys(evidence).length, name = SOURCE_PART(sourceId);
    clearPart(name);
    passageDelta += count - previous;
    if (count > 100_000) throw new ApplicationError(400, "Research file limits exceeded");
    if (!count) { if (item.passages) removes.push(name); item.passages = null; return; }
    const bytes = encodeSourcePart(sourceId, evidence), digest = sha256(bytes);
    if (!decodeSourcePart(bytes, sourceId)) throw new ApplicationError(400, "Invalid saved passage");
    item.passages = { count, sha256: digest, ...passageFacets(state, evidence) };
    if (current.state.sources[sourceId]?.passages?.sha256 !== digest)
      puts.push({ name, bytes, expectedSha256: digest });
  };
  const writeQueries = () => { if (!queries) return; const count = Object.keys(queries).length;
    clearPart(QUERIES_PART);
    if (count > 10_000) throw new ApplicationError(400, "Research file limits exceeded");
    if (!count) { if (state.queries) removes.push(QUERIES_PART); state.queries = null; return; }
    const bytes = encodeQueriesPart(queries), digest = sha256(bytes); state.queries = { count, sha256: digest };
    if (current.state.queries?.sha256 !== digest)
      puts.push({ name: QUERIES_PART, bytes, expectedSha256: digest });
  };
  const defaultHighlight = () => {
    const existing = Object.values(state.labels).find((label) =>
      label.scope === "highlight" && label.parentId === null && label.name === "Highlight");
    if (existing) return existing.id;
    ownLabels(); return applyLabel(state, { type: "label", name: "Highlight", scope: "highlight", color: "#d6b85a" });
  };
  const fileHighlight = (values: Record<string, ResearchEvidence>, item: ResearchEvidence, assigned: string[]) => {
    if (assigned.length && (item.receipt.scope !== "passage" || !item.receipt.span_text))
      throw new ApplicationError(400, "Highlighting requires an exact supporting passage");
    if (!assigned.length || Object.values(values).some((saved) => saved.receipt.evidence_id === item.receipt.evidence_id &&
      saved.labelIds[0] === assigned[0])) return;
    if (!item.labelIds.length) { item.labelIds = assigned; return; }
    const highlightId = `${item.receipt.evidence_id}:${randomUUID()}`;
    values[highlightId] = { ...item, highlightId, labelIds: assigned };
  };
  for (const action of actions) {
  if (action.type === "label") { ownLabels(); applyLabel(state, action); }
  else if (action.type === "note") {
    if (action.expectedMarkdown !== undefined && action.expectedMarkdown !== state.note && action.markdown !== state.note)
      throw new ApplicationError(409, "The memo changed elsewhere. Your draft has been kept; reload the saved memo before editing it again.", { code: "memo_conflict" });
    state.note = action.markdown;
  }
  else if (action.type === "source") {
    if (action.reference.kind === "document" && !await documents.projectionSource(scope,
      action.reference.id, action.reference.versionId)) throw new ApplicationError(404, "Document version not found");
    ownSources(); const item = ownSource(
    addSource(state, action.reference).id); item.collected = true;
    if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "source");
    if (action.note !== undefined) item.note = action.note;
  } else if (action.type === "label-selection") {
    const selectionDocuments = { ...documents, readParts: async (...args: Parameters<DocumentStore["readParts"]>) => {
      const staged = new Map([...loaded].map(([id, values]) => { const bytes = encodeSourcePart(id, values);
        return [SOURCE_PART(id), { name: SOURCE_PART(id), bytes, sha256: sha256(bytes) }] as const; })),
        saved = await documents.readParts(args[0], args[1], args[2], args[3].filter((name) => !staged.has(name)));
      return [...(saved ?? []), ...args[3].flatMap((name) => staged.get(name) ?? [])];
    } };
    const { type: _type, assign: _assign, mode: _mode, ...selected } = action,
      selection = await resolveResearchSelection(selectionDocuments, scope,
      { ...selected, researchFileId: current.document.id }, { ...current, state }), assigned =
      checkedLabels(state, action.assign, action.target === "sources" ? "source" : "highlight"),
      update = (existing: string[]) => action.mode === "replace" ? assigned
        : action.mode === "remove" ? existing.filter((id) => !assigned.includes(id))
          : action.target === "passages" ? assigned.length ? assigned : existing : [...new Set([...existing, ...assigned])];
    if (action.target === "sources") for (const subject of selection.subjects) {
      const source = ownSource(subject.sourceId); source.collected = true;
      source.labelIds = update(source.labelIds);
    }
    else {
      await loadSources(selection.subjects.map(({ sourceId }) => sourceId));
      for (const subject of selection.subjects) {
        const values = loaded.get(subject.sourceId)!, receipts = new Set(subject.evidence?.map(({ evidence_id }) => evidence_id));
        for (const item of Object.values(values).filter(({ receipt }) => !subject.evidence || receipts.has(receipt.evidence_id))) {
          if (action.mode === "add") fileHighlight(values, item, assigned);
          else if (!action.labelIds?.length || item.labelIds.some((id) => action.labelIds!.includes(id))) item.labelIds = update(item.labelIds);
          if (item.labelIds.length) ownSource(subject.sourceId).collected = true;
        }
        writeSource(subject.sourceId);
      }
    }
  } else if (action.type === "annotate" && action.kind === "source") {
    const item = ownSource(action.id); item.collected = true;
    if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "source");
    if (action.note !== undefined) item.note = action.note;
  } else if ((action.type === "annotate" || action.type === "remove") && action.kind === "evidence") {
    const sourceId = action.sourceId!; get(state.sources, sourceId, "Source"); await loadSources([sourceId]);
    const item = get(loaded.get(sourceId)!, action.id, "Evidence");
    if (action.type === "remove") { item.labelIds = []; item.note = ""; }
    else { if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "highlight");
      if (action.note !== undefined) item.note = action.note;
      if (item.labelIds.length) ownSource(sourceId).collected = true; }
    writeSource(sourceId);
  } else if (action.type === "remove" && action.kind === "source") {
    const removed = ownSource(action.id); removed.collected = false; removed.labelIds = [];
    await loadSources([action.id]);
    for (const item of Object.values(loaded.get(action.id)!)) item.labelIds = [];
    writeSource(action.id);
  } else if (action.type === "remove" && action.kind === "label") {
    ownLabels(); get(state.labels, action.id, "Label"); const children = new Map<string, string[]>(),
      removed = new Set([action.id]), ledger = await loadQueries();
    Object.values(state.labels).forEach((label) => { if (label.parentId)
      (children.get(label.parentId) ?? children.set(label.parentId, []).get(label.parentId)!).push(label.id); });
    for (const id of removed) (children.get(id) ?? []).forEach((child) => removed.add(child));
    Object.values(ledger).forEach((query) => queryLabelIds(query).forEach((id) => {
      if (removed.has(id)) (query.labelPaths ??= {})[id] ??= researchLabelPath(state, id); }));
    const updatePassageFacets = state.labels[action.id].scope === "highlight";
    removed.forEach((id) => delete state.labels[id]); Object.values(state.sources).forEach((item) => {
      const labelIds = item.labelIds.filter((id) => !removed.has(id));
      if (labelIds.length !== item.labelIds.length) ownSource(item.id).labelIds = labelIds;
    });
    if (updatePassageFacets) { const sourceIds = Object.values(state.sources)
      .filter(({ passages }) => passages && Object.keys(passages.labelCounts).some((id) => removed.has(id)))
      .map(({ id }) => id); await loadSources(sourceIds);
      sourceIds.forEach((id) => { Object.values(loaded.get(id)!).forEach((item) => {
        if (item.labelIds.some((labelId) => removed.has(labelId))) item.labelIds = [defaultHighlight()]; }); writeSource(id); }); }
    writeQueries();
  } else if (action.type === "passage") throw new Error("Passages must be verified before saving.");
  else if (action.type === "merge") {
    ownSources();
    const sourceByKey = new Map(Object.values(state.sources).map((item) =>
      [researchSourceKey(item.reference), item]));
    action.sources?.forEach((reference) => { ownSource(addSource(state, reference, sourceByKey).id).collected = true; });
    // Search results are observations, not additions to the research collection.
    researchQuerySources(action.queries ?? []).forEach((reference) => addSource(state, reference, sourceByKey));
    const evidence = (action.evidence ?? []).map((receipt) => { const reference =
      researchReferenceFromEvidence(receipt); if (!reference) return null;
      const source = ownSource(addSource(state, reference, sourceByKey).id);
      source.reference = { ...source.reference,
        title: source.reference.title ?? reference.title,
        citation: source.reference.citation ?? reference.citation,
        date: source.reference.date ?? reference.date, url: source.reference.url ?? reference.url };
      if (source.reference.kind !== "document" && reference.kind !== "document")
        source.reference.alternateCitation ??= reference.alternateCitation;
      sourceByKey.set(researchSourceKey(reference), source); return { receipt, source }; }).filter(
        (value): value is { receipt: LegalEvidenceReceipt; source: ResearchSource } => !!value);
    if (Object.keys(state.sources).length > 10_000)
      throw new ApplicationError(400, "Research file limits exceeded");
    await loadSources(evidence.map(({ source }) => source.id));
    evidence.forEach(({ receipt, source }) => { const values = loaded.get(source.id)!,
      previous = values[receipt.evidence_id], explicit = action.labels?.[receipt.evidence_id],
      item = values[receipt.evidence_id] = { receipt: structuredClone(receipt), sourceId: source.id,
        labelIds: previous?.labelIds ?? [], note: previous?.note ?? "" };
      if (explicit !== undefined) fileHighlight(values, item,
        checkedLabels(state, explicit.length ? explicit : [defaultHighlight()], "highlight"));
      if (item.labelIds.length) ownSource(source.id).collected = true; });
    [...new Set(evidence.map(({ source }) => source.id))].forEach(writeSource);
    if (action.queries?.length) { const ledger = await loadQueries();
      const evidenceSources = new Map(evidence.map(({ receipt, source }) =>
        [receipt.evidence_id, source.id]));
      action.queries.forEach((query) => { const next = structuredClone(query);
        if (!validQuery(query.query_id, query))
          throw new ApplicationError(400, "Research query receipt is invalid");
        const mapped = new Map(query.sourceIds.map((id) => { const reference = query.sourceReferences?.[id],
          existing = state.sources[id], item = existing && (!reference || researchSourceKey(
            existing.reference) === researchSourceKey(reference)) ? existing
            : reference ? addSource(state, reference, sourceByKey) : null;
          if (!item) throw new ApplicationError(400, "Query belongs to another research file");
          return [id, item.id] as const; }));
        queryLabelIds(next).forEach((id) => { const path = researchLabelPath(state, id);
          if (path) (next.labelPaths ??= {})[id] ??= path; });
        const saved = researchQuerySources([query]).map((reference) =>
          addSource(state, reference, sourceByKey).id), matched = [...new Set([
            ...query.matchedSourceIds.map((id) => mapped.get(id)!),
            ...query.evidenceIds.flatMap((id) => evidenceSources.get(id) ?? []), ...saved])];
        next.sourceReferences = next.sourceReferences && Object.fromEntries(Object.entries(
          next.sourceReferences).map(([id, reference]) => [mapped.get(id)!, reference]));
        if (next.sourceFingerprints) { const fingerprints: Record<string, string[]> = {};
          Object.entries(next.sourceFingerprints).forEach(([id, hashes]) => { const key = mapped.get(id)!;
            fingerprints[key] = [...new Set([...(fingerprints[key] ?? []), ...hashes])]; });
          next.sourceFingerprints = fingerprints; }
        next.failures = next.failures.map((failure) => ({ ...failure,
          sourceId: mapped.get(failure.sourceId)! }));
        const value = { ...next, sourceIds: [...new Set([...mapped.values(), ...matched])],
          matchedSourceIds: matched };
        if (!validQuery(query.query_id, value))
          throw new ApplicationError(400, "Research query receipt is invalid");
        value.sourceReferences ??= {};
        for (const id of value.sourceIds) value.sourceReferences[id] ??= structuredClone(state.sources[id].reference);
        ledger[query.query_id] = value;
      }); writeQueries(); }
  }
  if (action.type === "merge") {
    if (action.tables?.length) state.tables = [...new Set([...(state.tables ?? []), ...action.tables])];
    if (action.chats?.length) state.chats = [...new Set([...(state.chats ?? []), ...action.chats])];
  }
  }
  const allEvidence = () => Object.fromEntries([...loaded.values()].flatMap((values) => Object.entries(values)));
  let history: ResearchChange[] | undefined;
  const loadHistory = async () => history ??= await readResearchHistory(documents, scope, current);
  const readField = (change: ResearchChangeField): unknown => {
    const item = change.target === "label" ? state.labels[change.id] : change.target === "source"
      ? state.sources[change.id] : change.target === "passage" ? loaded.get(change.sourceId ?? "")?.[change.id] : null;
    if (change.target === "workspace") {
      if (change.field === "note") return state.note;
      const [field, ...rest] = change.field.split(".");
      if (field === "tables" || field === "chats") return (state[field] ?? []).includes(rest.join("."));
    }
    if (change.field === "$") return item ?? null;
    if (change.target === "source" && change.field === "collected") return !!(item as ResearchSource | null)?.collected;
    if (change.field.startsWith("labelIds.")) return !!item && "labelIds" in item && item.labelIds.includes(change.field.slice(9));
    return item ? (item as Record<string, unknown>)[change.field] ?? null : null;
  };
  const applyField = (change: ResearchChangeField, value: unknown) => {
    const field = change.field;
    if ((change.target === "label" || change.target === "source") && !uuid.safeParse(change.id).success ||
        change.target === "passage" && (!change.id.startsWith("e_") || !uuid.safeParse(change.sourceId).success))
      throw new ApplicationError(400, "Invalid research change target");
    if (change.target === "workspace") {
      if (field === "note" && typeof value === "string") { state.note = value; return; }
      const [key, ...rest] = field.split(".");
      if ((key === "tables" || key === "chats") && typeof value === "boolean") {
        const id = rest.join("."); state[key] = value ? [...new Set([...(state[key] ?? []), id])]
          : (state[key] ?? []).filter((item) => item !== id); return;
      }
    }
    const values = change.target === "label" ? ownLabels() : change.target === "source" ? ownSources()
      : change.target === "passage" ? loaded.get(change.sourceId ?? "") : null;
    if (!values) throw new ApplicationError(409, "The affected item is unavailable");
    if (field === "$") {
      if (value === null) delete values[change.id];
      else values[change.id] = structuredClone(value) as never;
      return;
    }
    const item = change.target === "source" ? ownSource(change.id) : values[change.id];
    if (!item) throw new ApplicationError(409, "The affected item is unavailable");
    if (change.target === "passage" && field === "labelIds" && Array.isArray(value)) {
      (item as ResearchEvidence).labelIds = checkedLabels(state, value, "highlight");
    } else if (field.startsWith("labelIds.") && "labelIds" in item && typeof value === "boolean") {
      const id = field.slice(9);
      if (value && state.labels[id]?.scope !== (change.target === "source" ? "source" : "highlight"))
        throw new ApplicationError(409, "An affected label is unavailable");
      item.labelIds = value ? [...new Set([...item.labelIds, id])] : item.labelIds.filter((label) => label !== id);
    } else if ((change.target === "label" ? ["name", "definition", "parentId", "color", "order", "scope"]
      : change.target === "source" ? ["note", "collected"] : ["note"]).includes(field)) {
      if (value === null && field === "definition") delete (item as Record<string, unknown>)[field];
      else (item as Record<string, unknown>)[field] = structuredClone(value);
    } else throw new ApplicationError(400, "Invalid research change field");
  };
  let changes: ResearchChangeField[], selected: ResearchChange | undefined;
  if (request.type === "accept" || request.type === "reject" || request.type === "undo") {
    selected = (await loadHistory()).find(({ id }) => id === request.changeId);
    if (!selected || selected.status !== (request.type === "undo" ? "applied" : "pending"))
      throw new ApplicationError(409, "This change is no longer available");
    if (request.type !== "undo" && executor !== "human") throw new ApplicationError(403, "Review this proposal in the workspace");
    if (request.type === "reject") {
      selected.status = "rejected"; selected.resolvedBy = scope.userId; selected.resolvedAt = new Date().toISOString();
      changes = [];
    } else {
      await loadSources(selected.changes.flatMap((change) => change.target === "passage" && change.sourceId
        ? [change.sourceId] : change.target === "source" && change.field === "$" ? [change.id] : []));
      assertResearchChangeBase(selected.changes, readField, request.type === "undo");
      for (const change of selected.changes) applyField(change, request.type === "undo" ? change.before : change.after);
      for (const sourceId of loaded.keys()) {
        if (state.sources[sourceId]) writeSource(sourceId); else removes.push(SOURCE_PART(sourceId));
      }
      changes = request.type === "undo" ? selected.changes.map((change) =>
        ({ ...change, before: change.after, after: change.before }))
        : researchStateChanges(current.state, state, originalEvidence, allEvidence());
      if (request.type === "accept") { selected.status = "applied"; selected.changes = changes;
        selected.counts = researchChangeCounts(changes); selected.resolvedBy = scope.userId; selected.resolvedAt = new Date().toISOString(); }
    }
  } else changes = researchStateChanges(current.state, state, originalEvidence, allEvidence());
  if (changes.length && request.type !== "accept") {
    const pending = request.type === "batch" && request.propose === true,
      title = request.type === "batch" ? request.title : request.type === "undo" ? `Undo: ${selected!.title}`
        : request.type === "label" ? `Label: ${request.name}` : request.type === "label-selection" ? "Update classifications"
        : request.type === "note" ? "Update memo" : request.type === "merge" ? "Collect research" : "Update research";
    (await loadHistory()).push({ id: randomUUID(), title: title.slice(0, 200), createdAt: new Date().toISOString(),
      executor, userId: scope.userId, ...(context?.model && { model: context.model }), status: pending ? "pending" : "applied",
      ...(request.type === "undo" && { undoOf: request.changeId }), changes, counts: researchChangeCounts(changes) });
    if (pending) { state = { ...current.state }; puts.length = 0; removes.length = 0; }
  }
  if (history) {
    if (history.length > 10_000) throw new ApplicationError(400, "Research history limit reached");
    state.proposals = history.filter(({ status }) => status === "pending").map(researchChangeSummary);
    const bytes = Buffer.from(JSON.stringify(history)), digest = sha256(bytes);
    state.history = { count: history.length, sha256: digest };
    puts.push({ name: RESEARCH_HISTORY_PART, bytes, expectedSha256: digest });
  }
  if (Object.keys(state.labels).length > 10_000 || Object.keys(state.sources).length > 10_000 ||
      passageDelta > 0 && Object.values(current.state.sources).reduce((sum, item) =>
        sum + (item.passages?.count ?? 0), passageDelta) > 100_000)
    throw new ApplicationError(400, "Research file limits exceeded");
  if (!decodeResearchFileState(state)) throw new ApplicationError(409, "This change conflicts with the current research structure");
  const filename = current.document.filename, bytes = Buffer.from(researchFileMarkdown(
    filename.replace(/\.research\.md$/iu, ""), state)), remove = [...new Set(removes)];
  const auditOperation = async (updated: ResearchFile) => {
    if (context) { const observed = allEvidence();
      await recordResearchOperation(context, scope, current, updated, request,
        request.type === "batch" && request.propose ? [] : changes, (id) => observed[id] ?? originalEvidence[id]); }
  };
  if (!puts.length && !remove.length && sha256(bytes) === current.document.source_sha256) {
    await auditOperation(current); return current;
  }
  const uniquePuts = [...new Map(puts.map((part) => [part.name, part])).values()],
    parts = { put: uniquePuts, remove: remove.filter((name) => !uniquePuts.some((part) => part.name === name)) }, committed = assistant
      ? await documents.commitAssistantVersion(scope, current.document.id, {
        sourceVersionId: current.versionId, expectedWorkingRevision: current.workingRevision,
        turnVersionId: assistant.turnVersionId, turnId: assistant.turnId, filename,
        fileType: "md", bytes, edits: [], status: "pending", parts })
      : await documents.replaceVersion(scope, current.document.id, current.versionId,
        current.workingRevision, { filename, fileType: "md", bytes, parts }),
    version = committed.status === "committed" || committed.status === "replaced"
      ? committed.version : null;
  if (!version) return null;
  const updated: ResearchFile = { document: { ...current.document, current_version_id: version.id,
      current_working_revision: version.working_revision,
      active_version_number: version.version_number, filename: version.filename,
      file_type: version.file_type, size_bytes: version.size_bytes,
      source_sha256: version.source_sha256 }, versionId: version.id,
    workingRevision: version.working_revision, state };
  await auditOperation(updated);
  return updated;
}
