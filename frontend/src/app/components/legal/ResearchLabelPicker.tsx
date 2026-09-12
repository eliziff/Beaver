import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, X } from "lucide-react";
import { useAnchoredPopover } from "@/app/hooks/useAnchoredPopover";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelPath, type ResearchFile, type ResearchLabel,
  type ResearchSourceReference } from "@/app/lib/researchFiles";
import { researchLabelColor, ResearchLabelFolder, ResearchLabelMarker } from "./ResearchLabelMarker";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
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
    <button type="button" data-source-marker={kind === "source" ? itemId : undefined} draggable={kind === "source" && !!(itemId || sourceReference)} onDragStart={(event) => {
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

/** One scope's labels grouped under their parent, each level in its saved order. */
export function researchLabelChildren(labels: Record<string, ResearchLabel>, scope: ResearchLabel["scope"]) {
  const map = new Map<string | null, ResearchLabel[]>();
  Object.values(labels).filter((label) => label.scope === scope).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .forEach((label) => { const values = map.get(label.parentId) ?? []; values.push(label); map.set(label.parentId, values); });
  return map;
}

const ROW_CHOICE = (chosen: boolean, cursor: boolean) => `flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-start text-xs ${
  chosen ? "bg-gray-200 font-medium text-gray-900" : "text-gray-700 hover:bg-gray-100"} ${cursor ? "ring-1 ring-inset ring-gray-400" : ""}`;

/** One level at a time: crumbs back up, a filter that reaches every level, and a vertical list. */
export function ResearchLabelBrowser({ labels, scope, selectedId, onChoose, noneLabel }: {
  labels: Record<string, ResearchLabel>; scope: ResearchLabel["scope"];
  selectedId: string | null; onChoose: (id: string | null) => void; noneLabel?: string }) {
  const tree = useMemo(() => researchLabelChildren(labels, scope), [labels, scope]);
  const selected = selectedId && labels[selectedId]?.scope === scope ? labels[selectedId] : null;
  /** Open where the current choice lives, so the user sees it without walking back down. */
  const [levelId, setLevelId] = useState<string | null>(selected?.parentId ?? null);
  const [filter, setFilter] = useState(""), [active, setActive] = useState(0);
  const crumbs = levelId && labels[levelId] ? researchLabelPath(labels, levelId) : [];
  const query = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!query) return tree.get(levelId) ?? [];
    return [...tree.values()].flat().filter((label) => label.name.toLowerCase().includes(query));
  }, [tree, levelId, query]);
  const none = !query && !levelId && !!noneLabel;
  const choices: (ResearchLabel | null)[] = none ? [null, ...rows] : rows;
  const at = Math.min(active, Math.max(choices.length - 1, 0));
  const descend = (label: ResearchLabel) => { setLevelId(label.id); setFilter(""); setActive(0); };
  function key(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault();
      setActive((index) => (Math.min(index, choices.length - 1) + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % Math.max(choices.length, 1)); }
    else if (event.key === "Enter" && choices.length) { event.preventDefault(); onChoose(choices[at]?.id ?? null); }
    else if (event.key === "ArrowRight" && choices[at] && tree.get(choices[at]!.id)?.length) { event.preventDefault(); descend(choices[at]!); }
    else if (event.key === "ArrowLeft" && levelId) { event.preventDefault(); setLevelId(labels[levelId]?.parentId ?? null); setActive(0); }
  }
  /** Escape reaches the panel natively, so the filter has to claim it at the target before the popover closes. */
  const filterRef = (node: HTMLInputElement | null) => { if (!node || node.dataset.labelEscape) return;
    node.dataset.labelEscape = "on";
    node.addEventListener("keydown", (event) => { if (event.key === "Escape" && node.value) {
      event.preventDefault(); event.stopPropagation(); setFilter(""); setActive(0); } }); };
  if (!tree.size) return <p className="my-2 text-xs text-gray-500">No {scope === "source" ? "labels" : "highlight types"} yet.</p>;
  /** The deepest crumbs stay legible: the middle ones collapse to an ellipsis before they wrap. */
  const shown = crumbs.length > 2 ? [crumbs[crumbs.length - 2], crumbs[crumbs.length - 1]] : crumbs;
  return <div className="mb-1.5 grid min-w-0 gap-1 overflow-x-hidden">
    <div role="group" aria-label="Label levels" className="flex min-w-0 items-center gap-0.5 text-[11px] text-gray-600">
      <button type="button" onClick={() => { setLevelId(null); setActive(0); }} title={noneLabel ?? "All"}
        className="max-w-32 shrink-0 truncate rounded px-1 py-0.5 hover:bg-gray-100">{scope === "source" ? "Labels" : "Highlight types"}</button>
      {crumbs.length > 2 && <span aria-hidden className="shrink-0">/ …</span>}
      {shown.map((crumb) => <span key={crumb.id} className="flex min-w-0 items-center gap-0.5">
        <span aria-hidden className="shrink-0">/</span>
        <button type="button" onClick={() => { setLevelId(crumb.id); setActive(0); }} title={crumb.name}
          className="min-w-0 truncate rounded px-1 py-0.5 hover:bg-gray-100">{crumb.name}</button></span>)}
    </div>
    <input ref={filterRef} value={filter} onChange={(event) => { setFilter(event.target.value); setActive(0); }} onKeyDown={key}
      data-label-filter autoFocus role="combobox" aria-expanded aria-controls="research-label-list"
      aria-label={scope === "source" ? "Find a label" : "Find a highlight type"} placeholder="Type to find"
      className="block min-h-7 w-full rounded border border-gray-300 px-[7px] py-[3px] text-xs" />
    <div id="research-label-list" role="listbox" aria-label="Labels"
      className="grid max-h-[22rem] min-w-0 gap-px overflow-y-auto overflow-x-hidden overscroll-contain">
      {none && <button type="button" onClick={() => onChoose(null)} aria-pressed={!selectedId} className={ROW_CHOICE(!selectedId, at === 0)}>
        <FolderSvgIcon className="size-3.5 shrink-0 text-gray-400" /><span className="min-w-0 truncate">{noneLabel}</span></button>}
      {rows.map((label, index) => { const children = tree.get(label.id)?.length,
        path = query ? researchLabelPath(labels, label.id).slice(0, -1).map((step) => step.name).join(" / ") : "";
        return <div key={label.id} className="flex min-w-0 items-center gap-0.5">
          <button type="button" onClick={() => onChoose(label.id)} aria-pressed={selectedId === label.id}
            title={label.name} className={ROW_CHOICE(selectedId === label.id, at === index + (none ? 1 : 0))}>
            {/* A label reads as a filled folder wherever the dock shows one (Eli, 2026-09-09). */}
            <FolderSvgIcon fill="currentColor" className="size-3.5 shrink-0" style={{ color: researchLabelColor(label) }} />
            <span className="min-w-0 truncate">{label.name}</span>
            {!!path && <span className="min-w-0 shrink truncate text-[10px] text-gray-500">{path}</span>}
          </button>
          {!!children && <button type="button" onClick={() => descend(label)} aria-label={`Open ${label.name}`}
            title={`Open ${label.name}`} className="grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-100">
            <ChevronRight aria-hidden className="size-4" /></button>}
        </div>; })}
      {!choices.length && <p className="px-1.5 py-1 text-xs text-gray-500">No matches.</p>}
    </div>
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
  const popover = useAnchoredPopover({ anchor: target.anchor, below: true, stationary: true, onDismiss: () => close.current() });
  useEffect(() => { const timer = setTimeout(() => popover.current?.querySelector<HTMLInputElement>("[data-label-filter]")?.focus(), 0);
    return () => clearTimeout(timer); }, [popover]);
  useEffect(() => () => { const trigger = target.returnFocus ?? (target.anchor instanceof HTMLElement ? target.anchor : null);
    (trigger?.isConnected ? trigger : [...document.querySelectorAll<HTMLElement>("[data-source-marker]")].find((node) => node.dataset.sourceMarker === target.itemId))?.focus();
  }, [target.anchor, target.returnFocus, target.itemId]);
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
  useEffect(() => { const timer = setTimeout(() => persist(slots, note), 300);
    return () => clearTimeout(timer); }, [note, slots]);
  return <div ref={popover} role="dialog" aria-label={scope === "source" ? "Labels and note" : "Highlight type and note"} popover="manual"
    className="fixed inset-auto z-[220] m-0 max-h-[80vh] w-[min(446px,calc(100vw-12px))] overflow-y-auto overscroll-contain rounded-lg border border-gray-300 bg-white px-3 py-2.5 shadow-lg">
    <button type="button" onClick={() => close.current()} aria-label="Close label palette"
      className="absolute end-1.5 top-1 grid size-[34px] place-items-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"><X className="size-5" aria-hidden="true" /></button>
    {scope === "source" && <div aria-label="Filed under" className="mb-1 flex min-h-14 items-end gap-1.5 overflow-x-auto border-b border-gray-200 pb-1 pt-1.5 pe-9">
      {[...slots, ""].map((id, index) => { const name = id ? researchLabelPath(labels, id).map((label) => label.name).join(" / ") : "";
        return <button key={`${id}:${index}`} type="button" onClick={() => setActiveSlot(index)}
          aria-pressed={index === activeSlot} aria-label={id ? `Filed under ${name}` : "Add a label"} title={name || "Add a label"}
          className={`flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-md p-[3px] ${index === activeSlot ? "bg-gray-200 ring-1 ring-inset ring-gray-800" : "hover:bg-gray-100"}`}>
          <ResearchLabelFolder labels={labels} labelId={id || null} size="lg" />
          <span className="w-full truncate text-center text-[10px] text-gray-700">{id ? labels[id]?.name : "Add label"}</span>
        </button>; })}
    </div>}
    <div className={`min-w-0 ${scope === "highlight" ? "pt-6" : "mt-0.5"}`}>
      <ResearchLabelBrowser key={slot ?? "none"} labels={labels} scope={scope} selectedId={slot} onChoose={put}
        noneLabel={scope === "source" ? "None" : undefined} />
    </div>
    <textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => persist(slots, note)} aria-label="Item note"
      rows={1} placeholder="Note" className="mt-1 block min-h-9 w-full resize-y rounded border border-gray-300 px-[7px] py-[5px] text-xs" />
    {error && <p role="status" className="mt-1 text-xs text-red-700">{error}</p>}
  </div>;
}
