import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { useAnchoredPopover } from "@/app/hooks/useAnchoredPopover";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelPath, type ResearchFile, type ResearchLabel,
  type ResearchSourceReference } from "@/app/lib/researchFiles";
import { researchLabelColor, ResearchLabelFolder, ResearchLabelMarker } from "./ResearchLabelMarker";
import { ResearchLabelTree } from "./ResearchLabelTree";
import type { ResearchRemoval } from "./ResearchTree";
import { useSourcesWorkspace } from "./SourcesWorkspace";
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
  title: string; disabled?: boolean; size?: "sm" | "md";
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

/** One rung of the waterfall: every folder available under one parent, on its own full-width row.
 *  Each rung says whose children it lists, so a child can never read as a sibling's. */
const Rung = ({ labels, items, activeId, under, onChoose, children }: { labels: Record<string, ResearchLabel>;
  items: ResearchLabel[]; activeId: string | null; under?: string;
  onChoose: (id: string) => void; children?: React.ReactNode }) =>
  <div className="grid min-w-0 gap-1">
    {under && <p className="truncate text-[11px] leading-4 text-gray-500" title={under}>in {under}</p>}
    <div className="flex min-w-0 flex-wrap gap-1">{children}{items.map((label) => <button key={label.id} type="button"
      onClick={() => onChoose(label.id)} aria-pressed={activeId === label.id} title={label.name}
      className={`flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-1.5 text-sm ${activeId === label.id
        ? "border-gray-500 bg-gray-100 font-medium text-gray-900" : "border-gray-200 text-gray-700 hover:bg-gray-50"}`}>
      <ResearchLabelFolder labels={labels} labelId={label.id} />
      <span className="truncate">{label.name}</span>
    </button>)}</div>
  </div>;

/** The waterfall itself: rung after rung down the chosen label's own line of descent. One picker, everywhere. */
export function ResearchLabelWaterfall({ labels, scope, selectedId, onChoose, noneLabel }: {
  labels: Record<string, ResearchLabel>; scope: ResearchLabel["scope"];
  selectedId: string | null; onChoose: (id: string | null) => void; noneLabel?: string }) {
  const tree = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).filter((label) => label.scope === scope).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .forEach((label) => { const values = map.get(label.parentId) ?? []; values.push(label); map.set(label.parentId, values); });
    return map; }, [labels, scope]);
  const path = selectedId && labels[selectedId] ? researchLabelPath(labels, selectedId) : [];
  if (!tree.size) return <p className="my-3 text-sm text-gray-500">No {scope === "source" ? "labels" : "highlight types"} yet.</p>;
  return <div className="grid min-w-0 content-start gap-2">
    <Rung labels={labels} items={tree.get(null) ?? []} activeId={path[0]?.id ?? null} onChoose={onChoose}>
      {noneLabel && <button type="button" onClick={() => onChoose(null)} aria-pressed={!selectedId}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-sm ${selectedId ? "border-gray-200 text-gray-700 hover:bg-gray-50" : "border-gray-500 bg-gray-100 font-medium text-gray-900"}`}>
        <ResearchLabelFolder labels={labels} labelId={null} />{noneLabel}</button>}
    </Rung>
    {path.flatMap((label, depth) => {
      const items = tree.get(label.id) ?? [];
      return items.length ? [<Rung key={label.id} labels={labels} items={items} under={label.name}
        activeId={path[depth + 1]?.id ?? null} onChoose={onChoose} />] : [];
    })}
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
      const next = await mutations.act(action); confirmed.current = next;
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
    {scope === "source" && <div aria-label="Filed under" className="flex items-end gap-2 overflow-x-auto border-b border-gray-100 py-2">
      {[...slots, ""].map((id, index) => <button key={`${id}:${index}`} type="button" onClick={() => setActiveSlot(index)}
        aria-pressed={index === activeSlot} aria-label={id ? `Label slot ${index + 1}: ${labels[id]?.name ?? ""}` : "Add a label"}
        title={id ? researchLabelPath(labels, id).map(({ name }) => name).join(" / ") : "Add a label"}
        className={`flex w-14 shrink-0 flex-col items-center gap-1 rounded-md p-1 ${index === activeSlot ? "bg-gray-100 ring-1 ring-gray-400" : "hover:bg-gray-50"}`}>
        <ResearchLabelFolder labels={labels} labelId={id || null} size="lg" />
        <span className="w-full truncate text-center text-[10px] leading-3 text-gray-600">{id ? labels[id]?.name ?? "" : "Add"}</span>
      </button>)}
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

/** Picking a type picks its colour. Its hierarchy stays behind this one control. */
export function ResearchHighlightTypes({ onRemove, onStatus }: {
  onRemove: (removal: ResearchRemoval) => void; onStatus: (message: string) => void;
}) {
  const { file, highlight } = useSourcesWorkspace(), [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), id = useId();
  const labels = file?.state.labels ?? {}, active = (labels[highlight.pen ?? ""]?.scope === "highlight" ? labels[highlight.pen!] : undefined) ??
    Object.values(labels).filter(({ scope }) => scope === "highlight").sort((a, b) => a.order - b.order)[0];
  const name = active ? researchLabelPath(labels, active.id).map(({ name }) => name).join(" / ") : "Highlight";
  function close() { setOpen(false); button.current?.focus(); }
  const popup = useAnchoredPopover({ anchor: button.current, open, below: true, onDismiss: () => setOpen(false) });
  if (!file) return null;
  return <>
    <button ref={button} type="button" aria-label={`Highlight type: ${name}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(!open)} title={name} className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded border border-gray-300 px-2 text-xs text-gray-700">
      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: active ? researchLabelColor(active) : "#d6b85a" }} />
      <span className="truncate">{name}</span><ChevronDown aria-hidden className="size-3 shrink-0" />
    </button>
    {open && createPortal(<div ref={popup} id={id} role="dialog" aria-label="Highlight types" popover="manual"
      className="fixed inset-auto z-[110] m-0 max-h-[calc(100dvh-1rem)] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 text-gray-700 shadow-lg">
      <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium">Highlight types
        <button type="button" aria-label="Close highlight types" onClick={close} className="grid size-7 place-items-center rounded hover:bg-gray-100"><X aria-hidden className="size-3.5" /></button>
      </div>
      <ResearchLabelTree scope="highlight" selectedId={active?.id ?? null} onSelect={(id) => { if (id) highlight.setPen(id); close(); }}
        onRemove={(removal) => { close(); onRemove(removal); }} onStatus={onStatus} />
    </div>, button.current?.closest(MODAL_BOUNDARY) ?? document.body)}
  </>;
}
