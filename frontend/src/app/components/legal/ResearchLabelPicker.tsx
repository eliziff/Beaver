import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useAnchoredPopover } from "@/app/hooks/useAnchoredPopover";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelPath, type ResearchFile, type ResearchLabel,
  type ResearchSourceReference } from "@/app/lib/researchFiles";
import { ResearchLabelFolder, ResearchLabelMarker } from "./ResearchLabelMarker";
import type { ResearchFileMutations } from "./useResearchFileMutations";

export const RESEARCH_SOURCE_DRAG = "application/x-beaver-research-source";
export const RESEARCH_SOURCE_REFERENCE_DRAG = "application/x-beaver-research-source-reference";
const MODAL_BOUNDARY = 'dialog,[role="dialog"],[data-assistant-dock]';

type Ready = { file: ResearchFile; itemId: string; sourceId?: string };
export type ResearchLabelTarget = Ready & { kind: "source" | "evidence"; labelIds: string[];
  note?: string; title: string;
  anchor?: HTMLElement | DOMRect; returnFocus?: HTMLElement;
  prepare?: (file: ResearchFile) => Promise<Ready> };

export function ResearchLabelPicker({ file, kind, itemId, sourceId, labelIds, note, title,
  size, disabled, mutations, prepare,
  onError, onNeedFile, onSourceDrag, sourceReference }: { file: ResearchFile | null;
  kind: ResearchLabelTarget["kind"]; itemId?: string; sourceId?: string; labelIds: string[]; note?: string;
  title: string; disabled?: boolean; size?: "sm" | "md" | "lg";
  prepare?: (file: ResearchFile) => Promise<Ready>; mutations: ResearchFileMutations;
  onError?: (message: string) => void; onNeedFile?: () => void; onSourceDrag?: () => void;
  sourceReference?: ResearchSourceReference }) {
  const [target, setTarget] = useState<ResearchLabelTarget | null>(null),
    [previewLabelIds, setPreviewLabelIds] = useState(labelIds);
  const editing = useRef(false); editing.current = !!target;
  useEffect(() => { if (!editing.current) setPreviewLabelIds(labelIds); }, [labelIds]);
  const labelNames = previewLabelIds.map((id) => file?.state.labels[id]?.name).filter(Boolean);
  return <>
    <button type="button" draggable={kind === "source" && !!(itemId || sourceReference)} onDragStart={(event) => {
      onSourceDrag?.();
      if (itemId) event.dataTransfer.setData(RESEARCH_SOURCE_DRAG, itemId);
      else if (sourceReference) event.dataTransfer.setData(RESEARCH_SOURCE_REFERENCE_DRAG,
        JSON.stringify(sourceReference)); }}
      disabled={disabled || !file && !onNeedFile} onClick={(event) => {
      event.stopPropagation(); const anchor = event.currentTarget;
      if (!file) { onNeedFile?.(); return; }
      setTarget({ file, kind, itemId: itemId ?? "", sourceId, labelIds: previewLabelIds,
        note, title, prepare, anchor }); }}
      aria-label={`Label ${title}${labelNames.length ? `: ${labelNames.join(", ")}` : ""}`}
      title={labelNames.join(" · ") || "Add labels and note"}
      className="inline-flex min-h-6 min-w-0 max-w-full shrink-0 items-center justify-self-start justify-center gap-1 rounded-md text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-40">
      <ResearchLabelMarker labels={file?.state.labels ?? {}} labelIds={previewLabelIds} size={size ?? (kind === "source" ? "md" : "sm")} />
    </button>
    {target && createPortal(<ResearchLabelEditor target={target} mutations={mutations} onError={onError}
      onClose={() => setTarget(null)} onPreview={setPreviewLabelIds} />,
      target.anchor instanceof HTMLElement ? target.anchor.closest(MODAL_BOUNDARY) ?? document.body : document.body)}
  </>;
}

const CHIP = (active: boolean) => `flex h-6 min-w-0 shrink-0 items-center gap-1 rounded border-2 px-1.5 text-xs ${
  active ? "border-gray-800 bg-gray-200 font-medium text-gray-900" : "border-transparent bg-gray-100 text-gray-700 hover:bg-gray-200"}`;

