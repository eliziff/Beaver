import { useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { Button } from "../ui/button";
import { researchLabelPath, type ResearchAction, type ResearchLabel } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG } from "./ResearchLabelPicker";
import { researchLabelColor } from "./ResearchLabelCircle";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import type { ResearchRemoval, ResearchTreePreview } from "./ResearchTree";

const LABEL_DRAG = "application/x-beaver-research-label";
const COLOURS = ["#d6b656", "#91a8bb", "#91aa94", "#ba9c93", "#ac9db8"];
type Drop = { id: string; mode: "before" | "inside" | "after" };

/** Folder-like navigation and editing of the existing two scoped hierarchies. */
export function ResearchHierarchy({ scope, selectedId, onSelect, counts = {}, onRemove, onStatus, preview }: {
  scope: ResearchLabel["scope"]; selectedId?: string | null; onSelect?: (id: string) => void;
  counts?: Record<string, number>; onRemove: (item: ResearchRemoval) => void;
  onStatus: (message: string) => void; preview?: ResearchTreePreview;
}) {
  const { file, mutations } = useSourcesWorkspace();
  const labels = preview?.labels ?? file?.state.labels ?? {};
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ResearchLabel | null>(null), [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState<Drop | null>(null), dragged = useRef<string | null>(null);
  const children = useMemo(() => {
    const result = new Map<string | null, ResearchLabel[]>();
    for (const label of Object.values(labels)) if (label.scope === scope) {
      const group = result.get(label.parentId) ?? []; group.push(label); result.set(label.parentId, group);
    }
    result.forEach((group) => group.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
    return result;
  }, [labels, scope]);
  async function act(action: ResearchAction) {
    setBusy(true); setError("");
    try { await mutations.act(action); return true; }
    catch (error) { const message = errorMessage(error, "Could not update labels"); setError(message); onStatus(message); return false; }
    finally { setBusy(false); }
  }
  function canMove(id: string, parentId: string | null) {
    return labels[id]?.scope === scope && (!parentId || labels[parentId]?.scope === scope &&
      !researchLabelPath(labels, parentId).some((label) => label.id === id));
  }
  function move(label: ResearchLabel, parentId: string | null, order: number) {
    if (canMove(label.id, parentId)) {
      if (parentId) setCollapsed((current) => { const next = new Set(current); next.delete(parentId); return next; });
      void act({ type: "label", ...label, parentId, order });
    }
  }
  function add(parentId: string | null) {
    if (parentId) setCollapsed((current) => { const next = new Set(current); next.delete(parentId); return next; });
    setEditing({ id: crypto.randomUUID(), scope, parentId, name: "", order: children.get(parentId)?.length ?? 0,
      color: scope === "highlight" ? COLOURS[Object.values(labels).filter((label) => label.scope === scope).length % COLOURS.length] : null });
  }
  const editForm = editing && <form className="my-1 flex min-w-0 items-center gap-1" onSubmit={(event) => {
    event.preventDefault(); if (!editing.name.trim() || busy) return;
    void act({ type: "label", ...editing, name: editing.name.trim() }).then((saved) => { if (saved) setEditing(null); });
  }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); } }}>
    {scope === "highlight" && <input type="color" aria-label="Highlight type colour" value={researchLabelColor(editing)}
      onChange={(event) => setEditing({ ...editing, color: event.target.value })} className="size-8 shrink-0 cursor-pointer rounded border border-gray-300 bg-white p-0.5" />}
    <input autoFocus aria-label={scope === "highlight" ? "Highlight type name" : "Label name"} value={editing.name}
      onChange={(event) => setEditing({ ...editing, name: event.target.value })} disabled={busy} maxLength={200}
      className="h-8 min-w-0 flex-1 rounded border border-gray-300 px-2 text-sm" />
    <Button type="submit" size="compact" variant="outline" disabled={busy || !editing.name.trim()}>{labels[editing.id] ? "Save" : "Add"}</Button>
    <Button type="button" size="compact" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
  </form>;
  function branch(parentId: string | null, depth: number, seen = new Set<string>()): React.ReactNode {
    return (children.get(parentId) ?? []).filter((label) => !seen.has(label.id)).map((label, index, siblings) => {
      const open = !collapsed.has(label.id), nested = !!children.get(label.id)?.length, active = selectedId === label.id;
      const parent = label.parentId ? labels[label.parentId] : null;
      const shift = (key: string) => {
        if (key === "ArrowUp" && index) move(label, parentId, siblings[index - 1].order - .5);
        else if (key === "ArrowDown" && index < siblings.length - 1) move(label, parentId, siblings[index + 1].order + .5);
        else if (key === "ArrowRight" && index) move(label, siblings[index - 1].id, children.get(siblings[index - 1].id)?.length ?? 0);
        else if (key === "ArrowLeft" && parent) move(label, parent.parentId, parent.order + .5);
        else return false;
        return true;
      };
      return <div key={label.id}>
        <div data-tree-drop-folder={label.id} tabIndex={preview ? undefined : 0} aria-label={`${label.name} folder controls`} data-mark={preview?.marks[label.id]} draggable={!preview && !busy}
          onKeyDown={(event) => { if (event.target === event.currentTarget && event.altKey && !preview && !busy && shift(event.key)) { event.preventDefault(); event.stopPropagation(); } }}
          onDragStart={(event) => { event.stopPropagation(); dragged.current = label.id; event.dataTransfer.setData(LABEL_DRAG, label.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { dragged.current = null; setDrop(null); }}
          onDragOver={(event) => {
            if (preview || busy) return;
            const source = scope === "source" && (event.dataTransfer.types.includes(RESEARCH_SOURCE_DRAG) || event.dataTransfer.types.includes(RESEARCH_SOURCE_REFERENCE_DRAG));
            const box = event.currentTarget.getBoundingClientRect(), y = (event.clientY - box.top) / box.height;
            const mode = source || y > .25 && y < .75 ? "inside" : y <= .25 ? "before" : "after";
            if (!source && (!dragged.current || !canMove(dragged.current, mode === "inside" ? label.id : parentId))) return;
            event.preventDefault(); event.stopPropagation(); setDrop({ id: label.id, mode });
          }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(null); }}
          onDrop={(event) => {
            if (preview || busy) return;
            event.preventDefault(); event.stopPropagation(); const mode = drop?.id === label.id ? drop.mode : "inside"; setDrop(null);
            const id = event.dataTransfer.getData(RESEARCH_SOURCE_DRAG), source = file?.state.sources[id];
            if (scope === "source" && source) { void act({ type: "annotate", kind: "source", id, labelIds: [...new Set([...source.labelIds, label.id])] }); return; }
            const raw = event.dataTransfer.getData(RESEARCH_SOURCE_REFERENCE_DRAG);
            if (scope === "source" && raw) { try { void act({ type: "source", reference: JSON.parse(raw), labelIds: [label.id] }); } catch { onStatus("Could not read the dragged source"); } return; }
            const moving = labels[event.dataTransfer.getData(LABEL_DRAG)]; dragged.current = null;
            if (moving) move(moving, mode === "inside" ? label.id : parentId, mode === "inside" ? children.get(label.id)?.length ?? 0 : label.order + (mode === "before" ? -.5 : .5));
          }}
          className={`group flex min-h-9 min-w-0 items-center gap-1 rounded px-1 ${active ? "bg-gray-100" : "hover:bg-gray-50"} ${drop?.id === label.id ? drop.mode === "inside" ? "ring-1 ring-inset ring-gray-400" : drop.mode === "before" ? "border-t-2 border-gray-400" : "border-b-2 border-gray-400" : ""}`}
          style={{ paddingInlineStart: 4 + depth * 14 }}>
          {nested ? <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${label.name}`} aria-expanded={open}
            onClick={() => setCollapsed((current) => { const next = new Set(current); if (open) next.add(label.id); else next.delete(label.id); return next; })}
            className="grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200">
            <ChevronRight className={`size-3.5 ${open ? "rotate-90" : ""}`} aria-hidden="true" /></button> : <span className="w-6 shrink-0" />}
          <button type="button" disabled={busy || !!preview} aria-pressed={active} aria-label={scope === "source" ? `${label.name}, ${counts[label.id] ?? 0} sources` : label.name} onClick={() => onSelect?.(label.id)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm text-gray-700" title={researchLabelPath(labels, label.id).map(({ name }) => name).join(" / ")}>
            {scope === "source" ? active ? <FolderOpen className="size-3.5 shrink-0 text-gray-500" /> : <Folder className="size-3.5 shrink-0 text-gray-500" />
              : <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: researchLabelColor(label) }} />}
            <span className="min-w-0 flex-1 truncate">{label.name}</span>
            {scope === "source" && <span className="text-xs tabular-nums text-gray-500">{counts[label.id] ?? 0}</span>}
          </button>
          {!preview && <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <MoreActionsMenu label={`${label.name} options`} items={[
              { label: scope === "highlight" ? "Edit name / colour" : "Rename", disabled: busy, onSelect: () => setEditing({ ...label }) },
              { label: "Add child", disabled: busy, onSelect: () => add(label.id) },
              { label: "Move up", disabled: busy || index === 0, onSelect: () => shift("ArrowUp") },
              { label: "Move down", disabled: busy || index === siblings.length - 1, onSelect: () => shift("ArrowDown") },
              { label: "Nest under previous", disabled: busy || index === 0, onSelect: () => shift("ArrowRight") },
              { label: "Move out", disabled: busy || !parent, onSelect: () => shift("ArrowLeft") },
              { label: "Delete", disabled: busy, onSelect: () => onRemove({ kind: "label", id: label.id, name: label.name }) },
            ]} />
          </span>}
        </div>
        {editing?.id === label.id && editForm}
        {open && branch(label.id, depth + 1, new Set([...seen, label.id]))}
        {open && editing?.parentId === label.id && !labels[editing.id] && editForm}
      </div>;
    });
  }
  return <div aria-label={scope === "source" ? "Source labels" : "Highlight hierarchy"}>
    {error && <p role="alert" className="px-2 text-xs text-red-700">{error}</p>}
    {branch(null, 0)}
    {editing && !editing.parentId && !labels[editing.id] && editForm}
    {!preview && <button type="button" disabled={busy} data-tree-drop-root
      onClick={() => add(null)}
      onDragOver={(event) => { if (dragged.current && canMove(dragged.current, null)) { event.preventDefault(); setDrop({ id: "root", mode: "inside" }); } }}
      onDragLeave={() => setDrop(null)} onDrop={(event) => { event.preventDefault(); const moving = labels[event.dataTransfer.getData(LABEL_DRAG)];
        dragged.current = null; setDrop(null); if (moving) move(moving, null, children.get(null)?.length ?? 0); }}
      className={`mt-1 min-h-8 w-full rounded px-2 text-left text-xs text-gray-500 hover:bg-gray-100 ${drop?.id === "root" ? "ring-1 ring-inset ring-gray-400" : ""}`}>
      {drop?.id === "root" ? "Move to top level" : scope === "source" ? "+ Label" : "+ Highlight type"}
    </button>}
  </div>;
}
