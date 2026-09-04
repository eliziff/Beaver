import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApplicationScope } from "./applicationError";
import type { DocumentRecord, DocumentStore } from "./documentStore";
import { parseResourceReference } from "./resourceReferences";
import { legalEvidenceSourceReference, type LegalEvidenceReceipt,
  storedLegalEvidenceReceipt, storedLegalResearchQueryReceipt,
  type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import type { LegalSourceReference } from "./legalSources";
import { jsonRecord as record } from "./value";

export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null; order: number; scope: "source" | "highlight" };
export type ResearchSource = { id: string; reference: LegalSourceReference;
  labelIds: string[]; badge: string; badgeColor?: string; note: string };
export type ResearchEvidence = { receipt: LegalEvidenceReceipt; sourceId: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = LegalResearchQueryReceipt & { sourceIds: string[];
  evidenceIds: string[]; failures: Array<{ sourceId: string; code: string }>;
  slots: Record<string, string[]> };
export const researchQueryReceipt = (receipt: LegalResearchQueryReceipt): ResearchQueryReceipt => ({
  ...receipt, sourceIds: [], evidenceIds: receipt.results.flatMap((item) =>
    "evidence_id" in item ? [item.evidence_id] : []), failures: [], slots: {},
});
export type ResearchFileState = { schemaVersion: "beaver.research.v1";
  labels: Record<string, ResearchLabel>; sources: Record<string, ResearchSource>;
  evidence: Record<string, ResearchEvidence>; queries: Record<string, ResearchQueryReceipt>;
  note: string };
export type ResearchFile = { document: DocumentRecord; versionId: string;
  state: ResearchFileState };

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
    id: text(200) }).strict(),
  z.object({ type: z.literal("source"), reference: source, labelIds: ids.optional(),
    badge: z.string().trim().max(19).optional(), badgeColor: z.string().regex(/^#[a-f0-9]{6}$/iu).optional(),
    note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("annotate"), kind: z.enum(["source", "evidence"]), id: text(200),
    labelIds: ids.optional(), badge: z.string().trim().max(19).optional(),
    badgeColor: z.string().regex(/^#[a-f0-9]{6}$/iu).optional(),
    note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("passage"), sourceId: uuid, locator,
    quote: text(50_000) }).strict(),
  z.object({ type: z.literal("note"), markdown: z.string().max(250_000) }).strict(),
]).superRefine((action, context) => {
  if (action.type === "annotate" && action.kind === "evidence" &&
      (action.badge !== undefined || action.badgeColor !== undefined))
    context.addIssue({ code: "custom", message: "Evidence annotations cannot have badges" });
});
export type PublicResearchFileAction = z.infer<typeof researchFileActionSchema>;
export type ResearchFileAction = PublicResearchFileAction | { type: "merge";
  evidence?: LegalEvidenceReceipt[]; queries?: ResearchQueryReceipt[];
  sources?: LegalSourceReference[];
  labels?: Record<string, string[]> };

const referenceKey = (value: LegalSourceReference) => JSON.stringify(
  [value.provider, value.id, value.part ?? null]);
const sourceTuple = (value: string) => { try { const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : null; } catch { return null; } };
export const researchSourceFromResource = (value: string): LegalSourceReference | null => {
  const resource = parseResourceReference(value); if (resource?.kind !== "source") return null;
  const { provider, sourceId } = resource;
  if (provider === "a2aj") { const tuple = sourceTuple(sourceId), kind = tuple?.[1];
    return typeof tuple?.[0] === "string" && (kind === "cases" || kind === "laws")
      ? { provider, id: tuple[0], citation: tuple[0], kind: kind === "laws" ? "legislation" : "case",
          collection: typeof tuple[2] === "string" && tuple[2] ? tuple[2] : null } : null; }
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
  .map((reference) => [referenceKey(reference), reference])).values()];
