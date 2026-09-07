import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { errorMessage } from "@/app/lib/utils";
import { type ResearchFile, type ResearchLabel,
  type ResearchSourceReference } from "@/app/lib/researchFiles";
import { researchLabelColor, ResearchLabelCircle } from "./ResearchLabelCircle";
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
      <ResearchLabelCircle labels={file?.state.labels ?? {}} labelIds={previewLabelIds} size={size ?? (kind === "source" ? "md" : "sm")} />
    </button>
    {target && createPortal(<ResearchLabelEditor target={target} mutations={mutations} onError={onError}
      onClose={() => setTarget(null)} onPreview={setPreviewLabelIds} />,
      target.anchor instanceof HTMLElement ? target.anchor.closest(MODAL_BOUNDARY) ?? document.body : document.body)}
  </>;
}

const Dot = ({ file, id, active, onClick }: { file: ResearchFile; id: string;
  active: boolean; onClick: () => void }) => <button type="button" onClick={onClick}
  aria-pressed={active} title={file.state.labels[id].name}
  className={`flex min-h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-start text-sm ${active
    ? "bg-gray-200 text-gray-900 ring-1 ring-inset ring-gray-500" : "bg-gray-50 text-gray-700 hover:bg-gray-100"}`}>
  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: researchLabelColor(file.state.labels[id]) }} />
  <span className="min-w-0 break-words">{file.state.labels[id].name}</span>
</button>;

export function ResearchLabelEditor({ target, onClose, onPreview, onError, mutations }: {
  target: ResearchLabelTarget; onClose: () => void; mutations: ResearchFileMutations;
  onPreview?: (labelIds: string[]) => void; onError?: (message: string) => void;
}) {
  const popover = useRef<HTMLDivElement>(null), [slots, setSlots] = useState<string[]>(
    target.kind === "evidence" ? target.labelIds.slice(0, 1) : target.labelIds);
  const [note, setNote] = useState(target.note ?? ""), [file, setFile] = useState(target.file),
    [search, setSearch] = useState("");
  const itemId = useRef(target.itemId), sourceId = useRef(target.sourceId), preparing = useRef<Promise<Ready> | null>(null),
    confirmed = useRef(target.file), saveNumber = useRef(0), close = useRef(onClose),
    lastSaved = useRef(JSON.stringify([target.labelIds, target.note ?? ""]));
  const [error, setError] = useState(""), labels = file.state.labels;
  const scope = target.kind === "source" ? "source" : "highlight";
  const tree = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).filter((label) => label.scope === scope).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .forEach((label) => { const values = map.get(label.parentId) ?? []; values.push(label); map.set(label.parentId, values); });
    return map; }, [labels, scope]);
  const roots = tree.get(null) ?? [];
  const visible = (items: ResearchLabel[]): ResearchLabel[] => !search ? items : items.filter((label) =>
    label.name.toLowerCase().includes(search.toLowerCase()) || visible(tree.get(label.id) ?? []).length);
  useLayoutEffect(() => {
    const node = popover.current, anchor = target.anchor; if (!node) return;
    if (typeof node.showPopover === "function") try { node.showPopover(); }
    catch { node.removeAttribute("popover"); }
    else node.removeAttribute("popover");
    let frame = 0;
    const place = () => {
      const box = node.getBoundingClientRect(), rect = anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect() : anchor;
      const dock = [...document.querySelectorAll<HTMLElement>("[data-assistant-dock]")]
        .map((element) => element.getBoundingClientRect())
        .filter((candidate) => candidate.width > 200 && (!rect || candidate.left > rect.left))
        .sort((left, right) => left.left - right.left)[0];
      const right = dock && rect && rect.left < dock.left ? dock.left - 8 : innerWidth - 8,
        maxLeft = Math.max(8, right - box.width), beside = rect?.right && rect.right + box.width + 8 <= right
          ? rect.right + 8 : rect && rect.left - box.width - 8 >= 8 ? rect.left - box.width - 8
            : (innerWidth - box.width) / 2;
      node.style.left = `${Math.max(8, Math.min(beside, maxLeft))}px`;
      node.style.top = `${Math.max(8, Math.min(rect?.top ?? (innerHeight - box.height) / 2,
        Math.max(8, innerHeight - box.height - 8)))}px`;
    };
    const reclamp = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    node.querySelector<HTMLElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!node.contains(event.target as Node) &&
          !(anchor instanceof HTMLElement && anchor.contains(event.target as Node))) close.current();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close.current(); } };
    const observer = globalThis.ResizeObserver ? new ResizeObserver(reclamp) : null;
    observer?.observe(node);
    document.addEventListener("pointerdown", dismiss);
    node.addEventListener("keydown", keydown);
    window.addEventListener("resize", reclamp);
    window.addEventListener("scroll", reclamp, true);
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect();
      document.removeEventListener("pointerdown", dismiss);
      node.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", reclamp);
      window.removeEventListener("scroll", reclamp, true);
      try { node.hidePopover?.(); } catch { /* Already closed or unsupported. */ }
      (target.returnFocus ?? (anchor instanceof HTMLElement ? anchor : null))?.focus();
    };
  }, [target.anchor, target.returnFocus]);
  const choose = (id: string) => {
    const next = scope === "highlight" ? [id] : slots.includes(id)
      ? slots.filter((value) => value !== id) : [...slots, id];
    setSlots(next); persist(next, note);
  };
  const clear = () => { setSlots([]); persist([], note); };
  function choices(items: ResearchLabel[]) {
    return visible(items).map((label) => <div key={label.id}>
      <Dot file={file} id={label.id} active={slots.includes(label.id)} onClick={() => choose(label.id)} />
      {!!tree.get(label.id)?.length && <div className="ms-3 border-s border-gray-100 ps-2">
        {choices(tree.get(label.id)!)}
      </div>}
    </div>);
  }
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
    {!tree.size ? <p className="my-3 text-sm text-gray-500">
      No {scope === "source" ? "labels" : "highlight types"} yet.
    </p> : <div className="mt-2 grid gap-1 border-b border-gray-200 pb-2">
      {Object.values(labels).filter((label) => label.scope === scope).length > 6 && <input type="search" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)}
        aria-label={`Search ${scope === "source" ? "labels" : "highlight types"}`} placeholder="Search"
        className="h-8 min-w-0 rounded-md border border-gray-300 px-2 text-sm" />}
      {choices(roots)}
      {scope === "source" && slots.length > 0 && <button type="button" onClick={clear}
        className="justify-self-start px-1.5 py-1 text-xs text-gray-500 underline">Clear labels</button>}
    </div>}
    <label className="mt-2 grid gap-1 text-sm font-medium text-gray-700">Note
      <textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => persist(slots, note)} aria-label="Item note"
        placeholder="Add a note" className="min-h-16 w-full rounded-md border border-gray-300 p-2 text-sm font-normal" />
    </label>
    <div className="mt-2 flex items-center justify-end gap-2">
      {error && <span role="status" className="me-auto text-xs text-red-700">{error}</span>}
      <button type="button" onClick={() => close.current()} className="h-8 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">Done</button>
    </div>
  </div>;
}
