import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actOnResearchFile, getResearchFile } from "@/app/lib/beaverApi";
import { BeaverApiError } from "@/app/lib/apiTransport";
import { errorMessage } from "@/app/lib/utils";
import { researchLabelPath, type ResearchFile } from "@/app/lib/researchFiles";
import { ResearchLabelCircle } from "./ResearchLabelCircle";

type Ready = { file: ResearchFile; itemId: string };
export type ResearchLabelTarget = Ready & { kind: "source" | "evidence"; labelIds: string[];
  badge?: string; badgeColor?: string; note?: string; title: string; anchor?: HTMLElement | DOMRect; returnFocus?: HTMLElement;
  prepare?: (file: ResearchFile) => Promise<Ready> };

export function ResearchLabelPicker({ file, kind, itemId, labelIds, note, title,
  badge, badgeColor, buttonLabel, size, disabled, onChange, prepare, prepareFile }: { file: ResearchFile | null;
  kind: ResearchLabelTarget["kind"]; itemId?: string; labelIds: string[]; note?: string;
  title: string; disabled?: boolean; badge?: string; badgeColor?: string; buttonLabel?: string; size?: "sm" | "md";
  onChange: (file: ResearchFile) => void; prepare?: (file: ResearchFile) => Promise<Ready>;
  prepareFile?: () => Promise<ResearchFile> }) {
  const [target, setTarget] = useState<ResearchLabelTarget | null>(null), [preparing, setPreparing] = useState(false),
    [error, setError] = useState("");
  const preparingRef = useRef(false);
  const visibleBadge = badge?.trim() ? buttonLabel ?? badge : "";
  return <>
    <button type="button" draggable={kind === "source" && !!itemId} onDragStart={(event) => {
      if (itemId) event.dataTransfer.setData("application/x-beaver-research-source", itemId); }}
      disabled={disabled || preparing || !file && !prepareFile} aria-busy={preparing || undefined}
      onClick={async (event) => {
      event.stopPropagation(); const anchor = event.currentTarget;
      if (preparingRef.current) return; setError("");
      try { preparingRef.current = true; setPreparing(true);
        const destination = file ?? await prepareFile?.(); if (!destination) return;
        onChange(destination); setTarget({ file: destination, kind, itemId: itemId ?? "",
          labelIds, badge, badgeColor, note, title, prepare, anchor });
      } catch (reason) { setError(errorMessage(reason, "Could not prepare research")); }
      finally { preparingRef.current = false; setPreparing(false); } }}
      aria-label={`Label ${title}`} title={[...labelIds.map((id) => file?.state.labels[id]?.name), badge?.trim(), note?.trim()].filter(Boolean).join(" · ") || "Add labels and note"}
      className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-40">
      <ResearchLabelCircle labels={file?.state.labels ?? {}} labelIds={labelIds} size={size ?? (kind === "source" ? "md" : "sm")} />
      {visibleBadge && <span className="max-w-24 truncate rounded px-1.5 py-0.5 text-xs leading-4 text-white"
        style={{ backgroundColor: badgeColor ?? "#666666" }}>
        {visibleBadge}
      </span>}
    </button>
    {error && <span role="alert" className="max-w-48 text-xs text-red-700">{error}</span>}
    {target && createPortal(<ResearchLabelEditor target={target} onClose={() => setTarget(null)} onChange={onChange} />,
      target.anchor instanceof HTMLElement ? target.anchor.closest("dialog") ?? document.body : document.body)}
  </>;
}

const Dot = ({ file, id, active, onClick }: { file: ResearchFile; id: string;
  active: boolean; onClick: () => void }) => <button type="button" onClick={onClick}
  className={`flex min-h-8 max-w-full items-center gap-1.5 rounded px-2 text-left text-xs ${active
    ? "bg-gray-200 font-semibold text-gray-900" : "text-gray-600 hover:bg-gray-50"}`}>
  <span className="size-3 shrink-0 rounded-full border border-gray-300"
    style={{ background: file.state.labels[id].color ?? "#9ca3af" }} />
  <span className="max-w-28 truncate">{file.state.labels[id].name}</span>
</button>;