const get = <T>(values: Record<string, T>, id: string, label: string) => {
  const value = values[id]; if (!value) throw new Error(`${label} not found.`); return value;
};
const checkedLabels = (state: ResearchFileState, values: string[], scope?: ResearchLabel["scope"]) => {
  if (values.some((id) => !state.labels[id] || scope && state.labels[id].scope !== scope))
    throw new Error("Label not found in this scope.");
  return [...new Set(values)];
};
const addSource = (state: ResearchFileState, reference: LegalSourceReference,
  index?: Map<string, ResearchSource>) => {
  const key = referenceKey(reference), found = index?.get(key) ?? (!index
    ? Object.values(state.sources).find((item) => referenceKey(item.reference) === key) : undefined);
  if (found) return found;
  const value: ResearchSource = { id: randomUUID(), reference: structuredClone(reference),
    labelIds: [], badge: "", badgeColor: "#666666", note: "" };
  state.sources[value.id] = value; index?.set(key, value); return value;
};

export const createResearchFileState = (): ResearchFileState => ({
  schemaVersion: "beaver.research.v1", labels: {}, sources: {}, evidence: {}, queries: {}, note: "",
});

export function decodeResearchFileState(value: unknown): ResearchFileState | null {
  const state = record(value);
  const labels = record(state?.labels), sources = record(state?.sources),
    evidence = record(state?.evidence), queries = record(state?.queries);
  if (state?.schemaVersion !== "beaver.research.v1" || !labels || !sources || !evidence ||
      !queries || typeof state.note !== "string" || state.note.length > 250_000 ||
      Object.keys(labels).length > 10_000 || Object.keys(sources).length > 10_000 ||
      Object.keys(evidence).length > 100_000 || Object.keys(queries).length > 10_000) return null;
  const validIds = (value: unknown, prefix = "") => Array.isArray(value) &&
    value.length <= 10_000 && new Set(value).size === value.length &&
    value.every((id) => typeof id === "string" && id.startsWith(prefix));
  const validLabels = (value: unknown) => validIds(value) &&
    (value as string[]).every((id) => uuid.safeParse(id).success && labels[id]);
  const validSourceIds = (value: unknown) => validIds(value) &&
    (value as string[]).every((id) => uuid.safeParse(id).success);
  if (Object.entries(labels).some(([id, value]) => { const item = record(value); return !item ||
      item.id !== id || !uuid.safeParse(id).success || typeof item.name !== "string" ||
      !item.name || item.name.length > 200 || !(item.parentId === null ||
        typeof item.parentId === "string" && uuid.safeParse(item.parentId).success) ||
      !(item.color === null || typeof item.color === "string" && /^#[a-f0-9]{6}$/iu.test(item.color)) ||
      !Number.isInteger(item.order) || Number(item.order) < 0 || Number(item.order) > 1_000_000 ||
      (item.scope !== "source" && item.scope !== "highlight");
    })) return null;
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
        /^#[a-f0-9]{6}$/iu.test(item.badgeColor)) || typeof item.note !== "string" || item.note.length > 50_000; })) return null;
  if (Object.entries(evidence).some(([id, value]) => { const item = record(value),
    receipt = storedLegalEvidenceReceipt(item?.receipt); return !item || !receipt ||
      receipt.evidence_id !== id || typeof item.sourceId !== "string" || !sources[item.sourceId] ||
      !validLabels(item.labelIds) || (item.labelIds as string[]).some((labelId) =>
        record(labels[labelId])?.scope !== "highlight") || typeof item.note !== "string" ||
      item.note.length > 50_000; })) return null;
  if (Object.entries(queries).some(([id, value]) => { const item = record(value),
    receipt = storedLegalResearchQueryReceipt(item); return !item || !receipt ||
      receipt.query_id !== id || !validSourceIds(item.sourceIds) ||
      !validIds(item.evidenceIds, "e_") ||
      !record(item.slots) || Object.entries(item.slots as Record<string, unknown>).some(
        ([evidenceId, slots]) => !(item.evidenceIds as string[])
          .includes(evidenceId) || !Array.isArray(slots) || slots.length > 100 ||
          slots.some((slot) => typeof slot !== "string" || !slot || slot.length > 200)) ||
      !Array.isArray(item.failures) || item.failures.length > 10_000 ||
      item.failures.some((failure) => { const row = record(failure); return !row ||
        typeof row.sourceId !== "string" || !uuid.safeParse(row.sourceId).success ||
        typeof row.code !== "string" || !row.code || row.code.length > 200; }); })) return null;
  return state as ResearchFileState;
}

export function researchFileMarkdown(title: string, state: ResearchFileState) {
  const count = (values: Record<string, unknown>, singular: string) =>
    `${Object.keys(values).length} ${singular}${Object.keys(values).length === 1 ? "" : "s"}`;
  const label = (id: string) => { const names: string[] = []; let next = state.labels[id];
    while (next && names.length < 20) { names.unshift(next.name); next = next.parentId
      ? state.labels[next.parentId] : undefined!; } return names.join(" / "); };
  const evidenceBySource = new Map<string, ResearchEvidence[]>();
  Object.values(state.evidence).forEach((item) => {
    const values = evidenceBySource.get(item.sourceId);
    if (values) values.push(item); else evidenceBySource.set(item.sourceId, [item]);
  });
  const sources = Object.values(state.sources).map((source) => {
    const name = source.reference.title || source.reference.citation || source.reference.id;
    const labels = source.labelIds.map(label).filter(Boolean);
    const passages = (evidenceBySource.get(source.id) ?? [])
      .map((item) => `  - ${item.receipt.locator.label}${item.labelIds.length
        ? ` — ${item.labelIds.map(label).join(", ")}` : ""}${item.note ? ` — ${item.note}` : ""}`);
    return `- ${source.reference.url ? `[${name}](${source.reference.url})` : name}` +
      `${source.badge ? ` [${source.badge}]` : ""}${labels.length ? ` — ${labels.join(", ")}` : ""}` +
      `${source.note ? ` — ${source.note}` : ""}` +
      `${passages.length ? `\n${passages.join("\n")}` : ""}`;
  });
  const body = [state.note.trim(), sources.length ? `## Sources\n\n${sources.join("\n")}` : ""]
    .filter(Boolean).join("\n\n");
  return `# ${title.replace(/[\r\n#]/gu, " ").trim() || "Research"}\n\n` +
    `${count(state.sources, "source")} · ${count(state.evidence, "passage")} · ` +
    `${count(state.queries, "saved search")}\n\n${body ? `${body}\n\n` : ""}` +
    `<!-- beaver-research:v1\n${JSON.stringify(state)}\n-->\n`;
}

export function parseResearchFile(value: Buffer | string) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const marker = "<!-- beaver-research:v1\n";
  const start = text.lastIndexOf(marker), end = text.indexOf("\n-->", start + marker.length);
  if (start < 0 || end <= start) return null;
  try { return decodeResearchFileState(JSON.parse(text.slice(start + marker.length, end))); }
  catch { return null; }
}

