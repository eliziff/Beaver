import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentRecord, DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { parseResourceReference, resourceReference } from "./resourceReferences";
import { legalEvidenceSourceReference, type LegalEvidenceReceipt,
  storedLegalEvidenceReceipt, storedLegalResearchQueryReceipt,
  type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import type { LegalSourceReference } from "./legalSources";
import { jsonRecord as record } from "./value";

export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null; order: number; scope: "source" | "highlight" };
export type ResearchPartReference = { count: number; sha256: string };
export type ResearchSource = { id: string; reference: LegalSourceReference;
  labelIds: string[]; badge: string; badgeColor?: string; note: string;
  passages: (ResearchPartReference & { labelCounts: Record<string, number>;
    unlabelledCount: number }) | null };
export type ResearchEvidence = { receipt: LegalEvidenceReceipt; sourceId: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = LegalResearchQueryReceipt & { sourceIds: string[];
  matchedSourceIds: string[]; evidenceIds: string[]; failures: Array<{ sourceId: string; code: string }>;
  slots: Record<string, string[]>; sourceFingerprints?: Record<string, string[]>;
  sourceReferences?: Record<string, LegalSourceReference>;
  labelPaths?: Record<string, string> };
export const researchQueryReceipt = (receipt: LegalResearchQueryReceipt): ResearchQueryReceipt => ({
  sourceIds: [], matchedSourceIds: [], evidenceIds: receipt.results.flatMap((item) =>
    "evidence_id" in item ? [item.evidence_id] : []), failures: [], slots: {}, ...receipt,
});
export type ResearchFileState = { schemaVersion: "beaver.research.v2";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  queries: ResearchPartReference | null; note: string };
export type ResearchFile = { document: DocumentRecord & { filename: string };
  versionId: string; workingRevision: number; state: ResearchFileState };
export type ResearchPageItem = { kind: "passage"; index: number; value: ResearchEvidence }
  | { kind: "query"; index: number; value: ResearchQueryReceipt };

const uuid = z.string().uuid(), text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(uuid).max(10_000).transform((values) => [...new Set(values)]);
const source = z.object({ provider: text(100), family: text(1_000).optional(), id: text(500),
  part: text(1_000).optional(), kind: z.enum(["case", "legislation", "journal", "hansard"]),
  title: text(1_000).nullable().optional(), citation: text(1_000).nullable().optional(),
  alternateCitation: text(1_000).nullable().optional(), date: text(1_000).nullable().optional(),
  collection: text(1_000).nullable().optional(), language: z.enum(["en", "fr"]).optional(),
  url: z.string().url().max(4_000).nullable().optional() }).strict();
const locator = z.object({ kind: z.enum(["paragraph", "section", "page", "footnote"]),
  value: text(500), endValue: text(500).optional() }).strict();
export const researchFileActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("label"), id: uuid.optional(), name: text(200),
    parentId: uuid.nullable().optional(), color: z.string().regex(/^#[a-f0-9]{6}$/iu)
      .nullable().optional(), order: z.number().min(-1_000_000).max(1_000_000).optional(),
    scope: z.enum(["source", "highlight"]).optional() }).strict(),
  z.object({ type: z.literal("remove"), kind: z.enum(["label", "source", "evidence"]),
    id: text(200), sourceId: uuid.optional() }).strict(),
  z.object({ type: z.literal("source"), reference: source, labelIds: ids.optional(),
    badge: z.string().trim().max(19).optional(), badgeColor: z.string().regex(/^#[a-f0-9]{6}$/iu).optional(),
    note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("annotate"), kind: z.enum(["source", "evidence"]), id: text(200),
    sourceId: uuid.optional(), labelIds: ids.optional(), badge: z.string().trim().max(19).optional(),
    badgeColor: z.string().regex(/^#[a-f0-9]{6}$/iu).optional(),
    note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("passage"), sourceId: uuid, locator,
    quote: text(50_000) }).strict(),
  z.object({ type: z.literal("note"), markdown: z.string().max(250_000) }).strict(),
]).superRefine((action, context) => {
  if (action.type === "annotate" && action.kind === "evidence" &&
      (action.badge !== undefined || action.badgeColor !== undefined))
    context.addIssue({ code: "custom", message: "Evidence annotations cannot have badges" });
  if ((action.type === "annotate" || action.type === "remove") &&
      action.kind === "evidence" && !action.sourceId)
    context.addIssue({ code: "custom", message: "Evidence changes require sourceId" });
});
export type PublicResearchFileAction = z.infer<typeof researchFileActionSchema>;
export type ResearchFileAction = PublicResearchFileAction | { type: "merge";
  evidence?: LegalEvidenceReceipt[]; queries?: ResearchQueryReceipt[];
  sources?: LegalSourceReference[]; labels?: Record<string, string[]> };

