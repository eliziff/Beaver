import { useMemo, useRef, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { buttonClassName } from "../ui/button";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
import { InlineNameInput } from "../shared/InlineNameInput";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { researchLabelPath, type ResearchAction, type ResearchLabel, type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelColor } from "./ResearchLabelMarker";
import { RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG } from "./ResearchLabelPicker";
import { ROW, ROW_ACTIONS, ROW_COUNT, type ResearchRemoval, type ResearchTreePreview } from "./ResearchTree";
import { useSourcesWorkspace } from "./SourcesWorkspace";

const LABEL_DRAG = "application/x-beaver-research-label";
const NOUN = { source: "label", highlight: "highlight type" } as const;
const COLOURS = ["#d6b85a", "#8aa8c7", "#90ac99", "#bda0b5", "#b4ab91", "#9fa7bf"];

/** The same small hierarchy editor serves source folders and the highlight-type picker. */
export function ResearchLabelTree({ scope, sources = [], selectedId, onSelect, onRemove, onStatus, preview, renderSources }: {
  scope: ResearchLabel["scope"]; sources?: ResearchSource[]; selectedId: string | null;
  onSelect: (id: string | null) => void; onRemove: (removal: ResearchRemoval) => void;
  onStatus: (message: string) => void; preview?: ResearchTreePreview;
  /** Sources carried by a label render inline beneath it; `null` covers the unlabelled ones. */
  renderSources?: (labelId: string | null) => React.ReactNode;
}) {
  const { file, mutations } = useSourcesWorkspace();
  const noun = (shape: string) => shape.replace("{x}", NOUN[scope]).replace(/^./, (first) => first.toUpperCase());
  const labels = preview?.labels ?? file?.state.labels ?? {};
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false), [drop, setDrop] = useState<{ id: string; mode: "before" | "inside" | "after" } | null>(null);
  const dragged = useRef<string | null>(null), tree = useRef<HTMLDivElement>(null);
  const children = useMemo(() => {
    const result = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).filter((label) => label.scope === scope).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .forEach((label) => { const items = result.get(label.parentId) ?? []; items.push(label); result.set(label.parentId, items); });
    return result;
  }, [labels, scope]);
  const direct = useMemo(() => {
    const result = new Set<string>();
    for (const source of sources) (scope === "source" ? source.labelIds : Object.keys(source.passages?.labelCounts ?? {})).forEach((id) => result.add(id));
    return result;
  }, [sources, scope]);
  /** Source folders count distinct sources; highlight types count their own instances. */
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const source of sources) {
      if (scope === "highlight") { Object.entries(source.passages?.labelCounts ?? {}).forEach(([id, count]) => result.set(id, (result.get(id) ?? 0) + count)); continue; }
      const ids = new Set(source.labelIds.flatMap((id) => researchLabelPath(labels, id).map((label) => label.id)));
      ids.forEach((id) => result.set(id, (result.get(id) ?? 0) + 1));
    }
    return result;
  }, [labels, sources, scope]);
  async function act(action: ResearchAction) {
    try { await mutations.act(action); return true; }
    catch (error) { onStatus(errorMessage(error, "Could not update labels")); return false; }
  }
  function expand(id: string) { setCollapsed((current) => { const next = new Set(current); next.delete(id); return next; }); }
  function toggle(id: string) { setCollapsed((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; }); }
  function canMove(id: string, parentId: string | null) {
    return labels[id]?.scope === scope && (!parentId || labels[parentId]?.scope === scope &&
      !researchLabelPath(labels, parentId).some((label) => label.id === id));
  }
  async function move(id: string, parentId: string | null, order: number) {
    if (!canMove(id, parentId)) return;
    if (await act({ type: "label", ...labels[id], parentId, order }) && parentId) expand(parentId);
  }
  function moveKey(label: ResearchLabel, key: string) {
    const siblings = children.get(label.parentId) ?? [], index = siblings.findIndex(({ id }) => id === label.id);
    if (key === "ArrowUp" && index > 0) void move(label.id, label.parentId, siblings[index - 1].order - .5);
    if (key === "ArrowDown" && index < siblings.length - 1) void move(label.id, label.parentId, siblings[index + 1].order + .5);
    if (key === "ArrowRight" && index > 0) void move(label.id, siblings[index - 1].id, children.get(siblings[index - 1].id)?.length ?? 0);
    if (key === "ArrowLeft" && label.parentId) void move(label.id, labels[label.parentId].parentId, labels[label.parentId].order + .5);
  }
  async function add(name: string) {
    const parentId = adding; setAdding(undefined);
    if (!name.trim() || parentId === undefined || busy) return;
    setBusy(true);
    const id = crypto.randomUUID(), colour = COLOURS[Object.values(labels).filter((label) => label.scope === "highlight").length % COLOURS.length];
    try {
      if (await act({ type: "label", id, name: name.trim(), parentId, scope, ...(scope === "highlight" ? { color: colour } : {}) })) {
        if (parentId) expand(parentId);
        if (scope === "highlight") onSelect(id);
      }
    } finally { setBusy(false); }
  }
  const addField = (parentId: string | null) => adding === parentId && <div className="flex h-8 items-center px-2">
    <InlineNameInput kind="new-folder" label={noun("{x} name")}
      onCancel={() => setAdding(undefined)} onCommit={(name) => void add(name)} />
  </div>;
  function branch(parentId: string | null): React.ReactNode {
    return <>{(children.get(parentId) ?? []).map((label) => {
      const hasChildren = !!children.get(label.id)?.length || (!!renderSources && direct.has(label.id)),
        open = !collapsed.has(label.id);
      return <div key={label.id} role="treeitem" aria-label={label.name} aria-selected={selectedId === label.id}
        aria-expanded={hasChildren ? open : undefined}>
        <div data-tree-drop-folder={label.id} draggable={!preview && !busy}
          onDragStart={(event) => { dragged.current = label.id; event.dataTransfer.setData(LABEL_DRAG, label.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { dragged.current = null; setDrop(null); }}
          onDragOver={(event) => {
            const isSource = scope === "source" && event.dataTransfer.types.some((type) => [RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG].includes(type));
            const box = event.currentTarget.getBoundingClientRect(), y = box.height ? (event.clientY - box.top) / box.height : .5;
            const mode = isSource ? "inside" : y < .25 ? "before" : y > .75 ? "after" : "inside";
            if (preview || busy || !isSource && !canMove(dragged.current ?? "", mode === "inside" ? label.id : label.parentId)) return;
            event.preventDefault(); setDrop({ id: label.id, mode });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(event) => {
            event.preventDefault(); const mode = drop?.id === label.id ? drop.mode : "inside"; setDrop(null);
            if (preview || busy) return;
            const sourceId = event.dataTransfer.getData(RESEARCH_SOURCE_DRAG), source = file?.state.sources[sourceId];
            if (source && scope === "source") { void act({ type: "annotate", kind: "source", id: sourceId, labelIds: [label.id] }); return; }
            const raw = event.dataTransfer.getData(RESEARCH_SOURCE_REFERENCE_DRAG);
            if (raw && scope === "source") { try { void act({ type: "source", reference: JSON.parse(raw), labelIds: [label.id] }); } catch { onStatus("Could not add that source"); } return; }
            void move(event.dataTransfer.getData(LABEL_DRAG), mode === "inside" ? label.id : label.parentId,
              mode === "inside" ? children.get(label.id)?.length ?? 0 : label.order + (mode === "before" ? -.5 : .5));
          }}
          className={`${ROW} ${drop?.id === label.id ? drop.mode === "inside" ? "ring-1 ring-gray-400" : drop.mode === "before" ? "border-t-2 border-gray-500" : "border-b-2 border-gray-500" : selectedId === label.id ? "bg-gray-100" : "hover:bg-gray-50"}`}>
          {hasChildren ? <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${label.name}`} onClick={() => toggle(label.id)} className="grid size-6 shrink-0 place-items-center rounded">
            <ChevronRight aria-hidden className={`size-3.5 text-gray-500 ${open ? "rotate-90" : ""}`} /></button> : <span className="w-6 shrink-0" />}
          <label className="relative grid size-5 shrink-0 place-items-center rounded text-gray-500 focus-within:outline focus-within:outline-2" title={`${label.name} colour`}>
            <FolderSvgIcon open={open && hasChildren} className="size-4" style={{ color: researchLabelColor(label) }} />
            {!preview && <input type="color" disabled={busy} aria-label={`${label.name} colour`} value={researchLabelColor(label)}
              onChange={(event) => void act({ type: "label", ...label, color: event.target.value })} className="absolute inset-0 size-5 cursor-pointer opacity-0" />}
          </label>
          {renaming === label.id ? <InlineNameInput kind="folder" value={label.name} label={noun("{x} name")}
            onCancel={() => setRenaming(null)} onCommit={(name) => { setRenaming(null); if (name.trim() && name !== label.name) void act({ type: "label", ...label, name: name.trim() }); }} />
            : <button type="button" data-label-select={label.id} aria-pressed={selectedId === label.id} onClick={() => onSelect(label.id)}
              title={researchLabelPath(labels, label.id).map(({ name }) => name).join(" / ")}
              className="min-w-0 flex-1 truncate py-1 text-start text-sm text-gray-700 aria-pressed:font-semibold"
              data-mark={preview?.marks[label.id]}>{label.name}</button>}
          <span className={ROW_ACTIONS}>
            {!preview && <MoreActionsMenu label={`${label.name} options`} items={[
              { label: "Rename", onSelect: () => setRenaming(label.id) },
              { label: noun("New {x} inside"), onSelect: () => { expand(label.id); setAdding(label.id); } },
              { label: "Move up", onSelect: () => moveKey(label, "ArrowUp"), disabled: (children.get(label.parentId) ?? [])[0]?.id === label.id },
              { label: "Move down", onSelect: () => moveKey(label, "ArrowDown"), disabled: (children.get(label.parentId) ?? []).at(-1)?.id === label.id },
              ...(label.parentId ? [{ label: "Move out", onSelect: () => moveKey(label, "ArrowLeft") }] : []),
              { label: "Delete", onSelect: () => onRemove({ kind: "label", id: label.id, name: label.name }) },
            ]} />}
          </span>
          <span className={ROW_COUNT}>{counts.get(label.id) || ""}</span>
        </div>
        {open && <div role={hasChildren ? "group" : undefined} className="ms-4">{branch(label.id)}{renderSources?.(label.id)}{addField(label.id)}</div>}
      </div>;
    })}</>;
  }
  return <div ref={tree} role="tree" aria-label={scope === "source" ? "Sources" : "Highlight types"} className="min-w-0"
    onKeyDown={(event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-label-select]");
      if (!button || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const id = button.dataset.labelSelect!, label = labels[id];
      if (event.altKey && label && !preview) return moveKey(label, event.key);
      const buttons = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>("[data-label-select]") ?? []), index = buttons.indexOf(button);
      if (event.key === "ArrowRight" && label && children.has(id)) { expand(id); return; }
      if (event.key === "ArrowLeft" && label) {
        if (children.has(id) && !collapsed.has(id)) toggle(id);
        else buttons.find((item) => item.dataset.labelSelect === label.parentId)?.focus();
        return;
      }
      const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowUp" ? -1 : 1);
      buttons[Math.max(0, Math.min(buttons.length - 1, target))]?.focus();
    }}>
    {scope === "source" && <div role="treeitem" aria-selected={selectedId === null}>
      <button type="button" data-label-select="" data-tree-drop-root aria-pressed={selectedId === null} onClick={() => onSelect(null)}
        onDragOver={(event) => { if (canMove(dragged.current ?? "", null)) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); void move(event.dataTransfer.getData(LABEL_DRAG), null, children.get(null)?.length ?? 0); setDrop(null); }}
        className={`${ROW} w-full text-sm text-gray-700 aria-pressed:bg-gray-100 aria-pressed:font-semibold`}>
        <span className="size-6 shrink-0" /><span className="min-w-0 flex-1 truncate text-start">All sources</span>
        <span className={ROW_ACTIONS} /><span className={ROW_COUNT}>{sources.length}</span>
      </button></div>}
    {branch(null)}{renderSources?.(null)}{addField(null)}
    {!preview && <button type="button" disabled={busy} data-tree-drop-root onClick={() => setAdding(null)}
      className={buttonClassName({ variant: "outline", size: "compact", className: "mt-1 gap-1" })}>
      <Plus aria-hidden className="size-3" />{noun("New {x}")}
    </button>}
  </div>;
}
