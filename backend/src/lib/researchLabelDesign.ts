import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "./applicationError";
import { researchLabelPath, type PublicResearchFileAction, type ResearchFile, type ResearchLabel } from "./researchFile";
import type { ResearchImportCatalog } from "./tabular/researchImport";

type BatchActions = Extract<PublicResearchFileAction, { type: "batch" }>["actions"];
const key = z.string().trim().min(1).max(80), colour = z.string().regex(/^#[a-f0-9]{6}$/iu);
export const researchLabelDesignSchema = z.object({
  title: z.string().trim().min(1).max(200),
  labels: z.array(z.object({ key, name: z.string().trim().min(1).max(200), parentKey: key.nullish(),
    color: colour.nullish(), definition: z.string().trim().max(20_000).optional(), scope: z.enum(["source", "highlight"]).optional() }).strict()).min(1).max(100),
  assignments: z.array(z.object({ labelKey: key, itemIds: z.array(z.string().trim().min(1).max(200)).max(2_000).optional(),
    rowIds: z.array(z.string().trim().min(1).max(4_000)).min(1).max(5_000) }).strict()).max(200),
}).strict();
export type ResearchLabelDesign = z.infer<typeof researchLabelDesignSchema>;
export type ResearchLabelTarget = "sources" | "passages";
export type ResearchLabelPlan = {
  title: string; target: ResearchLabelTarget; propose: boolean;
  labels: Array<{ key: string; name: string; path: string; parentKey: string | null; color: string | null;
    definition?: string; existing: boolean; rows: Array<{ id: string; title: string; support: string[] }> }>;
  unassigned: Array<{ id: string; title: string }>;
  actions: BatchActions;
};

const PALETTE = ["#d6b85a", "#7ba7d6", "#8fbf8f", "#d68f8f", "#b08fd6", "#d6a87b", "#7bc7c7", "#c7c77b"];
const clip = (value: string, max = 200) => value.replace(/\s+/gu, " ").trim().slice(0, max);
const labelScope = (target: ResearchLabelTarget) => target === "sources" ? "source" as const : "highlight" as const;

/** Inventory the workspace's own material and ontology; a design may only reference these ids. */
export function researchLabelInventory(catalog: ResearchImportCatalog, file: ResearchFile, target: ResearchLabelTarget) {
  return JSON.stringify({ title: catalog.title, rowKind: target === "sources" ? "document" : "saved passage",
    existingLabels: Object.values(file.state.labels).filter((label) => label.scope === labelScope(target)).map(({ id, name, parentId, definition }) =>
      ({ key: id, name, parentKey: parentId, ...(definition ? { definition } : {}) })),
    rows: catalog.rows.map((row) => ({ id: row.id, title: row.title,
      items: catalog.entries.filter((entry) => entry.rowId === row.id)
        .map(({ id, kind, text }) => ({ id, kind, text: clip(text, 700) })) })) });
}

/** Turn a proposed ontology into ordinary research operations. Existing labels keep their identity, name and parent. */
export function researchLabelPlan(file: ResearchFile, catalog: ResearchImportCatalog,
  design: ResearchLabelDesign, target: ResearchLabelTarget): ResearchLabelPlan {
  const parsed = researchLabelDesignSchema.parse(design), scope = labelScope(target);
  const bad = (message: string): never => { throw new ApplicationError(400, message); };
  const rowById = new Map(catalog.rows.map((row) => [row.id, row])), byKey = new Map(parsed.labels.map((label) => [label.key, label]));
  if (byKey.size !== parsed.labels.length) bad("The proposed labels repeat a key");
  const labels = { ...file.state.labels }, resolved = new Map<string, ResearchLabel>(), actions: BatchActions = [];
  const resolve = (key: string, kind: ResearchLabel["scope"], trail = new Set<string>()): ResearchLabel => {
    const identity = `${kind}:${key}`, cached = resolved.get(identity); if (cached) return cached;
    if (trail.has(key)) return bad("The proposed labels contain a cycle");
    trail.add(key);
    const current = file.state.labels[key], proposed = byKey.get(key);
    if (current && proposed && current.scope !== (proposed.scope ?? scope)) return bad("A proposed label reuses a label of another kind");
    if (!proposed && !current) return bad("A proposed label names an unknown parent");
    const name = current?.name ?? proposed!.name, parentKey = current ? current.parentId : proposed?.parentKey,
      parentId = parentKey ? resolve(parentKey, kind, trail).id : null,
      existing = current?.scope === kind ? current : Object.values(labels).find((label) => label.scope === kind && label.name === name && label.parentId === parentId),
      label = existing ?? { id: randomUUID(), name, parentId, scope: kind, order: Object.keys(labels).length,
        color: current?.color ?? proposed?.color ?? PALETTE[Math.max(0, parsed.labels.findIndex((label) => label.key === key)) % PALETTE.length],
        definition: current?.definition ?? proposed?.definition };
    labels[label.id] = label; resolved.set(identity, label);
    if (!existing) actions.push({ type: "label", ...label });
    return label;
  };
  for (const label of parsed.labels) { resolve(label.key, label.scope ?? scope); if ((label.scope ?? scope) === "source") resolve(label.key, "highlight"); }
  const support = new Map(catalog.entries.map((entry) => [entry.id, entry])),
    members = new Map<string, Map<string, { evidence: Set<string>; support: Set<string> }>>();
  for (const assignment of parsed.assignments) {
    if (!byKey.has(assignment.labelKey)) bad("An assignment names a label that was not proposed");
    const rows = members.get(assignment.labelKey) ?? new Map(),
      items = (assignment.itemIds ?? []).map((id) => support.get(id) ?? bad("An assignment names an unknown finding"));
    if (items.some((item) => !assignment.rowIds.includes(item.rowId))) bad("A finding belongs to a row outside its assignment");
    for (const rowId of assignment.rowIds) {
      const row = rowById.get(rowId) ?? bad("An assignment names material outside this research");
      if (target === "passages" && !row.evidenceIds?.length) bad("A saved passage assignment has no passage");
      const member = rows.get(rowId) ?? { evidence: new Set<string>(), support: new Set<string>() };
      if (!catalog.columns && target === "sources" && catalog.entries.some((item) => item.rowId === rowId && item.evidenceIds.length) &&
        !items.some((item) => item.rowId === rowId && item.evidenceIds.length)) bad("Choose supporting findings for each source assignment");
      for (const id of target === "passages" ? row.evidenceIds ?? []
        : items.filter((item) => item.rowId === rowId).flatMap((item) => item.evidenceIds)) member.evidence.add(id);
      items.filter((item) => item.rowId === rowId).forEach((item) => member.support.add(clip(item.text, 400)));
      rows.set(rowId, member);
    }
    members.set(assignment.labelKey, rows);
  }
  for (const [labelKey, rows] of members) {
    if ((byKey.get(labelKey)!.scope ?? scope) === "source") actions.push({ type: "label-selection", target: "sources",
      sourceIds: [...rows.keys()].map((id) => rowById.get(id)!.sourceId), assign: [resolve(labelKey, "source").id], mode: "add" });
    const passages = [...rows].filter(([, { evidence }]) => evidence.size)
      .map(([id, { evidence }]) => ({ sourceId: rowById.get(id)!.sourceId, evidenceIds: [...evidence] }));
    if (passages.length) actions.push({ type: "label-selection", target: "passages",
      assign: [resolve(labelKey, "highlight").id], mode: "add", members: passages });
  }
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const titles = new Set(catalog.rows.map((row) => normalise(row.title)));
  for (const label of catalog.columns ? [] : parsed.labels)
    if (titles.has(normalise(label.name)) && !file.state.labels[label.key]) bad(`“${clip(label.name, 80)}” names one ${
      target === "sources" ? "document" : "passage"}, not a concept to file it under`);
  const leaves = parsed.labels.filter((label) => members.has(label.key) && !parsed.labels.some(({ parentKey }) => parentKey === label.key));
  if (!catalog.columns && target === "sources" && catalog.rows.length > 2 && leaves.length > 1 &&
    leaves.every((label) => members.get(label.key)!.size === 1))
    bad("Every label holds a single document; group the research by concept and file the documents under those");
  if (!members.size && !catalog.columns) bad("This proposal classifies nothing");
  if (actions.length > 400) throw new ApplicationError(413, "Narrow this label proposal before applying it");
  const assigned = new Set([...members.values()].flatMap((rows) => [...rows.keys()]));
  return { title: clip(parsed.title), target, propose: false, actions,
    labels: parsed.labels.map((label) => ({ ...resolve(label.key, label.scope ?? scope), key: label.key,
      path: researchLabelPath({ ...file.state, labels }, resolve(label.key, label.scope ?? scope).id),
      parentKey: label.parentKey ?? null, existing: !!file.state.labels[resolve(label.key, label.scope ?? scope).id],
      rows: [...(members.get(label.key) ?? [])].map(([id, { support }]) =>
        ({ id, title: rowById.get(id)!.title, support: [...support] })) })),
    unassigned: catalog.rows.filter(({ id }) => !assigned.has(id)).map(({ id, title }) => ({ id, title })) };
}