const SOURCE_PART = (id: string) => `source.${id}.json`, QUERIES_PART = "queries.json";
export const researchSourceKey = (value: LegalSourceReference) => JSON.stringify(
  [value.provider, value.family ?? null, value.id, value.part ?? null, value.kind,
    value.collection === value.provider ? null : value.collection ?? null, value.language ?? "en"]);
export const researchLabelPath = (state: ResearchFileState, id: string) => { const names: string[] = [];
  for (let next: ResearchLabel | undefined = state.labels[id]; next && names.length < 3;
    next = next.parentId ? state.labels[next.parentId] : undefined) names.unshift(next.name);
  return names.join(" / "); };
const queryLabelIds = (query: ResearchQueryReceipt) => new Set([
  ...(Array.isArray(query.input.label_ids) ? query.input.label_ids : []),
  ...(Array.isArray(query.input.rules) ? query.input.rules.flatMap((value) => {
    const rule = record(value); return typeof rule?.slot === "string" ? [rule.slot] : []; }) : []),
  ...Object.values(query.slots).flat(),
].filter((id): id is string => typeof id === "string"));
const sourceTuple = (value: string) => { try { const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : null; } catch { return null; } };
export const researchSourceResource = (source: LegalSourceReference) =>
  resourceReference.source(source.provider, source.provider === "a2aj" ? JSON.stringify([
    source.id, source.kind === "legislation" ? "laws" : "cases",
    source.collection ?? "", source.language ?? "en",
  ]) : JSON.stringify([source.id, source.kind, source.family ?? "", source.part ?? "",
    source.collection ?? "", source.language ?? "en"]));
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
  return [...new Set(values)];
};
const addSource = (state: ResearchFileState, reference: LegalSourceReference,
  index?: Map<string, ResearchSource>) => {
  const parsed = source.safeParse(reference); if (!parsed.success) throw new Error("Invalid research source.");
  const key = researchSourceKey(parsed.data), found = index?.get(key) ?? (!index
    ? Object.values(state.sources).find((item) => researchSourceKey(item.reference) === key) : undefined);
  if (found) return found;
  const value: ResearchSource = { id: randomUUID(), reference: structuredClone(parsed.data),
    labelIds: [], badge: "", badgeColor: "#666666", note: "", passages: null };
  state.sources[value.id] = value; index?.set(key, value); return value;
};

export const createResearchFileState = (): ResearchFileState => ({
  schemaVersion: "beaver.research.v2", labels: {}, sources: {}, queries: null, note: "",
});

