import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "./applicationError";
import { researchLabelPath, type PublicResearchFileAction, type ResearchFile, type ResearchLabel } from "./researchFile";
import type { ResearchImportCatalog } from "./tabular/researchImport";
import { textField } from "./textField";
import { researchLabelDesignSchema, type ResearchChange, type ResearchLabelDesign,
  type ResearchSourceLabelNode, type ResearchHighlightTypeNode } from "./researchContract";
export { researchLabelDesignSchema } from "./researchContract";
export type { ResearchLabelDesign } from "./researchContract";

type BatchActions = Extract<PublicResearchFileAction, { type: "batch" }>["actions"];
type Node = ResearchSourceLabelNode | ResearchHighlightTypeNode;
export type ResearchLabelTarget = "sources" | "passages";
export type ProposalProgress = { stage: "reading" | "asking" | "checking" | "retrying"; model?: string; chars?: number; note?: string };
export type ProposalOptions = { model?: string; reasoningEffort?: string; signal?: AbortSignal; progress?: (event: ProposalProgress) => void;
  organizationHistory?: Array<Pick<ResearchChange, "id" | "status" | "organization">>;
  currentDesign?: ResearchLabelDesign };
export type ResearchLabelPlan = {
  title: string; target: ResearchLabelTarget; propose: boolean;
  labels: Array<ResearchLabel & { path: string; existing: boolean; rows: Array<{ id: string; title: string; support: string[] }> }>;
  unassigned: Array<{ id: string; title: string }>;
  actions: BatchActions;
};
const PALETTE = ["#d6b85a", "#7ba7d6", "#8fbf8f", "#d68f8f", "#b08fd6", "#d6a87b", "#7bc7c7", "#c7c77b"];
const clip = (value: string, max = 200) => value.replace(/\s+/gu, " ").trim().slice(0, max);
export const researchConceptKey = (name: string) => name.normalize("NFKC").toLowerCase().trim()
  .replace(/\banalyses\b/gu, "analysis").replace(/\bcriteria\b/gu, "criterion")
  .replace(/ies\b/gu, "y").replace(/(ch|sh|x|z)es\b/gu, "$1").replace(/(?<![sui])s\b/gu, "")
  .replace(/\s+/gu, " ");

