import { z } from "zod";
import type { DocumentStore } from "./documentStore";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { ResearchEvidence, ResearchFile, ResearchFileState } from "./researchFile";

export const RESEARCH_HISTORY_PART = "history.json";
const changeField = z.object({ target: z.enum(["label", "source", "passage", "workspace", "table", "result"]),
  id: z.string().min(1).max(200), sourceId: z.string().uuid().optional(),
  field: z.string().min(1).max(300), before: z.unknown(), after: z.unknown() }).strict();
const counts = z.object({ labels: z.number().int().nonnegative(), sources: z.number().int().nonnegative(),
  passages: z.number().int().nonnegative(), tables: z.number().int().nonnegative().optional(),
  results: z.number().int().nonnegative().optional() }).strict();
export const researchChangeSummarySchema = z.object({ id: z.string().uuid(), title: z.string().min(1).max(200),
  createdAt: z.string().datetime(), executor: z.enum(["human", "assistant"]), model: z.string().optional(), counts }).strict();
const changeSchema = researchChangeSummarySchema.extend({ userId: z.string(),
  status: z.enum(["pending", "applied", "rejected"]), undoOf: z.string().uuid().optional(),
  resolvedBy: z.string().optional(), resolvedAt: z.string().datetime().optional(),
  changes: z.array(changeField).max(500_000) }).strict();
export type ResearchChangeField = z.infer<typeof changeField>;
export type ResearchChangeSummary = z.infer<typeof researchChangeSummarySchema>;
export type ResearchChange = z.infer<typeof changeSchema>;
export const sameResearchValue = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
export function assertResearchChangeBase(changes: ResearchChangeField[],
  read: (change: ResearchChangeField) => unknown, inverse = false) {
  if (changes.some((change) => !sameResearchValue(read(change), inverse ? change.after : change.before)))
    throw new ApplicationError(409, "An affected value changed. Review its latest state before applying this change.",
      { code: "revision_conflict" });
}
export const researchChangeSummary = ({ id, title, createdAt, executor, model, counts }: ResearchChange): ResearchChangeSummary =>
  ({ id, title, createdAt, executor, ...(model && { model }), counts });
export const researchChangeCounts = (changes: ResearchChangeField[]) => {
  const ids = (target: string) => new Set(changes.filter((item) => item.target === target).map(({ id }) => id)).size;
  return { labels: ids("label"), sources: ids("source"), passages: ids("passage"),
    ...(ids("table") ? { tables: ids("table") } : {}), ...(ids("result") ? { results: ids("result") } : {}) };
};
export async function readResearchHistory(documents: DocumentStore, scope: ApplicationScope, file: ResearchFile) {
  if (!file.state.history) return [];
  const part = (await documents.readParts(scope, file.document.id, file.versionId, [RESEARCH_HISTORY_PART]))?.[0];
  let parsed: unknown;
  try { parsed = part && JSON.parse(part.bytes.toString("utf8")); } catch { /* checked below */ }
  const result = z.array(changeSchema).max(10_000).safeParse(parsed);
  if (!part || part.sha256 !== file.state.history.sha256 || !result.success ||
      result.data.length !== file.state.history.count || new Set(result.data.map(({ id }) => id)).size !== result.data.length)
    throw new ApplicationError(409, "Research history changed or is unavailable", { code: "revision_conflict" });
  return result.data;
}

export function researchStateChanges(before: ResearchFileState, after: ResearchFileState,
  beforeEvidence: Record<string, ResearchEvidence>, afterEvidence: Record<string, ResearchEvidence>) {
  const changes: ResearchChangeField[] = [];
  const add = (identity: Pick<ResearchChangeField, "target" | "id" | "sourceId">, field: string,
    left: unknown, right: unknown) => {
    if (!sameResearchValue(left, right)) changes.push({ ...identity, field, before: left ?? null, after: right ?? null });
  };
  const fields = (identity: Pick<ResearchChangeField, "target" | "id" | "sourceId">,
    left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined, names: string[]) => {
    for (const name of names) add(identity, name, left?.[name], right?.[name]);
  };
  for (const id of new Set([...Object.keys(before.labels), ...Object.keys(after.labels)])) {
    const left = before.labels[id], right = after.labels[id], identity = { target: "label" as const, id };
    if (!left || !right) add(identity, "$", left, right);
    else fields(identity, left, right, ["name", "definition", "parentId", "color", "order", "scope"]);
  }
  const assignments = (target: "source" | "passage", left: Record<string, ResearchFileState["sources"][string] | ResearchEvidence>,
    right: typeof left) => {
    for (const id of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const previous = left[id], next = right[id], item = previous ?? next,
        identity = { target, id, ...("sourceId" in item ? { sourceId: item.sourceId } : {}) };
      if (previous && !next) { add(identity, "$", previous, null); continue; }
      const previousLabels = new Set(previous?.labelIds), nextLabels = new Set(next?.labelIds);
      for (const labelId of new Set([...previousLabels, ...nextLabels]))
        add(identity, `labelIds.${labelId}`, previousLabels.has(labelId), nextLabels.has(labelId));
      if (previous) fields(identity, previous, next, target === "source" ? ["note", "badge", "badgeColor"] : ["note"]);
      else for (const field of target === "source" ? ["note", "badge"] : ["note"])
        if ((next as Record<string, unknown> | undefined)?.[field]) add(identity, field, "", (next as Record<string, unknown>)[field]);
    }
  };
  assignments("source", before.sources, after.sources);
  assignments("passage", beforeEvidence, afterEvidence);
  for (const field of ["tables", "chats"] as const) {
    const left = new Set(before[field]), right = new Set(after[field]);
    for (const id of new Set([...left, ...right])) add({ target: "workspace", id: "workspace" },
      `${field}.${id}`, left.has(id), right.has(id));
  }
  add({ target: "workspace", id: "workspace" }, "note", before.note, after.note);
  return changes;
}
