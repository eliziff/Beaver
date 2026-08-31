import { randomUUID } from "node:crypto";
import { z } from "zod";
import { legalEvidenceSourceReference, type LegalEvidenceReceipt,
  type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import type { LegalSourceReference } from "./legalSources";

export type ResearchSetActor = { kind: "human" | "model"; id: string;
  origin?: { type: "chat"; chatId: string; messageIds?: string[];
    callId?: string } };
export type ResearchLabel = { id: string; name: string; parentId: string | null;
  color: string | null };
export type ResearchSource = { id: string; reference: LegalSourceReference;
  labelIds: string[]; note: string };
export type ResearchEvidence = { receipt: LegalEvidenceReceipt; sourceId: string;
  labelIds: string[]; note: string };
export type ResearchQueryReceipt = LegalResearchQueryReceipt & { sourceIds: string[];
  evidenceIds: string[]; failures: Array<{ sourceId: string; code: string }> };
export const researchQueryReceipt = (receipt: LegalResearchQueryReceipt): ResearchQueryReceipt => ({
  ...receipt, sourceIds: [], evidenceIds: receipt.results.flatMap((item) =>
    "evidence_id" in item ? [item.evidence_id] : []), failures: [],
});
export type ResearchQueryFailure = ResearchQueryReceipt["failures"][number];
export type ResearchAudit = { at: string; actor: ResearchSetActor; action: string;
  targets: string[] };
export type ResearchSetState = Record<string, unknown> & {
  schemaVersion: "beaver.research-set.v1";
  labels: Record<string, ResearchLabel>;
  sources: Record<string, ResearchSource>;
  evidence: Record<string, ResearchEvidence>;
  queries: Record<string, ResearchQueryReceipt>;
  memo: string;
  audit: ResearchAudit[];
};

const uuid = z.string().uuid(), text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(uuid).max(10_000).refine((items) => new Set(items).size === items.length);
const source = z.object({ provider: text(100), family: text(1_000).optional(), id: text(500),
  part: text(1_000).optional(), kind: z.enum(["case", "legislation", "journal", "hansard"]),
  title: text(1_000).nullable().optional(), citation: text(1_000).nullable().optional(),
  alternateCitation: text(1_000).nullable().optional(), date: text(1_000).nullable().optional(),
  collection: text(1_000).nullable().optional(), language: z.enum(["en", "fr"]).optional(),
  url: z.string().url().max(4_000).nullable().optional() }).strict();
const locator = z.object({ kind: z.enum(["paragraph", "section", "page", "footnote"]),
  value: text(500), endValue: text(500).optional() }).strict();
export const publicResearchSetActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("label"), id: uuid.optional(), name: text(200),
    parentId: uuid.nullable().optional(), color: z.string().regex(/^#[a-f0-9]{6}$/iu)
      .nullable().optional() }).strict(),
  z.object({ type: z.literal("remove"), kind: z.enum(["label", "source", "evidence"]),
    id: text(200) }).strict(),
  z.object({ type: z.literal("source"), reference: source }).strict(),
  z.object({ type: z.literal("annotate"), kind: z.enum(["source", "evidence"]), id: text(200),
    labelIds: ids.optional(), note: z.string().max(50_000).optional() }).strict(),
  z.object({ type: z.literal("passage"), sourceId: uuid, locator,
    quote: text(50_000) }).strict(),
  z.object({ type: z.literal("memo"), markdown: z.string().max(250_000) }).strict(),
]);
export type PublicResearchSetAction = z.infer<typeof publicResearchSetActionSchema>;
export type ResearchSetAction = PublicResearchSetAction | { type: "merge";
  evidence?: LegalEvidenceReceipt[]; queries?: ResearchQueryReceipt[] };

const record = (value: unknown): Record<string, unknown> | null => value !== null &&
  typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const key = (value: LegalSourceReference) => JSON.stringify(
  [value.provider, value.id, value.part ?? null]);
const get = <T>(values: Record<string, T>, id: string, label: string) => {
  const value = values[id];
  if (!value) throw new Error(`${label} not found.`);
  return value;
};
const addSource = (state: ResearchSetState, reference: LegalSourceReference,
  indexed?: Map<string, ResearchSource>) => {
  const sourceKey = key(reference);
  const found = indexed?.get(sourceKey) ?? Object.values(state.sources)
    .find((item) => key(item.reference) === sourceKey);
  if (found) return found;
  const id = randomUUID(), value = { id, reference: structuredClone(reference),
    labelIds: [], note: "" };
  state.sources[id] = value;
  indexed?.set(sourceKey, value);
  return value;
};
const checkedLabels = (state: ResearchSetState, values: string[]) => {
  if (values.some((labelId) => !state.labels[labelId])) {
    throw new Error("Label not found.");
  }
  return [...new Set(values)];
};
const audit = (state: ResearchSetState, actor: ResearchSetActor, action: string,
  targets: string[] = []) => {
  state.audit.push({ at: new Date().toISOString(), actor: structuredClone(actor), action, targets });
  state.audit = state.audit.slice(-2_000);
};

