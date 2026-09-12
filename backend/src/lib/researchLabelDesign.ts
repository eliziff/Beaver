import { z } from "zod";
import { textField } from "./textField";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "./applicationError";
import { researchLabelPath, type PublicResearchFileAction, type ResearchFile, type ResearchLabel } from "./researchFile";
import type { ResearchImportCatalog } from "./tabular/researchImport";

type BatchActions = Extract<PublicResearchFileAction, { type: "batch" }>["actions"];
const key = textField(80), colour = z.string().regex(/^#[a-f0-9]{6}$/iu);
export const researchLabelDesignSchema = z.object({
  title: textField(200),
  labels: z.array(z.object({ key, name: textField(200), parentKey: key.nullish(),
    color: colour.nullish(), definition: z.string().trim().max(20_000).optional(), scope: z.enum(["source", "highlight"]).optional() }).strict()).min(1).max(100),
  assignments: z.array(z.object({ labelKey: key, itemIds: z.array(textField(200)).max(2_000).optional(),
    rowIds: z.array(textField(4_000)).min(1).max(5_000) }).strict()).max(200),
}).strict();
export type ResearchLabelDesign = z.infer<typeof researchLabelDesignSchema>;
export type ResearchLabelTarget = "sources" | "passages";
/** What an organizing step is doing right now, streamed to the modal that launched it. */
export type ProposalProgress = { stage: "reading" | "asking" | "checking" | "retrying"; model?: string; chars?: number; note?: string };
export type ProposalOptions = { model?: string; reasoningEffort?: string; signal?: AbortSignal; progress?: (event: ProposalProgress) => void };
export type ResearchLabelPlan = {
  title: string; target: ResearchLabelTarget; propose: boolean;
  labels: Array<{ key: string; name: string; scope: ResearchLabel["scope"]; path: string; parentKey: string | null; color: string | null;
    definition?: string; existing: boolean; rows: Array<{ id: string; title: string; support: string[] }> }>;
  unassigned: Array<{ id: string; title: string }>;
  actions: BatchActions;
};

const PALETTE = ["#d6b85a", "#7ba7d6", "#8fbf8f", "#d68f8f", "#b08fd6", "#d6a87b", "#7bc7c7", "#c7c77b"];
const clip = (value: string, max = 200) => value.replace(/\s+/gu, " ").trim().slice(0, max);
const labelScope = (target: ResearchLabelTarget) => target === "sources" ? "source" as const : "highlight" as const;
export const researchConceptKey = (name: string) => name.normalize("NFKC").toLowerCase().trim()
  .replace(/\banalyses\b/gu, "analysis").replace(/\bcriteria\b/gu, "criterion")
  .replace(/ies\b/gu, "y").replace(/(ch|sh|x|z)es\b/gu, "$1").replace(/(?<![sui])s\b/gu, "")
  .replace(/\s+/gu, " ");

/** Inventory the workspace's own material and ontology; a design may only reference these ids. */
/** The inventory is passages first, so the model types what the research cites before it names anything about a source. */
export function researchLabelInventory(catalog: ResearchImportCatalog, file: ResearchFile, target: ResearchLabelTarget) {
  const hierarchy = (kind: ResearchLabel["scope"]) => Object.values(file.state.labels).filter((label) => label.scope === kind)
    .map(({ id, name, parentId, definition }) => ({ key: id, name, parentKey: parentId, ...(definition ? { definition } : {}) }));
  // A whole answer duplicates its claims; the claims are the grain a type attaches to.
  const cited = catalog.entries.filter(({ evidenceIds }) => evidenceIds.length),
    finding = (entry: ResearchImportCatalog["entries"][number]) => entry.reference.kind === "answer" ? `${entry.rowId}:${entry.reference.answerId}` : null,
    claimed = new Set(cited.filter((entry) => entry.reference.kind === "answer" && entry.reference.claimIndices).map(finding));
  return JSON.stringify({ title: catalog.title, sourceKind: target === "sources" ? "source" : "saved passage",
    existingHighlightTypes: hierarchy("highlight"), existingLabels: hierarchy("source"),
    passages: cited.filter((entry) => !(entry.reference.kind === "answer" && !entry.reference.claimIndices && claimed.has(finding(entry))))
      .map(({ id, rowId, kind, column, text, quotes }) => ({ id, source: rowId, kind, ...(kind === "passages" ? { type: column.name } : {}),
        ...(kind === "passages" ? {} : { finding: clip(text, 500) }), quotes: quotes.map((value) => clip(value, 600)) })),
    sources: catalog.rows.map((row) => ({ id: row.id, title: row.title,
      items: catalog.entries.filter((entry) => entry.rowId === row.id && !entry.evidenceIds.length)
        .map(({ id, kind, text }) => ({ id, kind, text: clip(text, 700) })) })) });
}

/** The model answers passages first: highlight types with their highlights, then labels with their filings. One design results. */
export function modelLabelDesign(value: Record<string, unknown>, catalog: ResearchImportCatalog): unknown {
  if (!("highlightTypes" in value) && !("filings" in value)) return value;
  const list = (key: string) => Array.isArray(value[key]) ? value[key] as Record<string, unknown>[] : [];
  const rowOf = new Map(catalog.entries.map(({ id, rowId }) => [id, rowId]));
  for (const label of list("labels")) if (!String(label.adds ?? "").trim())
    throw new Error(`Say in adds what “${clip(String(label.name ?? ""), 80)}” tells a lawyer about a source beyond its highlights, or drop it`);
  return { title: value.title,
    labels: [...list("highlightTypes").map((type) => ({ ...type, scope: "highlight" })),
      ...list("labels").map(({ adds: _adds, ...label }) => ({ ...label, scope: "source" }))],
    assignments: [...list("highlights").map(({ typeKey, itemIds }) => ({ labelKey: typeKey, itemIds,
      rowIds: [...new Set((Array.isArray(itemIds) ? itemIds : []).map((id) => rowOf.get(String(id)) ?? String(id)))] })), ...list("filings")] };
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
      existing = current?.scope === kind ? current : Object.values(labels).find((label) => label.scope === kind &&
        researchConceptKey(label.name) === researchConceptKey(name) && label.parentId === parentId),
      label = existing ?? { id: randomUUID(), name, parentId, scope: kind, order: Object.keys(labels).length,
        color: current?.color ?? proposed?.color ?? PALETTE[Math.max(0, parsed.labels.findIndex((label) => label.key === key)) % PALETTE.length],
        definition: current?.definition ?? proposed?.definition };
    labels[label.id] = label; resolved.set(identity, label);
    if (!existing) actions.push({ type: "label", ...label });
    return label;
  };
  const kindOf = (key: string): ResearchLabel["scope"] => byKey.get(key)?.scope ?? file.state.labels[key]?.scope ?? scope;
  for (const label of parsed.labels) resolve(label.key, kindOf(label.key));
  // Labels describe sources and highlight types describe passages (Eli, 2026-09-12); one idea never sits in both.
  const fresh = parsed.labels.filter((label) => !file.state.labels[label.key]),
    ideas = [...Object.values(file.state.labels).map(({ name, scope: kind }) => ({ name, kind })),
      ...fresh.map((label) => ({ name: label.name, kind: kindOf(label.key) }))];
  for (const label of fresh) if (ideas.some((other) => other.kind !== kindOf(label.key) && researchConceptKey(other.name) === researchConceptKey(label.name)))
    bad(`“${clip(label.name, 80)}” is both a label and a highlight type; labels describe sources and types describe passages, so keep one`);
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
      for (const id of target === "passages" ? row.evidenceIds ?? []
        : items.filter((item) => item.rowId === rowId).flatMap((item) => item.evidenceIds)) member.evidence.add(id);
      for (const item of items.filter((item) => item.rowId === rowId))
        for (const line of item.quotes.length ? item.quotes : [item.text]) member.support.add(clip(line, 240));
      rows.set(rowId, member);
    }
    members.set(assignment.labelKey, rows);
  }
  const concept = (labelKey: string) => kindOf(labelKey) === "source", parents = new Set(parsed.labels.map(({ parentKey }) => parentKey)),
    modelled = !catalog.columns && target === "sources";
  const typed = new Set([...members].filter(([key]) => !concept(key)).flatMap(([, rows]) => [...rows.values()].flatMap(({ evidence }) => [...evidence]))),
    highlighted = new Set(catalog.entries.filter(({ kind }) => kind === "passages").flatMap(({ evidenceIds }) => evidenceIds));
  if (modelled) {
    for (const label of fresh.filter((label) => !concept(label.key) && !parents.has(label.key)))
      if (![...(members.get(label.key) ?? new Map<string, { evidence: Set<string> }>()).values()].some(({ evidence }) => evidence.size))
        bad(`“${clip(label.name, 80)}” is a highlight type with no passage; give it the passages that carry it or drop it`);
    const leaves = parsed.labels.filter((label) => concept(label.key) && !parents.has(label.key) && members.get(label.key)?.size);
    if (catalog.rows.length >= 2 && leaves.length >= 2 && leaves.every((label) => members.get(label.key)!.size === 1))
      bad("Every label holds one source, so the labels copy the source list; a label must group sources, and what single passages say belongs to highlight types");
  }
  // A filed source must have something to open: a passage typed in this proposal or a cited passage in the filing's own
  // support. Support the model left untyped becomes a highlight of the default type; a bare assertion is refused.
  const DEFAULT_TYPE = "__default-highlight", untyped = new Map<string, Set<string>>();
  for (const [labelKey, rows] of members) {
    if (!concept(labelKey)) continue;
    for (const [rowId, member] of rows) {
      const own = catalog.entries.filter((item) => item.rowId === rowId && item.evidenceIds.length);
      if (modelled && own.length && !member.evidence.size && !own.some((item) => item.evidenceIds.some((id) => typed.has(id))))
        bad(`Highlight at least one passage of “${clip(rowById.get(rowId)!.title, 80)}” before filing it, or leave it unfiled`);
      for (const id of member.evidence) if (!typed.has(id) && !highlighted.has(id)) untyped.set(rowId, (untyped.get(rowId) ?? new Set()).add(id));
    }
  }
  if (untyped.size) {
    byKey.set(DEFAULT_TYPE, { key: DEFAULT_TYPE, name: "Highlight", scope: "highlight", parentKey: null });
    members.set(DEFAULT_TYPE, new Map([...untyped].map(([rowId, evidence]) => [rowId, { evidence,
      support: new Set([...members.values()].flatMap((rows) => [...(rows.get(rowId)?.support ?? [])])) }])));
  }
  for (const [labelKey, rows] of members) {
    if (concept(labelKey)) { actions.push({ type: "label-selection", target: "sources",
      sourceIds: [...rows.keys()].map((id) => rowById.get(id)!.sourceId), assign: [resolve(labelKey, "source").id], mode: "add" }); continue; }
    const passages = [...rows].filter(([, { evidence }]) => evidence.size)
      .map(([id, { evidence }]) => ({ sourceId: rowById.get(id)!.sourceId, evidenceIds: [...evidence] }));
    if (passages.length) actions.push({ type: "label-selection", target: "passages",
      assign: [resolve(labelKey, "highlight").id], mode: "add", members: passages });
  }
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const titles = new Set(catalog.rows.map((row) => normalise(row.title)));
  for (const label of catalog.columns ? [] : parsed.labels)
    if (titles.has(normalise(label.name)) && !file.state.labels[label.key]) bad(`“${clip(label.name, 80)}” names one ${
      target === "sources" ? "source" : "passage"}, not a concept to file it under`);
  if (!members.size && !catalog.columns) bad("This proposal classifies nothing");
  if (actions.length > 400) throw new ApplicationError(413, "Narrow this label proposal before applying it");
  const assigned = new Set([...members.values()].flatMap((rows) => [...rows.keys()]));
  return { title: clip(parsed.title), target, propose: false, actions,
    labels: [...parsed.labels, ...(members.has(DEFAULT_TYPE) ? [byKey.get(DEFAULT_TYPE)!] : [])].map((label) => {
      const own = resolve(label.key, kindOf(label.key));
      return { ...own, key: label.key, path: researchLabelPath({ ...file.state, labels }, own.id),
        parentKey: label.parentKey ?? null, existing: !!file.state.labels[own.id],
        rows: [...(members.get(label.key) ?? [])].map(([id, { support }]) => ({ id, title: rowById.get(id)!.title, support: [...support] })) }; }),
    unassigned: catalog.rows.filter(({ id }) => !assigned.has(id)).map(({ id, title }) => ({ id, title })) };
}
