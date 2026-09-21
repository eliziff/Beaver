import type { ResearchLabelDesign, ResearchLabelProposal } from "@/app/lib/api/researchFiles";
import type { ResearchAction, ResearchFile, ResearchLabel, ResearchSource } from "@/app/lib/researchFiles";
import type { ResearchTreePreview } from "./ResearchTree";

type Metadata = Pick<ResearchLabelProposal, "sources" | "items">;
type Member = { sourceId: string; evidenceId: string };
type Flat = ResearchLabel & { members: Array<string | Member> };
type DraftNode = { id: string; name: string; color?: string | null; definition?: string;
  members: Array<string | Member>; children: DraftNode[] };
const memberKey = (member: string | Member) => typeof member === "string" ? member : `${member.sourceId}:${member.evidenceId}`;
const unique = <T extends string | Member>(members: T[]) => [...new Map(members.map((member) => [memberKey(member), member])).values()];

function flatten(design: ResearchLabelDesign) {
  const nodes = new Map<string, Flat>();
  const visit = (tree: DraftNode[], scope: ResearchLabel["scope"], parentId: string | null = null) => {
    tree.forEach(({ children, ...node }, order) => {
      if (nodes.has(node.id)) throw new Error("A category occurs more than once");
      nodes.set(node.id, { ...node, members: [...node.members], scope, parentId, order, color: node.color ?? null });
      visit(children, scope, node.id);
    });
  };
  visit(design.sourceLabels, "source"); visit(design.highlightTypes, "highlight");
  return nodes;
}
function rebuild(title: string, nodes: Map<string, Flat>): ResearchLabelDesign {
  const branch = (scope: ResearchLabel["scope"], parentId: string | null): DraftNode[] => [...nodes.values()].filter((node) => node.scope === scope && node.parentId === parentId)
    .sort((a, b) => a.order - b.order).map(({ scope: _scope, parentId: _parent, order: _order, ...node }) =>
      ({ ...node, children: branch(scope, node.id) }));
  return { title, sourceLabels: branch("source", null) as ResearchLabelDesign["sourceLabels"],
    highlightTypes: branch("highlight", null) as ResearchLabelDesign["highlightTypes"] };
}
function destination(nodes: Map<string, Flat>, id: string, scope: ResearchLabel["scope"]) {
  const node = nodes.get(id);
  if (!node || node.scope !== scope) throw new Error("Choose a category in the same tree");
  return node;
}
function checkParent(nodes: Map<string, Flat>, id: string, parentId: string | null, scope: ResearchLabel["scope"]) {
  const seen = new Set([id]);
  while (parentId) {
    if (seen.has(parentId)) throw new Error("A category cannot contain itself");
    seen.add(parentId); parentId = destination(nodes, parentId, scope).parentId;
  }
}

/** Translate the workspace's existing editing operations into the pending design, never live writes. */
export function editResearchProposal(design: ResearchLabelDesign, metadata: Metadata, action: ResearchAction): ResearchLabelDesign {
  const nodes = flatten(design), sources = new Set(metadata.sources.map(({ id }) => id)),
    passages = new Map(metadata.items.map((item) => [memberKey(item), item]));
  const assign = (scope: ResearchLabel["scope"], members: Array<string | Member>, ids: string[], mode: "add" | "remove" | "replace") => {
    if (scope === "highlight" && ids.length > 1) throw new Error("Choose one highlight type");
    const targets = ids.map((id) => destination(nodes, id, scope)), keys = new Set(members.map(memberKey));
    for (const member of members) {
      if (typeof member === "string" ? !sources.has(member) : !passages.has(memberKey(member)))
        throw new Error("This item is outside the proposal");
    }
    if ((mode !== "remove" && scope === "highlight") || mode === "replace")
      for (const node of nodes.values()) if (node.scope === scope) node.members = node.members.filter((member) => !keys.has(memberKey(member)));
    for (const node of targets) node.members = mode === "remove"
      ? node.members.filter((member) => !keys.has(memberKey(member))) : unique([...node.members, ...members]);
  };
  const apply = (item: ResearchAction): void => {
    if (item.type === "batch") { item.actions.forEach(apply); return; }
    if (item.type === "label") {
      const id = item.id ?? crypto.randomUUID(), existing = nodes.get(id), scope = item.scope ?? existing?.scope ?? "source",
        parentId = item.parentId === undefined ? existing?.parentId ?? null : item.parentId;
      if (existing && existing.scope !== scope) throw new Error("A category cannot change trees");
      if (!item.name.trim()) throw new Error("Enter a category name");
      checkParent(nodes, id, parentId, scope);
      nodes.set(id, { ...existing, id, name: item.name.trim(), scope, parentId,
        color: item.color === undefined ? existing?.color ?? null : item.color,
        order: item.order ?? existing?.order ?? Math.max(-1, ...[...nodes.values()].filter((node) => node.scope === scope && node.parentId === parentId).map((node) => node.order)) + 1,
        ...(item.definition !== undefined ? { definition: item.definition } : {}), members: existing?.members ?? [] });
      return;
    }
    if (item.type === "remove" && item.kind === "label") {
      const removed = nodes.get(item.id); if (!removed) throw new Error("This category is unavailable");
      // Removing a category retains its subcategories and never deletes the sources or backing passages.
      const children = [...nodes.values()].filter((node) => node.parentId === item.id).sort((a, b) => a.order - b.order);
      children.forEach((node, index) => { node.parentId = removed.parentId; node.order = removed.order + (index + 1) / (children.length + 1); });
      nodes.delete(item.id); return;
    }
    if (item.type === "annotate") {
      if (item.kind === "source") assign("source", [item.id], item.labelIds ?? [], "add");
      else {
        if (!item.sourceId) throw new Error("Choose the passage's source");
        assign("highlight", [{ sourceId: item.sourceId, evidenceId: item.id }], item.labelIds ?? [], "replace");
      }
      return;
    }
    if (item.type === "label-selection") {
      if (item.findingRefs || item.labelIds || item.unlabelled !== undefined) throw new Error("Choose the items to change explicitly");
      if (item.target === "sources") assign("source", item.sourceIds ?? item.members?.map(({ sourceId }) => sourceId) ?? [], item.assign, item.mode);
      else {
        const members = item.members?.flatMap(({ sourceId, evidenceIds }) => (evidenceIds ?? []).map((evidenceId) => ({ sourceId, evidenceId })))
          ?? metadata.items.filter((passage) => (!item.sourceIds || item.sourceIds.includes(passage.sourceId)) &&
            (!item.evidenceIds || item.evidenceIds.includes(passage.evidenceId)));
        assign("highlight", members, item.assign, item.mode);
      }
      return;
    }
    throw new Error("Only organization changes can be made in this draft");
  };
  apply(action);
  return rebuild(design.title, nodes);
}