type ModelNode = { id?: string; name: string; definition?: string; color?: string | null; members?: string[]; children?: ModelNode[] };
const modelNode: z.ZodType<ModelNode> = z.lazy(() => z.object({ id: z.string().uuid().optional(), name: textField(200),
  definition: z.string().trim().max(20_000).optional(), color: z.string().regex(/^#[a-f0-9]{6}$/iu).nullable().optional(),
  members: z.array(textField(200)).max(25_000).optional(), children: z.array(modelNode).max(100).optional(),
}).strict());
const modelTree = z.object({ title: textField(200), sourceLabels: z.array(modelNode).max(100), highlightTypes: z.array(modelNode).max(100) }).strict();
const sourceRows = (catalog: ResearchImportCatalog) => [...new Map(catalog.rows.map((row) => [row.sourceId, row])).values()];
export const researchCategoryBudget = (catalog: ResearchImportCatalog) =>
  Math.min(50, Math.max(12, sourceRows(catalog).length * 2));

/** Resolve compact inventory references once. The resulting tree is the editable, persisted proposal. */
export function researchLabelDraft(raw: unknown, catalog: ResearchImportCatalog, file: ResearchFile,
  currentDesign?: ResearchLabelDesign, categoryBudget = 100): ResearchLabelDesign {
  const tree = modelTree.parse(raw), rowById = new Map(catalog.rows.map((row) => [row.id, row])),
    sources = new Map(sourceRows(catalog).map((row, index) => [`s${index}`, row.sourceId])),
    passages = new Map(catalog.entries.filter(({ kind }) => kind === "passages" || kind === "cited").map((item) => [item.id, item])),
    known = new Map(Object.values(file.state.labels).map((label) => [label.id, label]));
  const remember = (nodes: Node[], scope: ResearchLabel["scope"], parentId: string | null) => {
    for (const node of nodes) { known.set(node.id, { ...node, scope, parentId, color: node.color ?? null, order: 0 }); remember(node.children, scope, node.id); }
  };
  remember(currentDesign?.sourceLabels ?? [], "source", null); remember(currentDesign?.highlightTypes ?? [], "highlight", null);
  let count = 0;
  const visit = (nodes: ModelNode[], scope: ResearchLabel["scope"], parentId: string | null): Node[] => nodes.map((node) => {
    if (++count > categoryBudget) throw new Error(`Use at most ${categoryBudget} categories across both trees`);
    if (node.id && known.get(node.id)?.scope !== scope) throw new Error("id must identify an existing or current draft category of the same scope");
    const existing = node.id ? known.get(node.id) : [...known.values()].find((label) => label.scope === scope && label.parentId === parentId &&
      researchConceptKey(label.name) === researchConceptKey(node.name)), id = existing?.id ?? randomUUID(),
      children = visit(node.children ?? [], scope, id), base = { id, name: node.name,
        ...(node.definition !== undefined ? { definition: node.definition } : existing?.definition !== undefined ? { definition: existing.definition } : {}),
        ...(node.color !== undefined ? { color: node.color } : existing ? { color: existing.color } : {}) };
    if (scope === "source") return { ...base, children: children as ResearchSourceLabelNode[], members: [...new Set(node.members ?? [])].map((ref) => {
      const sourceId = sources.get(ref); if (!sourceId) throw new Error(`Unknown source ${ref}`); return sourceId;
    }) };
    const members = (node.members ?? []).flatMap((ref) => {
      const item = passages.get(ref), row = item && rowById.get(item.rowId);
      if (!item || !row || !item.evidenceIds.length) throw new Error(`Unknown passage ${ref}`);
      return item.reference.kind === "passage" ? [{ sourceId: row.sourceId, evidenceId: item.reference.evidenceId }]
        : item.evidenceIds.map((evidenceId) => ({ sourceId: row.sourceId, evidenceId }));
    });
    return { ...base, children: children as ResearchHighlightTypeNode[],
      members: [...new Map(members.map((member) => [JSON.stringify(member), member])).values()] };
  });
  return researchLabelDesignSchema.parse({ title: tree.title, sourceLabels: visit(tree.sourceLabels, "source", null),
    highlightTypes: visit(tree.highlightTypes, "highlight", null) });
}

/** Project stable member references into this request's compact inventory IDs without changing the tree. */
export function researchLabelModelView(design: ResearchLabelDesign, catalog: ResearchImportCatalog) {
  const sources = new Map(sourceRows(catalog).map((row, index) => [row.sourceId, `s${index}`])), rows = new Map(catalog.rows.map((row) => [row.id, row.sourceId])),
    passages = new Map(catalog.entries.filter(({ kind }) => kind === "passages" || kind === "cited")
      .flatMap((item) => (item.reference.kind === "passage" ? [item.reference.evidenceId] : item.evidenceIds)
        .map((id) => [`${rows.get(item.rowId)}:${id}`, item.id] as const)));
  const visit = (nodes: Node[], scope: "source" | "highlight"): ModelNode[] => nodes.map(({ color: _color, ...node }) => ({ ...node,
    members: [...new Set(node.members.flatMap((member) => {
      const ref = typeof member === "string" ? sources.get(member) : passages.get(`${member.sourceId}:${member.evidenceId}`); return ref ? [ref] : [];
    }))], children: visit(node.children, scope) }));
  return { title: design.title, sourceLabels: visit(design.sourceLabels, "source"), highlightTypes: visit(design.highlightTypes, "highlight") };
}

/** Each answer and its cited passages appear once; compact IDs are confined to the model boundary. */
export function researchLabelInventory(catalog: ResearchImportCatalog, file: ResearchFile, target: ResearchLabelTarget) {
  const sourceKeys = new Map(sourceRows(catalog).map((row, index) => [row.sourceId, `s${index}`])), rowSources = new Map(catalog.rows.map((row) => [row.id, row.sourceId]));
  const hierarchy = (kind: ResearchLabel["scope"], parentId: string | null = null): ModelNode[] => Object.values(file.state.labels)
    .filter((label) => label.scope === kind && label.parentId === parentId).sort((a, b) => a.order - b.order)
    .map(({ id, name, definition }) => ({ id, name, ...(definition ? { definition } : {}), children: hierarchy(kind, id) }));
  const passages = catalog.entries.filter(({ kind }) => kind === "passages" || kind === "cited"),
    passageOf = new Map(passages.flatMap(({ id, rowId, evidenceIds }) => evidenceIds.map((evidence) => [`${rowSources.get(rowId)}:${evidence}`, id] as const))),
    answers = catalog.entries.filter(({ kind }) => kind === "answer");
  const claimOf = ({ reference }: ResearchImportCatalog["entries"][number]) => reference.kind === "answer"
    ? [JSON.stringify([reference.chatId, reference.answerId]), reference.claimIndices?.length === 1 ? reference.claimIndices[0] : undefined] as const
    : [JSON.stringify(reference), undefined] as const;
  const sourceAnswer = ({ reference }: ResearchImportCatalog["entries"][number]) => reference.kind === "answer"
    ? JSON.stringify([reference.chatId, reference.answerId, reference.resource]) : JSON.stringify(reference);
  // Atomized claims replace only their own source's summary, never another source's singleton finding.
  const split = new Set(answers.filter((entry) => claimOf(entry)[1] !== undefined).map(sourceAnswer)),
    order = new Map([...new Set(answers.map((entry) => claimOf(entry)[0]))].map((id, index) => [id, index])),
    claims = new Map<string, { order: number; index: number; claim: string; evidence: Set<string> }>();
  for (const entry of answers) {
    const [answer, index] = claimOf(entry);
    if (index === undefined && split.has(sourceAnswer(entry))) continue;
    const key = index === undefined ? JSON.stringify(entry.reference) : JSON.stringify([answer, index]),
      claim = claims.get(key) ?? { order: order.get(answer)!, index: index ?? -1, claim: clip(entry.text, 600), evidence: new Set<string>() };
    for (const id of entry.evidenceIds) {
      const passage = passageOf.get(`${rowSources.get(entry.rowId)}:${id}`);
      if (passage) claim.evidence.add(passage);
    }
    claims.set(key, claim);
  }
  return JSON.stringify({ title: catalog.title, sourceKind: target === "sources" ? "source" : "saved passage", question: catalog.question,
    answerExcerpts: [...claims.values()].sort((a, b) => a.order - b.order || a.index - b.index).map(({ claim, evidence }) => ({ claim, ...(evidence.size ? { evidence: [...evidence] } : {}) })),
    existingHighlightTypes: hierarchy("highlight"), existingLabels: hierarchy("source"),
    passages: passages.map(({ id, rowId, kind, column, text }) => ({ id, source: sourceKeys.get(rowSources.get(rowId)!), ...(kind === "passages" ? { type: column.name } : {}), quote: clip(text, 500) })),
    sources: sourceRows(catalog).map((row) => {
      const items = catalog.entries.filter((entry) => entry.rowId === row.id), labels = items.filter(({ kind }) => kind === "classification").map(({ text }) => text),
        notes = items.filter(({ kind }) => kind === "note").map(({ text }) => clip(text, 300)), reference = file.state.sources[row.sourceId]?.reference,
        shown = reference && reference.kind !== "document" ? [reference.collection, reference.date?.slice(0, 4), reference.kind].filter(Boolean).join(" ") : undefined;
      return { id: sourceKeys.get(row.sourceId), title: row.title, ...(shown ? { shown } : {}), ...(labels.length ? { labels } : {}), ...(notes.length ? { notes } : {}) };
    }) });
}

/** Passage previews use source text, never a finding or note that happens to cite the same receipt. */
export function researchLabelMetadata(catalog: ResearchImportCatalog) {
  const rows = new Map(catalog.rows.map((row) => [row.id, row]));
  return { sources: [...new Map(catalog.rows.map((row) => [row.sourceId, { id: row.sourceId, title: row.title }])).values()],
    items: [...new Map(catalog.entries.flatMap((entry) => {
      if ((entry.kind !== "passages" && entry.kind !== "cited") || entry.reference.kind !== "passage") return [];
      const row = rows.get(entry.rowId)!, evidenceId = entry.reference.evidenceId;
      return [[`${row.sourceId}:${evidenceId}`, { sourceId: row.sourceId, evidenceId, title: row.title, text: entry.text.slice(0, 500) }] as const];
    })).values()] };
}

/** Compile the canonical trees to scoped replacement or additive filing mutations. */
export function researchLabelPlan(file: ResearchFile, catalog: ResearchImportCatalog, design: ResearchLabelDesign,
  target: ResearchLabelTarget, intent: "organize" | "file" = "organize"): ResearchLabelPlan {
  const parsed = researchLabelDesignSchema.parse(design), actions: BatchActions = [], labels = { ...file.state.labels },
    rows = new Map(catalog.rows.map((row) => [row.sourceId, row])), byRow = new Map(catalog.rows.map((row) => [row.id, row])),
    evidence = new Map<string, string[]>(), owners = new Map<string, string>(), assigned = new Set<string>(), preview: ResearchLabelPlan["labels"] = [],
    selectedHighlights = new Map<string, { sourceId: string; id: string; labelId?: string }>();
  const bad = (message: string): never => { throw new ApplicationError(400, message); };
  for (const entry of catalog.entries) {
    const sourceId = byRow.get(entry.rowId)?.sourceId; if (!sourceId) continue;
    const ids = entry.reference.kind === "passage" ? [entry.reference.evidenceId] : entry.evidenceIds;
    for (const id of ids) if (!evidence.has(`${sourceId}:${id}`)) evidence.set(`${sourceId}:${id}`, []);
    if (entry.kind === "passages" && entry.reference.kind === "passage") selectedHighlights.set(`${sourceId}:${entry.reference.evidenceId}`,
      { sourceId, id: entry.reference.evidenceId, labelId: catalog.labels.find(({ path, scope }) => scope === "highlight" && path === entry.column.name)?.id });
  }
  for (const entry of catalog.entries) {
    if ((entry.kind !== "passages" && entry.kind !== "cited") || entry.reference.kind !== "passage") continue;
    const sourceId = byRow.get(entry.rowId)?.sourceId; if (!sourceId) continue;
    for (const id of new Set([entry.reference.evidenceId, ...entry.evidenceIds]))
      evidence.set(`${sourceId}:${id}`, [clip(entry.text, 240)]);
  }
  for (const row of catalog.rows) for (const id of row.evidenceIds ?? []) if (!evidence.has(`${row.sourceId}:${id}`)) evidence.set(`${row.sourceId}:${id}`, []);
  const visit = (nodes: Node[], scope: ResearchLabel["scope"], parentId: string | null) => {
    nodes.forEach((node, order) => {
      const existing = file.state.labels[node.id];
      if (existing && existing.scope !== scope) bad("A proposed category reuses an ID from another scope");
      const label: ResearchLabel = { id: node.id, name: node.name, scope, parentId, order,
        color: node.color !== undefined ? node.color : existing?.color ?? PALETTE[preview.length % PALETTE.length],
        ...(node.definition !== undefined ? { definition: node.definition } : existing?.definition !== undefined ? { definition: existing.definition } : {}) };
      labels[node.id] = label;
      if (!existing || ["name", "parentId", "order", "color", "definition"].some((key) => label[key as keyof ResearchLabel] !== existing[key as keyof ResearchLabel]))
        actions.push({ type: "label", ...label });
      const support = new Map<string, string[]>();
      if (scope === "source") {
        const sourceIds = [...new Set(node.members as string[])];
        for (const sourceId of sourceIds) { if (!rows.has(sourceId)) bad("A category contains a source outside this research"); support.set(sourceId, []); }
        const removed = intent === "organize" ? [...rows.keys()].filter((id) => file.state.sources[id]?.labelIds.includes(node.id) && !sourceIds.includes(id)) : [];
        if (removed.length) actions.push({ type: "label-selection", target: "sources", sourceIds: removed, assign: [node.id], mode: "remove" });
        if (sourceIds.length) actions.push({ type: "label-selection", target: "sources", sourceIds, assign: [node.id], mode: "add" });
      } else {
        const members = new Map<string, string[]>();
        for (const { sourceId, evidenceId } of node.members as ResearchHighlightTypeNode["members"]) {
          const key = `${sourceId}:${evidenceId}`, lines = evidence.get(key);
          if (!lines) bad("A category contains a passage outside this research or belonging to another source");
          const path = researchLabelPath({ ...file.state, labels }, node.id), owner = owners.get(key);
          if (owner) bad(`Passage ${evidenceId} is assigned to both "${owner}" and "${path}"; keep it in one highlight type or omit it to leave it as Highlight`);
          owners.set(key, path);
          if (intent === "organize" && selectedHighlights.has(key)) actions.push({ type: "annotate", kind: "evidence", sourceId, id: evidenceId, labelIds: [node.id] });
          else members.set(sourceId, [...members.get(sourceId) ?? [], evidenceId]);
          support.set(sourceId, [...support.get(sourceId) ?? [], ...lines!]);
        }
        if (members.size) actions.push({ type: "label-selection", target: "passages", assign: [node.id], mode: "add",
          members: [...members].map(([sourceId, evidenceIds]) => ({ sourceId, evidenceIds })) });
      }
      for (const id of support.keys()) assigned.add(id);
      preview.push({ ...label, path: researchLabelPath({ ...file.state, labels }, node.id), existing: !!existing,
        rows: [...support].map(([id, lines]) => ({ id, title: rows.get(id)!.title, support: [...new Set(lines)] })) });
      visit(node.children, scope, node.id);
    });
  };
  visit(parsed.sourceLabels, "source", null); visit(parsed.highlightTypes, "highlight", null);
  if (intent === "organize") {
    const included = new Set(preview.map(({ id }) => id)), keep = new Set(included), touched = new Set<string>();
    for (const label of Object.values(file.state.labels)) {
      if (label.scope === "source") {
        const selected = [...rows.keys()].filter((id) => file.state.sources[id]?.labelIds.includes(label.id));
        if (selected.length) touched.add(label.id);
        if (!included.has(label.id) && selected.length) actions.push({ type: "label-selection", target: "sources", sourceIds: selected, assign: [label.id], mode: "remove" });
        if (Object.values(file.state.sources).some((source) => !rows.has(source.id) && source.labelIds.includes(label.id))) keep.add(label.id);
      } else {
        const selected = [...selectedHighlights.values()].filter(({ labelId }) => labelId === label.id);
        if (selected.length) touched.add(label.id);
        if (Object.values(file.state.sources).some((source) => (source.passages?.labelCounts[label.id] ?? 0) > selected.filter(({ sourceId }) => sourceId === source.id).length)) keep.add(label.id);
      }
    }
    const generic = Object.values(file.state.labels).find((label) => label.scope === "highlight" && label.parentId === null &&
      researchConceptKey(label.name) === "highlight");
    for (const [key, member] of selectedHighlights) if (!owners.has(key)) actions.push({ type: "annotate", kind: "evidence",
      sourceId: member.sourceId, id: member.id, labelIds: generic ? [generic.id] : [] });
    const fullSelection = Object.values(file.state.sources).filter(({ collected }) => collected).every(({ id }) => rows.has(id));
    if (!fullSelection) for (const label of Object.values(file.state.labels)) if (!touched.has(label.id)) keep.add(label.id);
    for (const id of keep) { let parent = labels[id]?.parentId; while (parent) { keep.add(parent); parent = labels[parent]?.parentId; } }
    const removed = new Set(Object.values(file.state.labels).filter((label) => !keep.has(label.id) && (fullSelection || touched.has(label.id))).map(({ id }) => id));
    for (const label of Object.values(file.state.labels)) if (removed.has(label.id) && !removed.has(label.parentId ?? ""))
      actions.push({ type: "remove", kind: "label", id: label.id });
  }
  if (!preview.length && !catalog.columns) bad("This proposal contains no categories");
  if (actions.length > 400) throw new ApplicationError(413, "Narrow this label proposal before applying it");
  return { title: clip(parsed.title), target, propose: false, actions, labels: preview,
    unassigned: [...rows].filter(([id]) => !assigned.has(id)).map(([id, row]) => ({ id, title: row.title })) };
}