export function decodeResearchSetState(value: unknown): ResearchSetState | null {
  const state = record(value);
  return state?.schemaVersion === "beaver.research-set.v1" && record(state.labels) &&
    record(state.sources) && record(state.evidence) && record(state.queries) &&
    typeof state.memo === "string" && Array.isArray(state.audit)
    ? state as ResearchSetState : null;
}

export function researchSetSummary(state: ResearchSetState) {
  const recent = <T>(values: Record<string, T>, limit: number) =>
    Object.values(values).slice(-limit), clip = (value: string, limit: number) =>
    value.slice(0, limit);
  return { counts: { labels: Object.keys(state.labels).length,
    sources: Object.keys(state.sources).length, evidence: Object.keys(state.evidence).length,
    queries: Object.keys(state.queries).length },
  labels: recent(state.labels, 100),
  sources: recent(state.sources, 20).map(({ id, reference, labelIds, note }) => ({ id,
    provider: reference.provider, referenceId: clip(reference.id, 300), kind: reference.kind,
    title: clip(reference.title ?? reference.citation ?? reference.id, 300),
    labelIds: labelIds.slice(0, 20), note: clip(note, 500) })),
  evidence: recent(state.evidence, 50).map(({ receipt, sourceId, labelIds, note }) =>
    ({ id: receipt.evidence_id, sourceId, labelIds: labelIds.slice(0, 20), note: clip(note, 500) })),
  queries: recent(state.queries, 20).map(({ query_id, input, executed_at }) => ({ query_id,
    input: { pattern: clip(String(input.pattern ?? ""), 1_000), syntax: input.syntax,
      target: input.target }, executed_at })), memo: clip(state.memo, 8_000) };
}

export function createResearchSetState(actor: ResearchSetActor, title: string): ResearchSetState {
  const state: ResearchSetState = { schemaVersion: "beaver.research-set.v1", labels: {},
    sources: {}, evidence: {}, queries: {}, memo: "", audit: [] };
  audit(state, actor, "create", [title]);
  return state;
}

export function recordResearchSetAudit(value: unknown, actor: ResearchSetActor,
  action: string, targets: string[]) {
  const state = structuredClone(decodeResearchSetState(value));
  if (!state) throw new Error("Research set state is invalid.");
  audit(state, actor, action, targets); return state;
}

export function reduceResearchSet(value: unknown, raw: ResearchSetAction,
  actor: ResearchSetActor): ResearchSetState {
  const decoded = decodeResearchSetState(value);
  if (!decoded) throw new Error("Research set state is invalid.");
  const state = structuredClone(decoded), action = raw.type === "merge" ? raw
    : publicResearchSetActionSchema.parse(raw);
  const targets: string[] = [];
  switch (action.type) {
    case "label": {
      const labelId = action.id ?? randomUUID();
      if (action.parentId) get(state.labels, action.parentId, "Parent label");
      for (let parentId = action.parentId; parentId; parentId = state.labels[parentId]?.parentId) {
        if (parentId === labelId) throw new Error("A label cannot contain itself.");
      }
      state.labels[labelId] = { id: labelId, name: action.name,
        parentId: action.parentId ?? null, color: action.color ?? null };
      targets.push(labelId); break;
    }
    case "source": targets.push(addSource(state, action.reference).id); break;
    case "annotate": {
      const item = action.kind === "source" ? get(state.sources, action.id, "Source")
        : get(state.evidence, action.id, "Evidence");
      if (action.labelIds) item.labelIds = checkedLabels(state, action.labelIds);
      if (action.note !== undefined) item.note = action.note;
      targets.push(action.id); break;
    }
    case "remove": {
      if (action.kind === "label") {
        get(state.labels, action.id, "Label"); delete state.labels[action.id];
        Object.values(state.labels).forEach((label) => {
          if (label.parentId === action.id) label.parentId = null;
        });
        [...Object.values(state.sources), ...Object.values(state.evidence)]
          .forEach((item) => { item.labelIds = item.labelIds.filter((id) => id !== action.id); });
      } else if (action.kind === "source") {
        get(state.sources, action.id, "Source"); delete state.sources[action.id];
        Object.entries(state.evidence).filter(([, item]) => item.sourceId === action.id)
          .forEach(([id]) => { delete state.evidence[id]; });
      } else { get(state.evidence, action.id, "Evidence"); delete state.evidence[action.id]; }
      targets.push(action.id); break;
    }
    case "memo": state.memo = action.markdown; break;
    case "passage": throw new Error("Passages must be verified before saving.");
    case "merge": {
      const indexed = new Map(Object.values(state.sources)
        .map((source) => [key(source.reference), source]));
      action.evidence?.forEach((receipt) => {
        const reference = legalEvidenceSourceReference(receipt);
        if (!reference) return;
        const saved = addSource(state, reference, indexed);
        const existing = state.evidence[receipt.evidence_id];
        state.evidence[receipt.evidence_id] = { receipt: structuredClone(receipt),
          sourceId: saved.id, labelIds: existing?.labelIds ?? [], note: existing?.note ?? "" };
        targets.push(receipt.evidence_id);
      });
      action.queries?.forEach((query) => {
        state.queries[query.query_id] = structuredClone(query); targets.push(query.query_id);
      });
      break;
    }
  }
  audit(state, actor, action.type, targets);
  return state;
}