export function mergeResearchProposal(design: ResearchLabelDesign, fromId: string, toId: string): ResearchLabelDesign {
  const nodes = flatten(design), from = nodes.get(fromId);
  if (!from) throw new Error("This category is unavailable");
  const to = destination(nodes, toId, from.scope);
  checkParent(nodes, fromId, toId, from.scope);
  to.members = unique([...to.members, ...from.members]);
  let order = Math.max(-1, ...[...nodes.values()].filter((node) => node.parentId === toId).map((node) => node.order)) + 1;
  for (const child of [...nodes.values()].filter((node) => node.parentId === fromId).sort((a, b) => a.order - b.order)) {
    child.parentId = toId; child.order = order++;
  }
  nodes.delete(fromId);
  return rebuild(design.title, nodes);
}

/** Project the draft into the same rows and labels used by the Sources workspace. */
export function researchProposalTree(file: ResearchFile, metadata: Metadata, design: ResearchLabelDesign) {
  const nodes = flatten(design), labels: Record<string, ResearchLabel> = {}, sources: Record<string, ResearchSource> = {},
    marks: ResearchTreePreview["marks"] = {}, passages: NonNullable<ResearchTreePreview["passages"]> = {},
    items = new Map(metadata.items.map((item) => [memberKey(item), item]));
  for (const { id } of metadata.sources) {
    const saved = file.state.sources[id];
    if (!saved) throw new Error("A source in this proposal is unavailable. Refresh the proposal.");
    sources[id] = { ...saved, labelIds: [], passages: { count: 0, sha256: "", unlabelledCount: 0, labelCounts: {} } };
  }
  for (const { members, ...label } of nodes.values()) {
    labels[label.id] = label;
    const before = file.state.labels[label.id];
    if (!before) marks[label.id] = "added";
    else if (JSON.stringify(before) !== JSON.stringify(label)) marks[label.id] = "changed";
    for (const member of members) {
      const sourceId = typeof member === "string" ? member : member.sourceId, source = sources[sourceId];
      if (!source) throw new Error("A category refers to a source outside the proposal");
      if (typeof member === "string") source.labelIds.push(label.id);
      else {
        const item = items.get(memberKey(member));
        if (!item) throw new Error("A passage in this proposal is unavailable. Refresh the proposal.");
        (passages[sourceId] ??= []).push({ labelId: label.id, quote: item.text, evidenceId: member.evidenceId });
        source.passages!.count++; source.passages!.labelCounts[label.id] = (source.passages!.labelCounts[label.id] ?? 0) + 1;
      }
    }
  }
  const typed = new Set(Object.entries(passages).flatMap(([sourceId, items]) => items.map((item) => `${sourceId}:${item.evidenceId}`)));
  for (const item of metadata.items) if (sources[item.sourceId] && !typed.has(memberKey(item))) {
    (passages[item.sourceId] ??= []).push({ labelId: "", quote: item.text, evidenceId: item.evidenceId });
  }
  for (const source of Object.values(sources)) {
    if (JSON.stringify(source.labelIds) !== JSON.stringify(file.state.sources[source.id].labelIds)) marks[source.id] = "changed";
  }
  return { sources: Object.values(sources), file: { ...file, state: { ...file.state, labels, sources } },
    preview: { labels, marks, passages } satisfies ResearchTreePreview };
}
