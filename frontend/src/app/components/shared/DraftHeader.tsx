import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { MoreActionsMenu } from "./MoreActionsMenu";

type Draft = { id: string; title: string };

export function DraftHeader({ current, busy, itemLabel, headerActions, className, onBack,
  onRename, onDuplicate, onDelete }: {
  current: Draft;
  busy: boolean;
  itemLabel: string;
  headerActions?: ReactNode;
  className?: string;
  onBack: () => void;
  onRename: (title: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(current.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelRename = useRef(false);
  useEffect(() => {
    setEditing(false); setTitle(current.title); setConfirmDelete(false);
  }, [current.id, current.title]);
  const startRename = () => {
    cancelRename.current = false; setTitle(current.title); setEditing(true);
  };
  const commitRename = () => {
    if (cancelRename.current) { cancelRename.current = false; return; }
    const next = title.trim();
    setEditing(false);
    if (next && next !== current.title) onRename(next);
    else setTitle(current.title);
  };
  return <>
    <div className={cn("builder-header mx-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:px-6", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" disabled={busy} onClick={onBack} aria-label={`Back from ${itemLabel}`}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-950 disabled:opacity-50">
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Back</span>
        </button>
        {editing ? <Input autoFocus aria-label={`Rename ${itemLabel}`} value={title}
          disabled={busy} onChange={(event) => setTitle(event.target.value)}
          onBlur={commitRename} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") {
              event.preventDefault(); cancelRename.current = true;
              setTitle(current.title); setEditing(false);
            }
          }} className="h-10 max-w-xl border-gray-400 font-serif text-lg font-semibold" />
          : <h1 className="truncate font-serif text-xl font-semibold leading-tight text-gray-950 sm:text-2xl">
            {current.title}
          </h1>}
      </div>
      <div className="flex items-center justify-self-end gap-2">
        {headerActions}
        <MoreActionsMenu label={`${itemLabel} actions`}
          triggerClassName="h-10 w-10 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-950"
          items={[
            { label: "Rename", disabled: busy, onSelect: startRename },
            { label: "Duplicate", disabled: busy, onSelect: onDuplicate },
            { label: "Delete", disabled: busy, onSelect: () => setConfirmDelete(true) },
          ]} />
      </div>
    </div>
    <ConfirmPopup open={confirmDelete} title={`Delete ${itemLabel}?`}
      message={`Permanently delete ${current.title}?`} confirmLabel="Delete"
      confirmStatus={busy ? "loading" : "idle"} onConfirm={onDelete}
      onCancel={() => !busy && setConfirmDelete(false)} />
  </>;
}
