import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { useAnchoredPopover } from "@/app/hooks/useAnchoredPopover";
import { researchLabelPath } from "@/app/lib/researchFiles";
import { researchLabelColor } from "./ResearchLabelMarker";
import { ResearchLabelTree } from "./ResearchLabelTree";
import type { ResearchRemoval } from "./ResearchTree";
import { useSourcesWorkspace } from "./SourcesWorkspace";

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
    </div>, button.current?.closest('dialog,[data-assistant-dock]') ?? document.body)}
  </>;
}
