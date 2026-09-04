import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, X } from "lucide-react";
import { AssistantDock } from "@/app/components/assistant/AssistantDock";
import { getResearchFile } from "@/app/lib/beaverApi";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { ResearchFileBar } from "./ResearchFileBar";

const PREF = "beaver.research.workspace";
type Box = { x: number; y: number; width: number; height: number };
const clamp = (value: Box): Box => { const width = Math.min(value.width, innerWidth - 16), height = Math.min(value.height, innerHeight - 16);
  return { x: Math.max(8, Math.min(value.x, innerWidth - width - 8)), y: Math.max(8, Math.min(value.y, innerHeight - height - 8)), width, height }; };
const initialBox = (): Box => {
  if (typeof window === "undefined") return { x: 24, y: 48, width: 720, height: 680 };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF) ?? "null") as Partial<Box> | null;
    if (saved?.width && saved.height) return clamp({ x: saved.x ?? 24, y: saved.y ?? 48,
      width: saved.width, height: saved.height });
  } catch { /* Ignore malformed UI preferences. */ }
  return { x: Math.max(16, window.innerWidth - 744), y: 48,
    width: Math.min(720, window.innerWidth - 32), height: Math.min(680, window.innerHeight - 64) };
};

export function ResearchWorkspaceHost({ embedded, open, onOpenChange, file, projectId, onChange }: {
  embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  file: ResearchFile | null; projectId?: string; onChange: (file: ResearchFile) => void;
}) {
  const [box, setBox] = useState(initialBox);
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [restoring, setRestoring] = useState(true);
  const frame = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    const key = `beaver.research.current:${projectId ?? "personal"}`;
    if (file) { localStorage.setItem(key, file.document.id); setRestoring(false); return; }
    const id = localStorage.getItem(key); if (!id) { setRestoring(false); return; }
    let live = true; void getResearchFile(id).then((saved) => { if (live) onChange(saved); })
      .catch(() => { if (localStorage.getItem(key) === id) localStorage.removeItem(key); })
      .finally(() => { if (live) setRestoring(false); });
    return () => { live = false; };
  }, [file, onChange, projectId]);
  useEffect(() => {
    if (!open || !embedded || !frame.current) return;
    if (!globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => setBox((value) => clamp({ ...value,
      width: entry.target.getBoundingClientRect().width,
      height: entry.target.getBoundingClientRect().height })));
    observer.observe(frame.current); return () => observer.disconnect();
  }, [embedded, open]);
  useEffect(() => { if (!open || !embedded) return; const resize = () => setBox(clamp);
    addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, [embedded, open]);
  useEffect(() => {
    if (embedded) try { localStorage.setItem(PREF, JSON.stringify(box)); } catch { /* UI preference only. */ }
  }, [box, embedded]);
  useEffect(() => {
    if (!open || !embedded || !frame.current) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    frame.current.focus();
    return () => { if (opener.current?.isConnected && opener.current.offsetParent !== null)
      opener.current.focus({ preventScroll: true }); };
  }, [embedded, open]);
  const body = <ResearchFileBar file={file} projectId={projectId} onChange={onChange} rail={rail} active={open && !restoring} />;
  if (!embedded) return <AssistantDock
    tabs={[{ id: "research", label: "Workspace", actions: <div ref={setRail} className="min-w-0" />,
      content: <div className="h-[calc(100dvh-7rem)] min-h-80 overflow-hidden p-2 pb-3">{body}</div> }]}
    activeTabId="research" onActivateTab={() => undefined} expanded={open}
    onExpandedChange={onOpenChange} showCollapsedButton={false} defaultWidth={620} minWidth={480} maxWidth="55%" />;
  if (!open) return null;
  if (!file) return createPortal(<div className="fixed size-0 overflow-hidden">{body}</div>, document.body);
  const startDrag = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, left: box.x, top: box.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return createPortal(<section ref={frame} role="dialog" aria-label="Workspace" tabIndex={-1}
    onKeyDown={(event) => { if (event.defaultPrevented || event.key !== "Escape" || event.target instanceof Element &&
      event.target.closest('dialog, [role="dialog"], [role="alertdialog"]') !== event.currentTarget) return;
      event.preventDefault(); onOpenChange(false); }}
    style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    className="fixed z-[200] flex max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] min-h-80 min-w-[min(30rem,calc(100vw-1rem))] resize flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-[0_24px_80px_rgba(17,24,39,0.2)]">
    <header onPointerDown={startDrag}
      onPointerMove={(event) => { const start = drag.current; if (!start) return;
        setBox((value) => ({ ...value,
          x: Math.max(8, Math.min(window.innerWidth - value.width - 8, start.left + event.clientX - start.x)),
          y: Math.max(8, Math.min(window.innerHeight - value.height - 8, start.top + event.clientY - start.y)) })); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      className="flex h-11 shrink-0 cursor-move touch-none items-center gap-2 border-b border-gray-200 bg-white px-2.5">
      <GripHorizontal className="size-4 shrink-0 text-gray-400" aria-hidden="true" />
      <span className="sr-only">Workspace</span><div ref={setRail} className="min-w-0 flex-1" />
      <button type="button" onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onOpenChange(false)} aria-label="Close workspace"
        className="grid size-8 place-items-center rounded-md text-gray-500 hover:bg-red-50 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
        <X className="size-4" aria-hidden="true" />
      </button>
    </header>
    <div className="min-h-0 flex-1 overflow-hidden p-2">{body}</div>
  </section>, document.body);
}
