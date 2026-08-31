import { ChevronDown, Copy, FilePlus2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";

type Draft = { id: string; title: string };
export function DraftMenu<T extends Draft>({ drafts, current, busy, itemLabel, onNew, onOpen,
  onRename, onDuplicate, onDelete }: {
  drafts: T[];
  current?: T;
  busy: boolean;
  itemLabel: string;
  onNew: () => void;
  onOpen: (draft: T) => void;
  onRename: (title: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(current?.title ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setTitle(current?.title ?? ""); setConfirmDelete(false); },
    [current?.id, current?.title]);
  const close = (element: HTMLElement) => element.closest("details")?.removeAttribute("open");
  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== current?.title) onRename(next);
    else setTitle(current?.title ?? "");
  };
  return <>
    <details className="group relative min-w-0 max-w-72 flex-1" data-draft-menu>
      <summary className="flex min-h-10 w-full cursor-pointer list-none items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-gray-700">Drafts</span>
        <span className="min-w-0 flex-1 truncate text-gray-950">{current?.title ?? "New draft"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-500 motion-safe:transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-gray-950">Drafts</h2>
          <button type="button" disabled={busy} onClick={(event) => { onNew(); close(event.currentTarget); }} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50"><FilePlus2 className="h-4 w-4" /> New</button>
        </div>
        <div className="max-h-60 overflow-y-auto p-2" aria-label={`${itemLabel} drafts`}>
          {drafts.map((draft) => <button key={draft.id} type="button"
            aria-current={draft.id === current?.id || undefined} disabled={busy}
            onClick={(event) => { onOpen(draft); close(event.currentTarget); }}
            className={cn("block min-h-10 w-full rounded-lg px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-red-600", draft.id === current?.id ? "bg-red-50 font-medium text-red-950" : "text-gray-800 hover:bg-gray-100")}>{draft.title}</button>)}
          {!drafts.length && <p className="px-2 py-5 text-center text-sm text-gray-500">No saved drafts</p>}
        </div>
        {current && <div className="border-t border-gray-200 p-3">
          <label className="block text-xs font-medium text-gray-600">Draft name
            <Input value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle} onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") { setTitle(current.title); event.currentTarget.blur(); }
              }} className="mt-1 h-9 border-gray-400 md:text-base" />
          </label>
          <div className="mt-2 flex items-center gap-1">
            <button type="button" disabled={busy} onClick={onDuplicate} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50"><Copy className="h-4 w-4" /> Duplicate</button>
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50"><Trash2 className="h-4 w-4" /> Delete</button>
          </div>
        </div>}
      </div>
    </details>
    <ConfirmPopup open={confirmDelete} title="Delete draft?"
      message={`Permanently delete ${current?.title ?? `this ${itemLabel} draft`}?`}
      confirmLabel="Delete" confirmStatus={busy ? "loading" : "idle"}
      onCancel={() => !busy && setConfirmDelete(false)} onConfirm={onDelete} />
  </>;
}