/** The waterfall: one generation per row, siblings side by side and truncated, the chosen chip giving way to
 *  its children below. Every generation the set can reach keeps its row filled or not, so a reveal shifts nothing. */
export function ResearchLabelWaterfall({ labels, scope, selectedId, onChoose, noneLabel }: {
  labels: Record<string, ResearchLabel>; scope: ResearchLabel["scope"];
  selectedId: string | null; onChoose: (id: string | null) => void; noneLabel?: string }) {
  const { tree, depth } = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).filter((label) => label.scope === scope).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .forEach((label) => { const values = map.get(label.parentId) ?? []; values.push(label); map.set(label.parentId, values); });
    const reach = (id: string | null): number => 1 + Math.max(0, ...(map.get(id) ?? []).map((label) => reach(label.id)));
    return { tree: map, depth: map.size ? reach(null) - 1 : 0 }; }, [labels, scope]);
  const path = selectedId && labels[selectedId] ? researchLabelPath(labels, selectedId) : [];
  if (!depth) return <p className="my-3 text-sm text-gray-500">No {scope === "source" ? "labels" : "highlight types"} yet.</p>;
  return <div className="grid min-w-0 content-start">
    {Array.from({ length: depth }, (_, row) => { const parent = row ? path[row - 1] : null,
      items = row && !parent ? [] : tree.get(parent?.id ?? null) ?? [], active = path[row]?.id ?? null;
      return <div key={row} style={{ marginInlineStart: row ? 8 + (row - 1) * 20 : 0 }}
        className={`flex h-8 min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden py-1 ${row ? "border-s-2 border-gray-200 ps-3" : ""}`}>
        {!row && noneLabel && <button type="button" onClick={() => onChoose(null)} aria-pressed={!selectedId} className={CHIP(!selectedId)}>
          <ResearchLabelFolder labels={labels} labelId={null} size="sm" /><span className="max-w-20 truncate">{noneLabel}</span></button>}
        {items.map((label) => <button key={label.id} type="button" onClick={() => onChoose(label.id)}
          aria-pressed={active === label.id} title={label.name} className={CHIP(active === label.id)}>
          <ResearchLabelFolder labels={labels} labelId={label.id} size="sm" />
          <span className="max-w-24 truncate">{label.name}</span></button>)}
      </div>; })}
  </div>;
}