function decodeResearchFileState(value: unknown): ResearchFileState | null {
  const state = record(value), labels = record(state?.labels), sources = record(state?.sources);
  if (state?.schemaVersion !== "beaver.research.v2" || !labels || !sources ||
      !(state.queries === null || validPart(state.queries, 10_000)) ||
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
      (item.scope !== "source" && item.scope !== "highlight"); })) return null;
  if (Object.values(labels).some((value) => { const parent = record(value)?.parentId;
    return typeof parent === "string" && (!labels[parent] ||
      record(labels[parent])?.scope !== record(value)?.scope); })) return null;
  for (const id of Object.keys(labels)) { const seen = new Set<string>(); let next: string | null = id;
    while (next) { if (seen.has(next) || seen.size === 3) return null; seen.add(next);
      next = record(labels[next])?.parentId as string | null; } }
  if (Object.entries(sources).some(([id, value]) => { const item = record(value); return !item ||
      item.id !== id || !uuid.safeParse(id).success || !source.safeParse(item.reference).success ||
      !validLabels(item.labelIds) || (item.labelIds as string[]).some((labelId) =>
        record(labels[labelId])?.scope !== "source") || typeof item.badge !== "string" ||
      item.badge.length > 19 || !(item.badgeColor === undefined || typeof item.badgeColor === "string" &&
        /^#[a-f0-9]{6}$/iu.test(item.badgeColor)) || typeof item.note !== "string" ||
      item.note.length > 50_000 || !(item.passages === null || validPassages(item.passages, labels));
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
          !receipt || receipt.evidence_id !== id || item.sourceId !== sourceId || !validIds(item.labelIds) ||
          !(item.labelIds as string[]).every((label) => uuid.safeParse(label).success) ||
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
  for (const item of Object.values(state.sources)) { sources++; passages += item.passages?.count ?? 0; }
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
  file: ResearchFile, kind: "passages" | "queries", offset = 0, limit = 50,
  sourceIds?: string[]) {
  offset = Math.max(0, Math.trunc(offset)); limit = Math.max(1, Math.min(200, Math.trunc(limit)));
  if (kind === "queries") { const total = file.state.queries?.count ?? 0,
    values = offset < total ? (await readResearchQueries(documents, scope, file)).reverse() : [];
    return { items: values.slice(offset, offset + limit).map((value, index): ResearchPageItem =>
      ({ kind: "query", index: offset + index, value })), total,
      nextOffset: offset + limit < total ? offset + limit : null }; }
  const sources = (sourceIds ?? Object.keys(file.state.sources)).map((id) =>
    get(file.state.sources, id, "Source")), total = sources.reduce((sum, item) =>
      sum + (item.passages?.count ?? 0), 0), items: ResearchPageItem[] = [];
  let skip = offset, available = 0;
  const selected: Array<{ source: ResearchSource; skip: number }> = [];
  for (const source of sources) { const count = source.passages?.count ?? 0;
    if (skip >= count) { skip -= count; continue; }
    selected.push({ source, skip }); available += count - skip; skip = 0;
    if (available >= limit) break;
  }
  const skips = new Map(selected.map(({ source, skip }) => [source.id, skip]));
  await visitResearchEvidenceParts(documents, scope, file, selected.map(({ source }) => source.id),
    (batch) => { for (const [sourceId, evidence] of batch) {
      const take = Object.values(evidence).slice(skips.get(sourceId),
        (skips.get(sourceId) ?? 0) + limit - items.length), base = items.length;
      items.push(...take.map((value, index) => ({ kind: "passage" as const,
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
  let depth = 1;
  for (let parent = parentId; parent; parent = state.labels[parent]?.parentId) {
    if (parent === id) throw new Error("A label cannot contain itself.");
    if (++depth > 3) throw new Error("Labels can be nested three levels deep.");
  }
  let height = 1;
  if (previous) for (const label of Object.values(state.labels)) { let parent = label.parentId, level = 1;
    while (parent && parent !== id && level < 3) { parent = state.labels[parent]?.parentId; level++; }
    if (parent === id) height = Math.max(height, level + 1); }
  if (depth + height > 4) throw new Error("Labels can be nested three levels deep.");
  const siblings = Object.values(state.labels).filter((label) => label.parentId === parentId &&
    label.scope === scope && label.id !== id);
  state.labels[id] = { id, name: action.name, parentId, scope,
    color: action.color === undefined ? previous?.color ?? null : action.color,
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
  action: ResearchFileAction, assistant?: { turnVersionId?: string; turnId?: string }) {
  const current = await readResearchFile(documents, scope, documentId);
  return !current || current.versionId !== expectedVersionId ||
    current.workingRevision !== expectedWorkingRevision ? null
    : commitResearchFile(documents, scope, current, action, assistant);
}

export async function commitResearchFile(documents: DocumentStore, scope: ApplicationScope,
  current: ResearchFile, raw: ResearchFileAction,
  assistant?: { turnVersionId?: string; turnId?: string }): Promise<ResearchFile | null> {
  const state: ResearchFileState = { ...current.state }, action = raw.type === "merge"
    ? raw : researchFileActionSchema.parse(raw), loaded = new Map<string, Record<string, ResearchEvidence>>(),
    puts: Array<{ name: string; bytes: Buffer; expectedSha256: string }> = [], removes: string[] = [];
  const ownLabels = () => state.labels === current.state.labels
    ? state.labels = structuredClone(state.labels) : state.labels;
  const ownSources = () => state.sources === current.state.sources
    ? state.sources = { ...state.sources } : state.sources;
  const ownSource = (id: string) => { const sources = ownSources(), item = get(sources, id, "Source");
    if (item === current.state.sources[id]) sources[id] = { ...item, labelIds: [...item.labelIds] };
    return sources[id]; };
  let passageDelta = 0;
  if (action.type === "merge" && ((action.sources?.length ?? 0) > 10_000 ||
      (action.evidence?.length ?? 0) > 100_000 || (action.queries?.length ?? 0) > 10_000 ||
      action.sources?.some((value) => !source.safeParse(value).success) ||
      action.evidence?.some((value) => !storedLegalEvidenceReceipt(value))))
    throw new ApplicationError(400, "Research file limits exceeded");
  let queries: Record<string, ResearchQueryReceipt> | undefined;
  const loadQueries = async () => queries ??= Object.fromEntries((await readResearchQueries(
    documents, scope, current)).map((value) => [value.query_id, value]));
  const loadSources = async (sourceIds: string[]) => {
    const unique = [...new Set(sourceIds)].filter((id) => !loaded.has(id));
    for (let at = 0; at < unique.length; at += 100) { const batch = unique.slice(at, at + 100),
      existing = batch.filter((id) => current.state.sources[id]), parts =
        await readResearchEvidenceParts(documents, scope, current, existing);
      batch.forEach((id) => loaded.set(id, parts.get(id) ?? {})); }
  };
  const writeSource = (sourceId: string) => { const evidence = loaded.get(sourceId)!, item =
    ownSource(sourceId), previous = item.passages?.count ?? 0,
    count = Object.keys(evidence).length, name = SOURCE_PART(sourceId);
    passageDelta += count - previous;
    if (count > 100_000) throw new ApplicationError(400, "Research file limits exceeded");
    if (!count) { if (item.passages) removes.push(name); item.passages = null; return; }
    const bytes = encodeSourcePart(sourceId, evidence), digest = sha256(bytes);
    item.passages = { count, sha256: digest, ...passageFacets(state, evidence) };
    if (current.state.sources[sourceId]?.passages?.sha256 !== digest)
      puts.push({ name, bytes, expectedSha256: digest });
  };
  const writeQueries = () => { if (!queries) return; const count = Object.keys(queries).length;
    if (count > 10_000) throw new ApplicationError(400, "Research file limits exceeded");
    if (!count) { if (state.queries) removes.push(QUERIES_PART); state.queries = null; return; }
    const bytes = encodeQueriesPart(queries), digest = sha256(bytes); state.queries = { count, sha256: digest };
    if (current.state.queries?.sha256 !== digest)
      puts.push({ name: QUERIES_PART, bytes, expectedSha256: digest });
  };
  if (action.type === "label") { ownLabels(); applyLabel(state, action); }
  else if (action.type === "note") state.note = action.markdown;
  else if (action.type === "source") { ownSources(); const item = ownSource(
    addSource(state, action.reference).id);
    if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "source");
    if (action.badge !== undefined) item.badge = action.badge;
    if (action.badgeColor !== undefined) item.badgeColor = action.badgeColor;
    if (action.note !== undefined) item.note = action.note;
  } else if (action.type === "annotate" && action.kind === "source") {
    const item = ownSource(action.id);
    if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "source");
    if (action.badge !== undefined) item.badge = action.badge;
    if (action.badgeColor !== undefined) item.badgeColor = action.badgeColor;
    if (action.note !== undefined) item.note = action.note;
  } else if ((action.type === "annotate" || action.type === "remove") && action.kind === "evidence") {
    const sourceId = action.sourceId!; get(state.sources, sourceId, "Source"); await loadSources([sourceId]);
    const item = get(loaded.get(sourceId)!, action.id, "Evidence");
    if (action.type === "remove") delete loaded.get(sourceId)![action.id];
    else { if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "highlight");
      if (action.note !== undefined) item.note = action.note; }
    writeSource(sourceId);
  } else if (action.type === "remove" && action.kind === "source") {
    const removed = get(state.sources, action.id, "Source"), ledger = await loadQueries();
    Object.values(ledger).forEach((query) => { if (query.sourceIds.includes(action.id))
      (query.sourceReferences ??= {})[action.id] = structuredClone(removed.reference); });
    if (removed.passages) { removes.push(SOURCE_PART(action.id)); passageDelta -= removed.passages.count; }
    delete ownSources()[action.id]; writeQueries();
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
        item.labelIds = item.labelIds.filter((labelId) => !removed.has(labelId)); }); writeSource(id); }); }
    writeQueries();
  } else if (action.type === "passage") throw new Error("Passages must be verified before saving.");
  else if (action.type === "merge") {
    ownSources();
    const sourceByKey = new Map(Object.values(state.sources).map((item) =>
      [researchSourceKey(item.reference), item]));
    action.sources?.forEach((reference) => addSource(state, reference, sourceByKey));
    const evidence = (action.evidence ?? []).map((receipt) => { const reference =
      legalEvidenceSourceReference(receipt); if (!reference) return null;
      const source = ownSource(addSource(state, reference, sourceByKey).id);
      source.reference = { ...source.reference,
        title: source.reference.title ?? reference.title,
        citation: source.reference.citation ?? reference.citation,
        alternateCitation: source.reference.alternateCitation ?? reference.alternateCitation,
        date: source.reference.date ?? reference.date, url: source.reference.url ?? reference.url };
      sourceByKey.set(researchSourceKey(reference), source); return { receipt, source }; }).filter(
        (value): value is { receipt: LegalEvidenceReceipt; source: ResearchSource } => !!value);
    if (Object.keys(state.sources).length > 10_000)
      throw new ApplicationError(400, "Research file limits exceeded");
    await loadSources(evidence.map(({ source }) => source.id));
    evidence.forEach(({ receipt, source }) => { const values = loaded.get(source.id)!,
      previous = values[receipt.evidence_id], assigned = checkedLabels(state,
        action.labels?.[receipt.evidence_id] ?? [], "highlight");
      values[receipt.evidence_id] = { receipt: structuredClone(receipt), sourceId: source.id,
        labelIds: [...assigned, ...(previous?.labelIds ?? []).filter((id) => !assigned.includes(id))],
        note: previous?.note ?? "" }; });
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
        ledger[query.query_id] = value;
      }); writeQueries(); }
  }
  if (Object.keys(state.labels).length > 10_000 || Object.keys(state.sources).length > 10_000 ||
      passageDelta > 0 && Object.values(current.state.sources).reduce((sum, item) =>
        sum + (item.passages?.count ?? 0), passageDelta) > 100_000)
    throw new ApplicationError(400, "Research file limits exceeded");
  const filename = current.document.filename, bytes = Buffer.from(researchFileMarkdown(
    filename.replace(/\.research\.md$/iu, ""), state)), remove = [...new Set(removes)];
  if (!puts.length && !remove.length && sha256(bytes) === current.document.source_sha256) return current;
  const parts = { put: puts, remove }, committed = assistant
      ? await documents.commitAssistantVersion(scope, current.document.id, {
        sourceVersionId: current.versionId, expectedWorkingRevision: current.workingRevision,
        turnVersionId: assistant.turnVersionId, turnId: assistant.turnId, filename,
        fileType: "md", bytes, edits: [], status: "pending", parts })
      : await documents.replaceVersion(scope, current.document.id, current.versionId,
        current.workingRevision, { filename, fileType: "md", bytes, parts }),
    version = committed.status === "committed" || committed.status === "replaced"
      ? committed.version : null;
  if (!version) return null;
  return { document: { ...current.document, current_version_id: version.id,
      current_working_revision: version.working_revision,
      active_version_number: version.version_number, filename: version.filename,
      file_type: version.file_type, size_bytes: version.size_bytes,
      source_sha256: version.source_sha256 }, versionId: version.id,
    workingRevision: version.working_revision, state };
}
