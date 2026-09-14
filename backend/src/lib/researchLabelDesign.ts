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
    color: colour.nullish(), definition: z.string().trim().max(20_000).optional(), scope: z.enum(["source", "highlight"]).optional() }).strict()).max(100),
  assignments: z.array(z.object({ labelKey: key, itemIds: z.array(textField(200)).max(2_000).optional(),
    rowIds: z.array(textField(4_000)).max(5_000).default([]) }).strict().refine(
    ({ rowIds, itemIds }) => rowIds.length > 0 || !!itemIds?.length, "An assignment needs source rows or inventory items")).max(200),
}).strict();
export type ResearchLabelDesign = z.infer<typeof researchLabelDesignSchema>;
export type ResearchLabelTarget = "sources" | "passages";
/** What an organizing step is doing right now, streamed to the modal that launched it. */
export type ProposalProgress = { stage: "reading" | "asking" | "checking" | "retrying"; model?: string; chars?: number; note?: string };
export type ProposalOptions = { model?: string; reasoningEffort?: string; signal?: AbortSignal; progress?: (event: ProposalProgress) => void };
export type ResearchLabelPlan = {
  title: string; target: ResearchLabelTarget; propose: boolean;
  /** Each proposed label is a whole label: applying it puts exactly this into the workspace tree. */
  labels: Array<ResearchLabel & { key: string; path: string; parentKey: string | null;
    existing: boolean; rows: Array<{ id: string; title: string; support: string[] }> }>;
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
/** Supply the question and available answer excerpts in order, linked to their cited passages. */
export function researchLabelInventory(catalog: ResearchImportCatalog, file: ResearchFile, target: ResearchLabelTarget) {
  const hierarchy = (kind: ResearchLabel["scope"]) => Object.values(file.state.labels).filter((label) => label.scope === kind)
    .map(({ id, name, parentId, definition }) => ({ key: id, name, parentKey: parentId, ...(definition ? { definition } : {}) }));
  const passages = catalog.entries.filter(({ kind }) => kind === "passages" || kind === "cited");
  const passageOf = new Map(passages.flatMap(({ id, evidenceIds }) => evidenceIds.map((evidence) => [evidence, id] as const)));
  // Every claim is written once, in the order the answer made it, with the passage ids behind it; the sources
  // those passages come from are never described a second time (Eli, 2026-09-11).
  const answers = catalog.entries.filter(({ kind }) => kind === "answer");
  const claimOf = ({ reference }: ResearchImportCatalog["entries"][number]) => reference.kind === "answer"
    ? [`${reference.chatId}:${reference.answerId}`, reference.claimIndices?.[0]] as const : [JSON.stringify(reference), undefined] as const;
  const split = new Set(answers.filter((entry) => claimOf(entry)[1] !== undefined).map((entry) => claimOf(entry)[0])),
    order = [...new Set(answers.map((entry) => claimOf(entry)[0]))], claims = new Map<string, { at: number; claim: string; evidence: Set<string> }>();
  for (const entry of answers) {
    const [answer, index] = claimOf(entry);
    if (index === undefined && split.has(answer)) continue; // the whole answer would only restate its own claims
    const claim = claims.get(`${answer}:${index ?? ""}`) ?? { at: order.indexOf(answer) * 1_000 + (index ?? 0),
      claim: clip(entry.text, 600), evidence: new Set<string>() };
    for (const id of entry.evidenceIds) if (passageOf.has(id)) claim.evidence.add(passageOf.get(id)!);
    claims.set(`${answer}:${index ?? ""}`, claim);
  }
  return JSON.stringify({ title: catalog.title, sourceKind: target === "sources" ? "source" : "saved passage",
    question: catalog.question, answerExcerpts: [...claims.values()].sort((first, second) => first.at - second.at)
      .map(({ claim, evidence }) => ({ claim, ...(evidence.size ? { evidence: [...evidence] } : {}) })),
    existingHighlightTypes: hierarchy("highlight"), existingLabels: hierarchy("source"),
    passages: passages.map(({ id, rowId, kind, column, text }) =>
      ({ id, source: rowId, ...(kind === "passages" ? { type: column.name } : {}), quote: clip(text, 500) })),
    sources: catalog.rows.map((row) => {
      const items = catalog.entries.filter((entry) => entry.rowId === row.id),
        labels = items.filter(({ kind }) => kind === "classification").map(({ text }) => text),
        notes = items.filter(({ kind }) => kind === "note").map(({ text }) => clip(text, 300));
      const reference = file.state.sources[row.sourceId]?.reference, shown = reference && reference.kind !== "document"
        ? [reference.collection, reference.date?.slice(0, 4), reference.kind].filter(Boolean).join(" ") : undefined;
      return { id: row.id, title: row.title, ...(shown ? { shown } : {}), ...(labels.length ? { labels } : {}), ...(notes.length ? { notes } : {}) };
    }) });
}

/** Turn a proposed ontology into ordinary research operations, retaining existing category identities. */
export function researchLabelPlan(file: ResearchFile, catalog: ResearchImportCatalog,
  design: ResearchLabelDesign, target: ResearchLabelTarget): ResearchLabelPlan {
  const parsed = researchLabelDesignSchema.parse(design), scope = labelScope(target);
  // Existing assignments and parents need no repeated declaration. Include them in the review tree.
  const declared = new Set(parsed.labels.map(({ key }) => key));
  const referenced = [...parsed.assignments.map(({ labelKey }) => labelKey),
    ...parsed.labels.flatMap(({ parentKey }) => parentKey ? [parentKey] : [])];
  for (const key of referenced) {
    const existing = file.state.labels[key];
    if (declared.has(key) || !existing) continue;
    declared.add(key);
    parsed.labels.push({ key, name: existing.name, scope: existing.scope,
      parentKey: existing.parentId, color: existing.color, definition: existing.definition });
    if (existing.parentId) referenced.push(existing.parentId);
  }
  const bad = (message: string): never => { throw new ApplicationError(400, message); };
  const rowById = new Map(catalog.rows.map((row) => [row.id, row])), byKey = new Map(parsed.labels.map((label) => [label.key, label]));
  if (byKey.size !== parsed.labels.length) bad("The proposed labels repeat a key");
  const labels = { ...file.state.labels }, resolved = new Map<string, ResearchLabel>(), actions: BatchActions = [];
  const resolve = (key: string, kind: ResearchLabel["scope"], trail = new Set<string>()): ResearchLabel => {
    const identity = `${kind}:${key}`, cached = resolved.get(identity); if (cached) return cached;
    if (trail.has(key)) return bad("The proposed labels contain a cycle");
    trail.add(key);
    const current = file.state.labels[key], proposed = byKey.get(key);
    if ((proposed?.scope ?? current?.scope ?? scope) !== kind) return bad("A category and its parent must have the same scope");
    if (current && proposed && current.scope !== (proposed.scope ?? scope)) return bad("A proposed label reuses a label of another kind");
    if (!proposed && !current) return bad("A proposed label names an unknown parent");
    const name = proposed?.name ?? current!.name,
      parentKey = proposed?.parentKey !== undefined ? proposed.parentKey : current?.parentId,
      parentId = parentKey ? resolve(parentKey, kind, trail).id : null,
      existing = current?.scope === kind ? current : Object.values(labels).find((label) => label.scope === kind &&
        researchConceptKey(label.name) === researchConceptKey(name) && label.parentId === parentId),
      label = existing ? { ...existing, name: current ? name : existing.name, parentId } : { id: randomUUID(), name, parentId, scope: kind, order: Object.keys(labels).length,
        color: current?.color ?? proposed?.color ?? PALETTE[Math.max(0, parsed.labels.findIndex((label) => label.key === key)) % PALETTE.length],
        definition: current?.definition ?? proposed?.definition };
    labels[label.id] = label; resolved.set(identity, label);
    if (!existing || label.name !== existing.name || label.parentId !== existing.parentId) actions.push({ type: "label", ...label });
    return label;
  };
  const kindOf = (key: string): ResearchLabel["scope"] => byKey.get(key)?.scope ?? file.state.labels[key]?.scope ?? scope;
  for (const label of parsed.labels) resolve(label.key, kindOf(label.key));
  const support = new Map(catalog.entries.map((entry) => [entry.id, entry])),
    members = new Map<string, Map<string, { evidence: Set<string>; support: Set<string> }>>();
  for (const assignment of parsed.assignments) {
    if (!byKey.has(assignment.labelKey)) bad("An assignment names an unknown label");
    const rows = members.get(assignment.labelKey) ?? new Map(),
      items = (assignment.itemIds ?? []).map((id) => support.get(id) ?? bad("An assignment names an unknown finding"));
    const rowIds = assignment.rowIds.length ? assignment.rowIds : [...new Set(items.map(({ rowId }) => rowId))];
    if (items.some((item) => !rowIds.includes(item.rowId))) bad("A finding belongs to a row outside its assignment");
    for (const rowId of rowIds) {
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
  const concept = (labelKey: string) => kindOf(labelKey) === "source";
  const owners = new Map<string, string>();
  for (const [labelKey, rows] of members) if (!concept(labelKey)) {
    for (const [rowId, { evidence }] of rows) {
      if (!evidence.size) bad("A highlight assignment needs a saved passage or a supported inventory item");
      for (const id of evidence) {
        const identity = `${rowId}:${id}`, typeId = resolve(labelKey, "highlight").id;
        if (owners.has(identity) && owners.get(identity) !== typeId) bad("A passage is assigned to more than one highlight type");
        owners.set(identity, typeId);
      }
    }
  }
  const typed = new Set([...members].filter(([key]) => !concept(key)).flatMap(([, rows]) => [...rows.values()].flatMap(({ evidence }) => [...evidence]))),
    highlighted = new Set(catalog.entries.filter(({ kind }) => kind === "passages").flatMap(({ evidenceIds }) => evidenceIds));
  // Keep cited filing support available as highlights when no explicit type was assigned.
  const DEFAULT_TYPE = "__default-highlight", untyped = new Map<string, Set<string>>();
  for (const [labelKey, rows] of members) {
    if (!concept(labelKey)) continue;
    for (const [rowId, member] of rows) {
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
  if (!members.size && !actions.length && !catalog.columns) bad("This proposal contains no categories or assignments");
  if (actions.length > 400) throw new ApplicationError(413, "Narrow this label proposal before applying it");
  const assigned = new Set([...members.values()].flatMap((rows) => [...rows.keys()]));
  return { title: clip(parsed.title), target, propose: false, actions,
    labels: [...parsed.labels, ...(members.has(DEFAULT_TYPE) ? [byKey.get(DEFAULT_TYPE)!] : [])].map((label) => {
      const own = resolve(label.key, kindOf(label.key));
      return { ...own, key: label.key, path: researchLabelPath({ ...file.state, labels }, own.id),
        parentKey: label.parentKey === undefined ? file.state.labels[own.id]?.parentId ?? null : label.parentKey, existing: !!file.state.labels[own.id],
        rows: [...(members.get(label.key) ?? [])].map(([id, { support }]) => ({ id, title: rowById.get(id)!.title, support: [...support] })) }; }),
    unassigned: catalog.rows.filter(({ id }) => !assigned.has(id)).map(({ id, title }) => ({ id, title })) };
}