export function ResearchLabelEditor({ target, onClose, onPreview, onError, mutations }: {
  target: ResearchLabelTarget; onClose: () => void; mutations: ResearchFileMutations;
  onPreview?: (labelIds: string[]) => void; onError?: (message: string) => void;
}) {
  const [slots, setSlots] = useState<string[]>(
    target.kind === "evidence" ? target.labelIds.slice(0, 1) : target.labelIds);
  const [note, setNote] = useState(target.note ?? ""), [file, setFile] = useState(target.file),
    [activeSlot, setActiveSlot] = useState(0);
  const itemId = useRef(target.itemId), sourceId = useRef(target.sourceId), preparing = useRef<Promise<Ready> | null>(null),
    confirmed = useRef(target.file), saveNumber = useRef(0), close = useRef(onClose),
    lastSaved = useRef(JSON.stringify([target.labelIds, target.note ?? ""]));
  const [error, setError] = useState(""), labels = file.state.labels;
  const scope = target.kind === "source" ? "source" : "highlight";
  const popover = useAnchoredPopover({ anchor: target.anchor, onDismiss: () => close.current() });
  useEffect(() => () => (target.returnFocus ?? (target.anchor instanceof HTMLElement ? target.anchor : null))?.focus(),
    [target.anchor, target.returnFocus]);
  const slot = slots[activeSlot] ?? null;
  /** The slot the user is filling always wins: a repeat leaves the other slot, never strands this one. */
  const put = (id: string | null) => {
    const kept = slots.filter((value, index) => index !== activeSlot && value !== id),
      at = Math.min(activeSlot, kept.length);
    const next = scope === "highlight" ? (id ? [id] : [])
      : [...kept.slice(0, at), ...(id ? [id] : []), ...kept.slice(at)];
    setActiveSlot(at);
    setSlots(next); persist(next, note);
  };
  function persist(nextSlots: string[], nextNote: string) {
    const snapshot = JSON.stringify([nextSlots.filter(Boolean), nextNote]);
    if (snapshot === lastSaved.current) return;
    lastSaved.current = snapshot;
    setError(""); onPreview?.(nextSlots.filter(Boolean));
    const request = ++saveNumber.current;
    void (async () => {
      if (!itemId.current) {
        const prepare = target.prepare; if (!prepare) throw new Error("This item is unavailable");
        preparing.current ??= prepare(confirmed.current).catch((reason) => {
          preparing.current = null; throw reason;
        });
        const ready = await preparing.current; itemId.current = ready.itemId; sourceId.current = ready.sourceId;
        confirmed.current = ready.file;
      }
      if (target.kind === "evidence" && !sourceId.current) throw new Error("The saved source is unavailable");
      const action = target.kind === "source" ? { type: "annotate" as const, kind: "source" as const,
        id: itemId.current, labelIds: nextSlots.filter(Boolean), note: nextNote }
        : { type: "annotate" as const, kind: "evidence" as const, id: itemId.current,
          sourceId: sourceId.current!, labelIds: nextSlots.filter(Boolean), note: nextNote };
      const removed = slots.filter((id) => !nextSlots.includes(id)), next = await mutations.act(target.kind === "source" && removed.length
        ? { type: "batch", title: "Update source filings", actions: [
          { type: "label-selection", target: "sources", sourceIds: [itemId.current], assign: removed, mode: "remove" }, action] } : action);
      confirmed.current = next;
      if (request === saveNumber.current) setFile(next);
    })().catch((reason) => { if (request === saveNumber.current) { const message = errorMessage(reason, "Could not save labels");
      lastSaved.current = "";
      setFile(confirmed.current); setError(message); onError?.(message);
      onPreview?.(target.kind === "source"
        ? confirmed.current.state.sources[itemId.current]?.labelIds ?? target.labelIds : target.labelIds);
    } });
  }
  close.current = () => { persist(slots, note); onClose(); };
  return <div ref={popover} role="dialog" aria-label={scope === "source" ? "Labels and note" : "Highlight type and note"} popover="manual"
    className="fixed inset-auto z-[220] m-0 max-h-[min(30rem,calc(100dvh-1rem))] w-[min(420px,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white p-3 shadow-xl">
    <header className="flex min-w-0 items-start gap-3 border-b border-gray-100 pb-2">
      <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold leading-5 text-gray-950">{scope === "source" ? "Labels and note" : "Highlight type and note"}</h2>
        <p className="truncate text-xs leading-4 text-gray-500">{target.title}</p></div>
    <button type="button" onClick={() => close.current()} aria-label="Close label palette"
      className="grid size-8 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><X className="size-4" aria-hidden="true" /></button>
    </header>
    {scope === "source" && <div aria-label="Filed under" className="grid h-24 content-start gap-0.5 overflow-y-auto border-b border-gray-100 py-2">
      {[...slots, ""].map((id, index) => { const name = id ? researchLabelPath(labels, id).map((label) => label.name).join(" / ") : "";
        return <button key={`${id}:${index}`} type="button" onClick={() => setActiveSlot(index)}
          aria-pressed={index === activeSlot} aria-label={id ? `Filed under ${name}` : "Add a label"} title={name || "Add a label"}
          className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-start text-sm ${index === activeSlot ? "bg-gray-100 ring-1 ring-gray-400" : "hover:bg-gray-50"}`}>
          <ResearchLabelFolder labels={labels} labelId={id || null} />
          <span className="min-w-0 flex-1 truncate text-gray-700">{name || "Add a label"}</span>
        </button>; })}
    </div>}
    <div className="min-h-28 min-w-0 border-b border-gray-200 py-2">
      <ResearchLabelWaterfall labels={labels} scope={scope} selectedId={slot} onChoose={put}
        noneLabel={scope === "source" ? "None" : undefined} />
    </div>
    <textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => persist(slots, note)} aria-label="Item note"
      placeholder="Note" className="mt-2 min-h-14 w-full rounded-md border border-gray-300 p-2 text-sm" />
    {error && <p role="status" className="mt-1 text-xs text-red-700">{error}</p>}
  </div>;
}
