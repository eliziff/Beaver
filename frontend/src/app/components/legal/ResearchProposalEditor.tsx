import { Fragment, type ReactNode } from "react";
import type { ResearchLabelDesign, ResearchLabelProposal } from "@/app/lib/api/researchFiles";

type Category<Member> = { id: string; name: string; definition?: string; color?: string | null; members: Member[]; children: Category<Member>[] };
const field = "w-full min-w-0 rounded border border-gray-300 bg-white px-2 py-1 text-sm";
const passageKey = ({ sourceId, evidenceId }: { sourceId: string; evidenceId: string }) => `${sourceId}:${evidenceId}`;

/** The same nested draft is rendered, edited, saved and applied. */
export function ResearchProposalEditor({ proposal, design, onChange, disabled = false }: {
  proposal: Pick<ResearchLabelProposal, "sources" | "items">; design: ResearchLabelDesign;
  onChange: (design: ResearchLabelDesign) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="min-w-0 space-y-3">
    <label className="block text-xs">Proposal title<input className={field} value={design.title}
      onChange={(event) => onChange({ ...design, title: event.target.value })} /></label>
    <CategoryTree nodes={design.sourceLabels} onChange={(sourceLabels) => onChange({ ...design, sourceLabels })}
      title="Source labels" addLabel="Add source label" memberName="source" identity={(id) => id}
      members={proposal.sources.map(({ id, title }) => ({ value: id, title }))} />
    <CategoryTree nodes={design.highlightTypes} onChange={(highlightTypes) => onChange({ ...design, highlightTypes })}
      title="Highlight types" addLabel="Add highlight type" memberName="passage" identity={passageKey} exclusive
      members={proposal.items.map(({ sourceId, evidenceId, title, text }) => ({ value: { sourceId, evidenceId }, title: `${title}: ${text}` }))} />
  </fieldset>;
}

function CategoryTree<Member>({ nodes, onChange, title, addLabel, memberName, identity, members, exclusive = false }: {
  nodes: Category<Member>[]; onChange: (nodes: Category<Member>[]) => void;
  title: string; addLabel: string; memberName: string; identity: (member: Member) => string;
  members: { value: Member; title: string }[]; exclusive?: boolean;
}) {
  const edit = (tree: Category<Member>[], id: string, change: (node: Category<Member>) => Category<Member>): Category<Member>[] =>
    tree.map((node) => node.id === id ? change(node) : { ...node, children: edit(node.children, id, change) });
  const omit = (tree: Category<Member>[], id: string, keepChildren = false): Category<Member>[] =>
    tree.flatMap((node) => node.id === id ? keepChildren ? node.children : [] : [{ ...node, children: omit(node.children, id, keepChildren) }]);
  const options = (tree: Category<Member>[], path = ""): ReactNode => tree.map((node) => {
    const label = path ? `${path} / ${node.name}` : node.name;
    return <Fragment key={node.id}><option value={node.id}>{label}</option>{options(node.children, label)}</Fragment>;
  });
  const assigned = (tree: Category<Member>[], member: Member): boolean => tree.some((node) =>
    node.members.some((current) => identity(current) === identity(member)) || assigned(node.children, member));
  const append = (tree: Category<Member>[], id: string, node: Category<Member>) => id
    ? edit(tree, id, (parent) => ({ ...parent, children: [...parent.children, node] })) : [...tree, node];
  const fresh = (): Category<Member> => ({ id: crypto.randomUUID(), name: "New category", members: [], children: [] });
  const render = (node: Category<Member>, parentId = ""): ReactNode => {
    const destinations = omit(nodes, node.id);
    const patch = (change: Partial<Category<Member>>) => onChange(edit(nodes, node.id, (current) => ({ ...current, ...change })));
    return <details key={node.id} className="min-w-0 py-1">
      <summary className="cursor-pointer break-words text-sm">{node.name}</summary>
      <details className="my-1 ms-3"><summary className="cursor-pointer text-xs text-gray-600">Edit category</summary>
        <div className="mt-2 space-y-2">
          <label className="block text-xs">Name<input className={field} value={node.name} onChange={(event) => patch({ name: event.target.value })} /></label>
          <label className="block text-xs">Definition<textarea className={field} value={node.definition ?? ""} onChange={(event) => patch({ definition: event.target.value })} /></label>
          <label className="block text-xs">Parent<select className={field} value={parentId}
            onChange={(event) => onChange(append(destinations, event.target.value, node))}>
            <option value="">Top level</option>{options(destinations)}
          </select></label>
          <label className="block text-xs">Merge into<select className={field} value="" onChange={(event) => {
            if (event.target.value) onChange(edit(destinations, event.target.value, (target) => ({ ...target,
              children: [...target.children, ...node.children], members: [...new Map([...target.members, ...node.members].map((member) => [identity(member), member])).values()] })));
          }}><option value="">Choose category</option>{options(destinations)}</select></label>
          <label className="block text-xs">Add {memberName}<select className={field} value="" onChange={(event) => {
            const member = members.find((item) => identity(item.value) === event.target.value);
            if (member) patch({ members: [...node.members, member.value] });
          }}><option value="">Choose {memberName}</option>{members.filter((item) => !assigned(exclusive ? nodes : [{ ...node, children: [] }], item.value))
            .map((item) => <option key={identity(item.value)} value={identity(item.value)}>{item.title}</option>)}</select></label>
          <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => patch({ children: [...node.children, fresh()] })}>Add child</button>
          <button type="button" className="ms-2 rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => onChange(omit(nodes, node.id, true))}>Remove category</button>
        </div>
      </details>
      <div className="ms-3">
        {node.members.map((member) => <div key={identity(member)} className="my-2 flex flex-col gap-1 text-xs">
          <span>{members.find((item) => identity(item.value) === identity(member))?.title ?? identity(member)}</span>
          <select aria-label={`Move ${memberName} from ${node.name}`} className={field} value={node.id} onChange={(event) => {
            let next = edit(nodes, node.id, (current) => ({ ...current, members: current.members.filter((item) => identity(item) !== identity(member)) }));
            if (event.target.value) next = edit(next, event.target.value, (target) => ({ ...target,
              members: [...new Map([...target.members, member].map((item) => [identity(item), item])).values()] }));
            onChange(next);
          }}><option value="">Unassigned</option>{options(nodes)}</select>
        </div>)}
        {node.children.map((child) => render(child, node.id))}
      </div>
    </details>;
  };
  return <div><p className="text-xs text-gray-500">{title}</p>{nodes.map((node) => render(node))}
    <button type="button" className="mt-2 rounded border border-gray-300 px-2 py-1 text-sm" onClick={() => onChange([...nodes, fresh()])}>{addLabel}</button>
  </div>;
}
