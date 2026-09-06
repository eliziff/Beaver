import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { ChevronDown, ChevronRight, GripVertical, Pencil } from "lucide-react";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
import { ActionMenu } from "../ui/action-menu";
import { buttonClassName } from "../ui/button";
import { researchLabelPath, type ResearchAction, type ResearchLabel } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { ResearchLabelCircle, researchLabelColor } from "./ResearchLabelCircle";
import { RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG } from "./ResearchLabelPicker";
import { useSourcesWorkspace } from "./SourcesWorkspace";

type Scope = ResearchLabel["scope"];
type LabelDrop = { id: string; mode: "before" | "inside" | "after" };
const COLLAPSED = "beaver.research.collapsed.v1", UNSORTED = "__unsorted__";
const LABEL_DRAG = "application/x-beaver-research-label";
const readCollapsed = (id?: string) => { try { const value = id
  ? JSON.parse(localStorage.getItem(`${COLLAPSED}:${id}`) ?? "null") : null;
  return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch { return new Set<string>(); } };

export function ResearchLabelsPanel({ scope, selected, onSelectionChange, highlightFilter, setHighlightFilter, onError }: {
  scope: Scope; selected: Set<string> | null; onSelectionChange: Dispatch<SetStateAction<Set<string> | null>>;
  highlightFilter: boolean; setHighlightFilter: (value: boolean) => void;
  onError: (message: string) => void;
}) {
  const { file, mutations: commit } = useSourcesWorkspace();
  const labels = file?.state.labels ?? {}, allSources = Object.values(file?.state.sources ?? {});
  const children = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).forEach((label) => { const values = map.get(label.parentId) ?? [];
      values.push(label); map.set(label.parentId, values); });
    map.forEach((values) => values.sort((a, b) => a.order - b.order)); return map; }, [labels]);
  const [busy, setBusy] = useState(false), [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(file?.document.id));
  const [labelSearch, setLabelSearch] = useState<Record<Scope, string>>({ source: "", highlight: "" });
  const [labelDrop, setLabelDrop] = useState<LabelDrop | null>(null), labelDrag = useRef<string | null>(null);
  const setStatus = onError;
  async function act(action: ResearchAction) {
    if (!file) return null;
    try { return await commit.act(action); }
    catch (reason) { onError(errorMessage(reason, "Could not update labels")); return null; }
  }
  const labelCounts = useMemo(() => { const counts: Record<string, number> = {};
    const visit = (items: typeof allSources, scope: Scope) => items.forEach(({ labelIds }) => {
      const applied = new Set<string>(); labelIds.forEach((id) => researchLabelPath(labels, id).forEach((label) => {
        if (label.scope === scope) applied.add(label.id); })); applied.forEach((id) => { counts[id] = (counts[id] ?? 0) + 1; }); });
    visit(allSources, "source"); allSources.forEach(({ passages }) => Object.entries(passages?.labelCounts ?? {})
      .forEach(([id, count]) => { if (labels[id]?.scope === "highlight") counts[id] = (counts[id] ?? 0) + count; }));
    return counts;
  }, [labels, allSources]);
  const unlabelledCount = allSources.reduce((sum, source) => sum +
    (source.passages?.unlabelledCount ?? 0), 0);
  useEffect(() => { if (file) localStorage.setItem(`${COLLAPSED}:${file.document.id}`,
    JSON.stringify([...collapsed])); }, [collapsed, file]);
  async function addLabel(scope: Scope) {
    if (!file) return;
    setBusy(true); setStatus("");
    try { const id = crypto.randomUUID();
      const selectedId = selected?.size === 1 ? [...selected][0] : "";
      const parentId = labels[selectedId]?.scope === scope ? selectedId : null;
      if (parentId) setCollapsed((current) => { const next = new Set(current); next.delete(parentId); return next; });
      await commit.act({ type: "label", id, name: scope === "source" ? "New label" : "New category", parentId, scope,
        color: scope === "source" ? "#3498db" : "#eab308" }); setActiveLabel(id); }
    catch (reason) { setStatus(errorMessage(reason, "Could not add label")); }
    finally { setBusy(false); }
  }
  async function editLabel(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); const label = labels[id], data = new FormData(event.currentTarget), name = String(data.get("name") ?? "").trim();
    if (label && name && await act({ type: "label", ...label, name,
      color: String(data.get("color") ?? researchLabelColor(label)) })) setActiveLabel(null);
  }
  function canReparent(id: string, parentId: string | null) {
    const label = labels[id], parent = parentId ? labels[parentId] : null;
    if (!label || id === parentId || parentId && (!parent || parent.scope !== label.scope ||
      researchLabelPath(labels, parentId).some((item) => item.id === id))) return false;
    return true;
  }
  async function reparent(id: string, parentId: string | null, order?: number) {
    const label = labels[id]; if (!label || !canReparent(id, parentId)) return;
    await act({ type: "label", ...label, parentId, order: order ?? label.order });
  }
  function keyMove(label: ResearchLabel, key: string) {
    const siblings = (children.get(label.parentId) ?? []).filter(({ scope }) => scope === label.scope),
      index = siblings.findIndex(({ id }) => id === label.id);
    if (key === "ArrowUp" && index > 0) void reparent(label.id, label.parentId, siblings[index - 1].order - .5);
    else if (key === "ArrowDown" && index + 1 < siblings.length) void reparent(label.id, label.parentId, siblings[index + 1].order + .5);
    else if (key === "ArrowRight" && index > 0) void reparent(label.id, siblings[index - 1].id, children.get(siblings[index - 1].id)?.length ?? 0);
    else if (key === "ArrowLeft" && label.parentId) { const parent = labels[label.parentId];
      if (parent) void reparent(label.id, parent.parentId, parent.order + .5); }
    else return false;
    return true;
  }
  function matchesLabel(id: string, search: string): boolean { return !search || labels[id].name.toLowerCase().includes(search.toLowerCase()) ||
    (children.get(id) ?? []).some(({ id: child }) => matchesLabel(child, search)); }
  function labelTree(scope: Scope, parentId: string | null, depth = 0): ReactNode {
    const search = labelSearch[scope], selection = selected;
    return (children.get(parentId) ?? []).filter((label) => label.scope === scope && matchesLabel(label.id, search)).map((label) => {
      const hasChildren = !!children.get(label.id)?.length, open = !collapsed.has(label.id) || !!search,
        count = labelCounts[label.id] ?? 0;
      return <div key={label.id}>
        <div data-tree-drop-folder={label.id} draggable tabIndex={0} onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.altKey && keyMove(label, event.key)) { event.preventDefault(); event.stopPropagation(); } }}
          onDragStart={(event) => {
          if ((event.target as Element).closest("button,input,label,form,a")) { event.preventDefault(); return; }
          labelDrag.current = label.id; event.dataTransfer.setData(LABEL_DRAG, label.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { labelDrag.current = null; setLabelDrop(null); }}
          title="Drag to reorder or move into another label" onDragOver={(event) => {
            const sourceDrag = event.dataTransfer.types.includes(RESEARCH_SOURCE_DRAG) ||
              event.dataTransfer.types.includes(RESEARCH_SOURCE_REFERENCE_DRAG);
            const dragged = labels[labelDrag.current ?? ""];
            if (sourceDrag ? scope !== "source" : !event.dataTransfer.types.includes(LABEL_DRAG) || dragged?.scope !== scope)
              return setLabelDrop(null);
            const box = event.currentTarget.getBoundingClientRect(), y = (event.clientY - box.top) / box.height,
              mode = sourceDrag ? "inside" : event.clientX - box.left > Math.min(96, box.width * .55)
                ? "inside" : y < .5 ? "before" : "after";
            if (!sourceDrag && !canReparent(dragged.id, mode === "inside" ? label.id : label.parentId))
              return setLabelDrop(null);
            event.preventDefault(); setLabelDrop({ id: label.id, mode }); }} onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setLabelDrop(null); }} onDrop={(event) => { event.preventDefault(); setLabelDrop(null);
            const sourceId = event.dataTransfer.getData(RESEARCH_SOURCE_DRAG), source = file?.state.sources[sourceId];
            if (scope === "source" && source) { void act({ type: "annotate", kind: "source", id: sourceId,
              labelIds: [label.id, ...source.labelIds.filter((id) => id !== label.id)] }); return; }
            const raw = event.dataTransfer.getData(RESEARCH_SOURCE_REFERENCE_DRAG);
            if (scope === "source" && raw) { try { void act({ type: "source", reference: JSON.parse(raw), labelIds: [label.id] }); } catch { /* Invalid drag payload. */ } return; }
            const drop = labelDrop?.id === label.id ? labelDrop.mode : "inside"; labelDrag.current = null;
            void reparent(event.dataTransfer.getData(LABEL_DRAG), drop === "inside" ? label.id : label.parentId,
              drop === "inside" ? children.get(label.id)?.length ?? 0 : label.order + (drop === "before" ? -.5 : .5)); }}
          className={`group relative flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md pe-1 ${labelDrop?.id === label.id
            ? labelDrop.mode === "inside" ? "bg-blue-50 ring-1 ring-inset ring-blue-300"
              : labelDrop.mode === "before" ? "before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:rounded before:bg-brand"
                : "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded after:bg-brand"
            : selection?.has(label.id) ? "bg-gray-100" : "hover:bg-gray-50"}`}
          style={{ paddingInlineStart: 8 + depth * 16 }}>
          <GripVertical aria-hidden="true" className="size-3 shrink-0 cursor-grab text-gray-300 group-hover:text-gray-500" />
          <button type="button" disabled={!hasChildren} aria-label={`${open ? "Collapse" : "Expand"} ${label.name}`}
            onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; })}
            className="grid size-6 shrink-0 place-items-center rounded disabled:invisible">
            {open ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}
          </button>
          <label title={`Change ${label.name} colour`} className="relative grid size-6 shrink-0 cursor-pointer place-items-center rounded focus-within:outline focus-within:outline-2 focus-within:outline-offset-1">
            <FolderSvgIcon open={open} className="size-4" fill="currentColor" style={{ color: researchLabelColor(label) }} />
            <input type="color" value={researchLabelColor(label)} aria-label={`${label.name} color`}
              onClick={(event) => event.stopPropagation()} onChange={(event) => { const color = event.target.value;
                void act({ type: "label", ...label, color }); }}
              className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
          {activeLabel === label.id ? <form onSubmit={(event) => void editLabel(event, label.id)} className="flex min-w-0 flex-1 items-center gap-1">
            <input required autoFocus name="name" aria-label="Label name" defaultValue={label.name}
              onBlur={(event) => event.currentTarget.form?.requestSubmit()}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setActiveLabel(null); } }}
              className="h-7 min-w-0 flex-1 rounded border border-gray-300 px-1.5 text-sm" />
          </form> : <><button type="button" onClick={(event) => { const set = onSelectionChange;
            set((current) => { if (!event.shiftKey) return new Set([label.id]); const next = new Set(current ?? []);
              if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; }); }}
            aria-pressed={selection?.has(label.id) ?? false}
            aria-label={`${label.name}, ${count} ${scope === "source" ? "sources" : "directly labelled passages"}`}
            title={scope === "highlight" ? `${count} directly labelled passages; selecting includes nested labels` : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm font-medium">
            <span className="min-w-0 flex-1 truncate">{label.name}</span><span className="tabular-nums text-gray-500">{count}</span>
          </button><button type="button" onClick={() => setActiveLabel(label.id)} aria-label={`Edit ${label.name}`}
            className="absolute end-1 grid size-7 place-items-center rounded bg-white/90 text-gray-500 opacity-0 hover:bg-gray-100 focus-visible:opacity-100 group-hover:opacity-100"><Pencil className="size-3" aria-hidden="true" /></button></>}
        </div>{hasChildren && open && labelTree(scope, label.id, depth + 1)}
      </div>;
    });
  }

  function labelPanel(scope: Scope) { const selection = selected, setSelection = onSelectionChange;
    return <><div className="mb-1 flex items-center gap-1.5">
      <input type="search" autoComplete="off" value={labelSearch[scope]} onChange={(event) => setLabelSearch((value) => ({ ...value, [scope]: event.target.value }))}
        aria-label={scope === "source" ? "Search labels" : "Search highlight categories"}
        placeholder={scope === "source" ? "Search labels" : "Search categories"}
        className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm" />
      <ActionMenu label="Label selection" items={[
        { label: "View all", checked: selection === null, onSelect: () => setSelection(null) },
        { label: "View none", checked: selection?.size === 0, onSelect: () => setSelection(new Set()) },
      ]} triggerClassName={buttonClassName({ variant: "outline", size: "compact" })}>
        {selection === null ? "All" : selection.size === 0 ? "None" : `${selection.size} selected`}<ChevronDown className="size-3" />
      </ActionMenu>
    </div>
    {scope === "highlight" && <label className="mb-1 flex items-center gap-1 rounded bg-gray-50 px-1.5 py-1 text-[13px] leading-4 text-gray-600">
      <input type="checkbox" checked={highlightFilter} onChange={(event) => setHighlightFilter(event.target.checked)} />
      Filter sources by these passages
    </label>}
    <div>{labelTree(scope, null)}</div>
    {scope === "highlight" && unlabelledCount > 0 && <button type="button"
      aria-pressed={selection?.has(UNSORTED) ?? false}
      onClick={() => setSelection(new Set([UNSORTED]))}
      className={`mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selection?.has(UNSORTED) ? "bg-gray-200" : "hover:bg-gray-50"}`}>
      <ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />Unclassified
      <span className="ms-auto tabular-nums text-gray-400">{unlabelledCount}</span>
    </button>}
    {scope === "source" && <button type="button" aria-pressed={selection?.has(UNSORTED) ?? false} onClick={() => setSelection(new Set([UNSORTED]))}
      className={`mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-gray-500 ${selection?.has(UNSORTED) ? "bg-gray-200" : "hover:bg-gray-50"}`}>
      <ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />Unsorted
    </button>}
    <button type="button" data-tree-drop-root={scope} disabled={busy} onClick={() => void addLabel(scope)}
      onDragOver={(event) => { const dragged = labels[labelDrag.current ?? ""];
        if (dragged?.scope !== scope || !canReparent(dragged.id, null)) return setLabelDrop(null);
        event.preventDefault(); setLabelDrop({ id: `root:${scope}`, mode: "inside" }); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setLabelDrop(null); }}
      onDrop={(event) => { event.preventDefault(); setLabelDrop(null); labelDrag.current = null;
        const id = event.dataTransfer.getData(LABEL_DRAG);
        if (labels[id]?.scope === scope) void reparent(id, null, children.get(null)?.filter((label) => label.scope === scope).length ?? 0); }}
      className={`mt-1 flex h-9 w-full items-center rounded-md border border-dashed px-2 text-left text-sm text-gray-500 hover:text-gray-800 ${labelDrop?.id === `root:${scope}`
        ? "border-brand bg-blue-50 ring-1 ring-inset ring-blue-300" : "border-gray-300 hover:border-gray-500"}`}>
      {labelDrop?.id === `root:${scope}` ? "Move to top level" : `+ Add ${scope === "source" ? "label" : "category"}`}
    </button></>; }

  return labelPanel(scope);
}