export function reduceResearchFile(value: ResearchFileState, raw: ResearchFileAction) {
  const state = value, action = raw.type === "merge"
    ? raw : researchFileActionSchema.parse(raw);
  switch (action.type) {
    case "label": {
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
      if (previous) for (const label of Object.values(state.labels)) {
        let parent = label.parentId, level = 1;
        while (parent && parent !== id && level < 3) {
          parent = state.labels[parent]?.parentId; level++;
        }
        if (parent === id) height = Math.max(height, level + 1);
      }
      if (depth + height > 4)
        throw new Error("Labels can be nested three levels deep.");
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
      break;
    }
    case "source": {
      const item = addSource(state, action.reference);
      if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds, "source");
      if (action.badge !== undefined) item.badge = action.badge;
      if (action.badgeColor !== undefined) item.badgeColor = action.badgeColor;
      if (action.note !== undefined) item.note = action.note;
      break;
    }
    case "annotate": {
      const item = action.kind === "source" ? get(state.sources, action.id, "Source")
        : get(state.evidence, action.id, "Evidence");
      if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds,
        action.kind === "source" ? "source" : "highlight");
      if (action.badge !== undefined) {
        if (action.kind !== "source") throw new Error("Only sources have badges.");
        (item as ResearchSource).badge = action.badge;
      }
      if (action.badgeColor !== undefined) {
        if (action.kind !== "source") throw new Error("Only sources have badges.");
        (item as ResearchSource).badgeColor = action.badgeColor;
      }
      if (action.note !== undefined) item.note = action.note;
      break;
    }
    case "remove": {
      if (action.kind === "label") {
        get(state.labels, action.id, "Label");
        const children = new Map<string, string[]>(), removed = new Set([action.id]);
        Object.values(state.labels).forEach((label) => { if (label.parentId) {
          const ids = children.get(label.parentId) ?? []; ids.push(label.id);
          children.set(label.parentId, ids);
        } });
        for (const id of removed) (children.get(id) ?? []).forEach((child) => removed.add(child));
        removed.forEach((id) => delete state.labels[id]);
        [...Object.values(state.sources), ...Object.values(state.evidence)]
          .forEach((item) => { item.labelIds = item.labelIds.filter((id) => !removed.has(id)); });
      } else if (action.kind === "source") {
        get(state.sources, action.id, "Source"); delete state.sources[action.id];
        Object.entries(state.evidence).forEach(([id, item]) => {
          if (item.sourceId === action.id) delete state.evidence[id];
        });
      } else { get(state.evidence, action.id, "Evidence"); delete state.evidence[action.id]; }
      break;
    }
    case "note": state.note = action.markdown; break;
    case "passage": throw new Error("Passages must be verified before saving.");
    case "merge": {
      const sourceByKey = new Map(Object.values(state.sources).map((item) =>
        [referenceKey(item.reference), item]));
      action.sources?.forEach((reference) => addSource(state, reference, sourceByKey));
      action.evidence?.forEach((receipt) => {
        const reference = legalEvidenceSourceReference(receipt); if (!reference) return;
        const saved = addSource(state, reference, sourceByKey);
        const previous = state.evidence[receipt.evidence_id];
        const assigned = checkedLabels(state, action.labels?.[receipt.evidence_id] ?? [], "highlight");
        state.evidence[receipt.evidence_id] = { receipt: structuredClone(receipt),
          sourceId: saved.id, labelIds: [...assigned, ...(previous?.labelIds ?? [])
            .filter((id) => !assigned.includes(id))], note: previous?.note ?? "" };
      });
      action.queries?.forEach((query) => {
        const saved = researchQuerySources([query]).map((reference) =>
          addSource(state, reference, sourceByKey).id);
        state.queries[query.query_id] = { ...structuredClone(query),
          sourceIds: [...new Set([...query.sourceIds, ...saved])] };
      });
      break;
    }
  }
  return state;
}