export function ResearchLabelEditor({ target, onClose, onChange }: {
  target: ResearchLabelTarget; onClose: () => void; onChange: (file: ResearchFile) => void;
}) {
  const popover = useRef<HTMLDivElement>(null), [slots, setSlots] = useState<string[]>(
    target.labelIds.length ? target.labelIds : [""]), [active, setActive] = useState(0);
  const [note, setNote] = useState(target.note ?? ""), [busy, setBusy] = useState(false);
  const [badge, setBadge] = useState(target.badge ?? ""), [badgeColor, setBadgeColor] = useState(target.badgeColor ?? "#666666");
  const [error, setError] = useState(""), labels = target.file.state.labels;
  const selected = slots[active] || "", path = selected ? researchLabelPath(labels, selected) : [];
  const scope = target.kind === "source" ? "source" : "highlight";
  const available = Object.values(labels).filter((label) => label.scope === scope)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const roots = available.filter(({ parentId }) => !parentId),
    children = (id?: string) => id ? available.filter(({ parentId }) => parentId === id) : [],
    level1 = children(path[0]?.id), level2 = children(path[1]?.id);
  useLayoutEffect(() => {
    const node = popover.current, anchor = target.anchor; if (!node) return;
    const box = node.getBoundingClientRect(), rect = anchor instanceof HTMLElement
      ? anchor.getBoundingClientRect() : anchor;
    const dock = [...document.querySelectorAll<HTMLElement>('[aria-label="Assistant dock"]')]
      .map((element) => element.getBoundingClientRect())
      .filter((candidate) => candidate.width > 200 && (!rect || candidate.left > rect.left))
      .sort((left, right) => left.left - right.left)[0];
    const rightEdge = dock && rect && rect.left < dock.left ? dock.left - 8 : innerWidth - 8;
    const beside = rect && rect.right + box.width + 8 <= rightEdge ? rect.right + 8
      : rect && rect.left - box.width - 8 >= 8 ? rect.left - box.width - 8
        : Math.max(8, rightEdge - box.width);
    node.style.left = `${Math.max(8, Math.min(beside ?? (innerWidth - box.width) / 2,
      rightEdge - box.width))}px`;
    const top = rect?.top ?? (innerHeight - box.height) / 2;
    node.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`;
    node.querySelector<HTMLElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!node.contains(event.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(event.target as Node))) onClose();
    };
    const closeOnViewportChange = (event: Event) => { if (!node.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      (target.returnFocus ?? (anchor instanceof HTMLElement ? anchor : null))?.focus();
    };
  }, [target.anchor, target.returnFocus]);
  const choose = (id: string) => setSlots((current) => {
    const next = [...current], duplicate = next.indexOf(id), previous = next[active];
    next[active] = id;
    if (id && duplicate >= 0 && duplicate !== active) next[duplicate] = previous;
    return next;
  });
  const moveTo = (from: number, destination: number) => {
    if (destination < 0 || destination >= slots.length || from === destination) return;
    setSlots((current) => { const next = [...current]; next.splice(destination, 0, next.splice(from, 1)[0]); return next; });
    setActive(destination);
  };
  const clear = () => {
    setSlots((current) => current.length === 1 ? [""] : current.filter((_, index) => index !== active));
    setActive((value) => Math.max(0, value - 1));
  };
  async function save() {
    if (!slots.some(Boolean) && !note.trim() && !badge.trim() && target.itemId
      && !target.labelIds.length && !target.note?.trim() && !target.badge?.trim())
      return onClose();
    setBusy(true); setError("");
    try {
      const ready = target.itemId ? { file: target.file, itemId: target.itemId }
        : await target.prepare?.(target.file);
      if (!ready) throw new Error("This item is unavailable");
      const action = {
        type: "annotate", kind: target.kind, id: ready.itemId,
        labelIds: slots.filter(Boolean), note,
        ...(target.kind === "source" ? { badge: badge.trim().slice(0, 19), badgeColor } : {}) } as const;
      let next: ResearchFile;
      try { next = await actOnResearchFile(ready.file.document.id, ready.file.versionId, action); }
      catch (reason) { if (!(reason instanceof BeaverApiError) || reason.status !== 409) throw reason;
        const latest = await getResearchFile(ready.file.document.id);
        next = await actOnResearchFile(latest.document.id, latest.versionId, action); }
      onChange(next); onClose();
    } catch (reason) { setError(errorMessage(reason, "Could not save labels")); }
    finally { setBusy(false); }
  }
  return <div ref={popover} role="dialog" aria-label="Labels and note"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    onToggle={(event) => {
    if (event.newState === "closed") onClose(); }}
    className="fixed z-[220] m-0 max-h-[min(28rem,calc(100dvh-1rem))] w-[min(420px,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-lg border border-gray-300 bg-white p-2.5 shadow-xl">
    <span className="sr-only">{target.title}</span>
    <button type="button" onClick={onClose} aria-label="Close label palette"
      className="absolute end-2 top-2 grid size-7 place-items-center rounded text-lg leading-none text-gray-500 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">×</button>
    <div className="flex gap-2 overflow-x-auto border-b border-gray-200 pe-8 pb-2">
      {slots.map((id, index) => <button type="button" key={`${id}:${index}`} draggable onClick={() => setActive(index)}
        onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault(); moveTo(Number(event.dataTransfer.getData("text/plain")), index); }}
        aria-label={index ? `Extra label ${index}` : "Display label"}
        className={`flex w-24 shrink-0 flex-col items-center rounded p-1 ${active === index ? "bg-gray-200" : ""}`}>
        <ResearchLabelCircle labels={labels} labelIds={id ? [id] : []} />
        <span className="mt-0.5 max-w-24 truncate text-xs text-gray-700">{id ? labels[id]?.name : index ? `Extra label ${index}` : "Display label"}</span>
        {!index && id && <span className="text-xs font-semibold text-gray-500">Display</span>}
      </button>)}
      {slots.some(Boolean) && <button type="button" onClick={() => {
        setSlots((values) => [...values, ""]); setActive(slots.length); }}
        aria-label="Add an extra label" className="size-9 shrink-0 self-center rounded-full border-2 border-dashed border-gray-300" />}
    </div>
    <div className="mt-1 flex justify-end gap-1">
      {active > 0 && <button type="button" onClick={() => moveTo(active, 0)}
        className="h-7 rounded px-1.5 text-xs text-gray-600 hover:bg-gray-100">Set as display label</button>}
      <button type="button" onClick={clear}
        className="h-7 rounded px-1.5 text-xs text-gray-500 hover:bg-gray-100">Clear this slot</button>
    </div>
    {!available.length ? <p className="my-3 text-center text-xs text-gray-500">
      No {scope === "source" ? "labels" : "highlight categories"} yet.
    </p> : <div className="mt-2 grid gap-1 border-b border-gray-200 pb-2">
      <div className="flex min-w-0 flex-wrap gap-1">
        <button type="button" onClick={clear}
          className={`min-h-8 rounded px-1.5 text-left text-xs ${selected ? "text-gray-500 hover:bg-gray-50" : "bg-gray-200 font-semibold"}`}>None</button>
        {roots.map(({ id }) => <Dot key={id} file={target.file} id={id}
          active={path[0]?.id === id} onClick={() => choose(id)} />)}
      </div>
      {!!level1.length && <div className="ms-3 flex min-w-0 flex-wrap gap-1 border-s-2 border-gray-100 ps-2">
        {level1.map(({ id }) => <Dot key={id} file={target.file} id={id}
          active={path[1]?.id === id} onClick={() => choose(id)} />)}
      </div>}
      {!!level2.length && <div className="ms-6 flex min-w-0 flex-wrap gap-1 border-s-2 border-gray-100 ps-2">
        {level2.map(({ id }) => <Dot key={id} file={target.file} id={id}
          active={path[2]?.id === id} onClick={() => choose(id)} />)}
      </div>}
    </div>}
    <textarea value={note} onChange={(event) => setNote(event.target.value)} aria-label="Item note"
      placeholder="Note..." className="mt-2 min-h-14 w-full rounded border border-gray-300 p-2 text-xs" />
    {target.kind === "source" && <div className="mt-2 text-xs font-medium text-gray-600">
      <label htmlFor="research-badge">Badge:</label>
      <div className="mt-0.5 flex items-center gap-2"><input type="color" value={badgeColor}
        onChange={(event) => setBadgeColor(event.target.value)} aria-label="Badge color" className="size-8 rounded border p-1" />
        <input id="research-badge" value={badge} maxLength={19}
        placeholder="Text (max 19 characters)" onChange={(event) => setBadge(event.target.value)}
        className="h-8 min-w-0 flex-1 rounded border border-gray-300 px-2 text-xs font-normal text-gray-800" />
        {badge.trim() && <span className="max-w-24 truncate rounded px-1.5 py-1 text-xs text-white"
          style={{ backgroundColor: badgeColor }}>{badge}</span>}
      </div>
    </div>}
    <div className="mt-2 flex items-center justify-end gap-2">
      {error && <span role="status" className="me-auto text-xs text-red-700">{error}</span>}
      <button type="button" onClick={onClose} className="px-2 py-1.5 text-xs text-gray-500">Cancel</button>
      <button type="button" disabled={busy} onClick={() => void save()}
        className="rounded bg-gray-950 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
        {busy ? "Saving..." : "Save"}
      </button>
    </div>
  </div>;
}
