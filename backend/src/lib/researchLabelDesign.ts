import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "./applicationError";
import { researchLabelPath, type PublicResearchFileAction, type ResearchFile } from "./researchFile";

type BatchActions = Extract<PublicResearchFileAction, { type: "batch" }>["actions"];
import type { ResearchImportCatalog } from "./tabular/researchImport";

const key = z.string().trim().min(1).max(80), colour = z.string().regex(/^#[a-f0-9]{6}$/iu);
export const researchLabelDesignSchema = z.object({
  title: z.string().trim().min(1).max(200),
  labels: z.array(z.object({ key, name: z.string().trim().min(1).max(200), parentKey: key.nullish(),
    color: colour.nullish(), definition: z.string().trim().max(2_000).optional() }).strict()).min(1).max(40),
  assignments: z.array(z.object({ labelKey: key, itemIds: z.array(z.string().trim().min(1).max(200)).max(2_000).optional(),
    rowIds: z.array(z.string().trim().min(1).max(4_000)).min(1).max(5_000) }).strict()).min(1).max(200),
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
  const scope = labelScope(target);
  return JSON.stringify({ title: catalog.title, rowKind: target === "sources" ? "document" : "saved passage",
    existingLabels: Object.values(file.state.labels).filter((label) => label.scope === scope).map(({ id, name, parentId, definition }) =>
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
  const rowById = new Map(catalog.rows.map((row) => [row.id, row]));
  const byKey = new Map(parsed.labels.map((label) => [label.key, label]));
  if (byKey.size !== parsed.labels.length) bad("The proposed labels repeat a key");
  const ids = new Map<string, string>(), existing = new Set<string>();
  for (const label of parsed.labels) {
    const current = file.state.labels[label.key];
    if (current && current.scope !== scope) bad("A proposed label reuses a label of another kind");
    if (current) existing.add(label.key);
    ids.set(label.key, current?.id ?? randomUUID());
  }
  const ordered: ResearchLabelDesign["labels"] = [], placed = new Set<string>();
  const visit = (label: ResearchLabelDesign["labels"][number], trail: Set<string>) => {
    if (placed.has(label.key)) return;
    if (trail.has(label.key)) bad("The proposed labels contain a cycle");
    trail.add(label.key);
    const parentKey = label.parentKey ?? null, parent = parentKey ? byKey.get(parentKey) : undefined;
    if (parent) visit(parent, trail);
    else if (parentKey && file.state.labels[parentKey]?.scope !== scope) bad("A proposed label names an unknown parent");
    placed.add(label.key); ordered.push(label);
  };
  for (const label of parsed.labels) visit(label, new Set());
  const support = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const members = new Map<string, Map<string, Set<string>>>(), shown = new Map<string, Map<string, string[]>>();
  for (const assignment of parsed.assignments) {
    if (!byKey.has(assignment.labelKey)) bad("An assignment names a label that was not proposed");
    const rows = members.get(assignment.labelKey) ?? new Map<string, Set<string>>(),
      display = shown.get(assignment.labelKey) ?? new Map<string, string[]>();
    for (const rowId of assignment.rowIds) {
      const row = rowById.get(rowId) ?? bad("An assignment names material outside this research");
      if (target === "passages" && !row.evidenceIds?.length) bad("A saved passage assignment has no passage");
      const evidence = rows.get(row.sourceId) ?? new Set<string>();
      for (const id of row.evidenceIds ?? []) evidence.add(id);
      rows.set(row.sourceId, evidence);
      display.set(rowId, (assignment.itemIds ?? []).flatMap((id) =>
        support.get(id)?.rowId === rowId ? [clip(support.get(id)!.text, 400)] : []));
    }
    members.set(assignment.labelKey, rows); shown.set(assignment.labelKey, display);
  }
  const parentId = (label: ResearchLabelDesign["labels"][number]) =>
    label.parentKey ? ids.get(label.parentKey) ?? label.parentKey : null;
  const actions: BatchActions = ordered.flatMap((label, index) => existing.has(label.key) ? []
    : [{ type: "label" as const, id: ids.get(label.key)!, name: clip(label.name), parentId: parentId(label),
      color: label.color ?? PALETTE[index % PALETTE.length], scope,
      ...(label.definition ? { definition: label.definition } : {}) }]);
  for (const [labelKey, rows] of members) actions.push(target === "sources"
    ? { type: "label-selection", target: "sources", sourceIds: [...rows.keys()], assign: [ids.get(labelKey)!], mode: "add" }
    : { type: "label-selection", target: "passages", assign: [ids.get(labelKey)!], mode: "add",
      members: [...rows].map(([sourceId, evidence]) => ({ sourceId, evidenceIds: [...evidence] })) });
  if (!members.size) bad("This proposal classifies nothing");
  /** A label is a concept or issue that material is filed under. A label that names one document,
   *  or an ontology with a label per document, is a classification that classifies nothing. */
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const titles = new Map(catalog.rows.map((row) => [normalise(row.title), row.title]));
  for (const label of parsed.labels) {
    const named = titles.get(normalise(label.name));
    if (named && !existing.has(label.key)) bad(`“${clip(label.name, 80)}” names one ${
      target === "sources" ? "document" : "passage"}, not a concept to file it under`);
  }
  const leaves = ordered.filter((label) => !ordered.some(({ parentKey }) => parentKey === label.key)
    && !!shown.get(label.key)?.size);
  if (target === "sources" && catalog.rows.length > 2 && leaves.length > 1 &&
    leaves.every((label) => shown.get(label.key)!.size === 1))
    bad("Every label holds a single document; group the research by concept and file the documents under those");
  if (actions.length > 100) throw new ApplicationError(413,
    "This proposal needs more than 100 operations; ask for a smaller label set");
  const path = (label: ResearchLabelDesign["labels"][number]): string => existing.has(label.key)
    ? researchLabelPath(file.state, ids.get(label.key)!)
    : [...(label.parentKey ? [byKey.has(label.parentKey) ? path(byKey.get(label.parentKey)!)
      : researchLabelPath(file.state, label.parentKey)] : []), clip(label.name)].join(" / ");
  const assigned = new Set([...shown.values()].flatMap((rows) => [...rows.keys()]));
  return { title: clip(parsed.title), target, propose: existing.size > 0, actions,
    labels: ordered.map((label, index) => ({ key: label.key, name: clip(label.name), path: path(label),
      parentKey: label.parentKey ?? null, existing: existing.has(label.key),
      color: label.color ?? (existing.has(label.key) ? file.state.labels[label.key]!.color : PALETTE[index % PALETTE.length]),
      ...(label.definition ? { definition: label.definition } : {}),
      rows: [...(shown.get(label.key) ?? new Map<string, string[]>())].map(([id, support]) =>
        ({ id, title: rowById.get(id)!.title, support })) })),
    unassigned: catalog.rows.filter(({ id }) => !assigned.has(id)).map(({ id, title }) => ({ id, title })) };
}