export async function readResearchFile(documents: DocumentStore, scope: ApplicationScope,
  documentId: string): Promise<ResearchFile | null> {
  const [document, file] = await Promise.all([
    documents.metadata(scope, documentId), documents.read(scope, documentId, null, false),
  ]);
  const state = file?.fileType === "md" ? parseResearchFile(file.bytes) : null;
  return document && file && state ? { document, versionId: file.version.id, state } : null;
}

export async function saveResearchFile(documents: DocumentStore, scope: ApplicationScope,
  documentId: string, expectedVersionId: string, action: ResearchFileAction,
  assistant = false): Promise<ResearchFile | null> {
  const current = await readResearchFile(documents, scope, documentId);
  if (!current || current.versionId !== expectedVersionId) return null;
  const state = reduceResearchFile(current.state, action);
  const filename = String(current.document.filename ?? "Research.research.md");
  const contents = { filename, fileType: "md" as const,
    bytes: Buffer.from(researchFileMarkdown(filename.replace(/\.research\.md$/iu, ""), state)) };
  const replaced = assistant ? null : await documents.replaceVersion(scope, documentId, expectedVersionId, contents);
  const version = assistant
    ? await documents.addVersion(scope, documentId, { ...contents, expectedCurrentVersionId: expectedVersionId,
      provenance: { schemaVersion: 1 as const, actor: "assistant" as const,
        action: "revised" as const, parentVersionId: current.versionId } })
    : replaced?.status === "replaced" ? replaced.version : null;
  if (!version) return null;
  return { document: { ...current.document, current_version_id: version.id,
      active_version_number: version.version_number, filename: version.filename,
      file_type: version.file_type },
    versionId: version.id, state };
}
