import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { Input } from "@/app/components/ui/input";
import { MoreActionsMenu } from "./MoreActionsMenu";
import { PageHeader } from "./PageHeader";

type Draft = { id: string; title: string };
type Active = { current: Draft; itemLabel: string; onBack(): void;
  onRename(title: string): void; onDuplicate(): void; onDelete(): void };
type Static = { current?: never; title: string };

export function WorkspaceHeader(props: (Active | Static) & { busy?: boolean;
  headerActions?: ReactNode; className?: string }) {
  const current = props.current, busy = props.busy ?? false;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(current?.title ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelRename = useRef(false);
  useEffect(() => {
    setEditing(false); setTitle(current?.title ?? ""); setConfirmDelete(false);
  }, [current?.id, current?.title]);
  const commitRename = () => {
    if (!current || !("onRename" in props) || cancelRename.current) {
      cancelRename.current = false; return;
    }
    const next = title.trim(); setEditing(false);
    if (next && next !== current.title) props.onRename(next); else setTitle(current.title);
  };
  const menu = current && "onRename" in props ? <MoreActionsMenu
    label={`${props.itemLabel} actions`}
    triggerClassName="h-9 w-9 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-950"
    items={[
      { label: "Rename", disabled: busy, onSelect: () => {
        cancelRename.current = false; setTitle(current.title); setEditing(true);
      } },
      { label: "Duplicate", disabled: busy, onSelect: props.onDuplicate },
      { label: "Delete", disabled: busy, onSelect: () => setConfirmDelete(true) },
    ]} /> : null;
  const actions = props.headerActions || menu ? [{ type: "custom" as const,
    render: <div className="flex min-h-9 items-center gap-2">{props.headerActions}{menu}</div> }] : undefined;
  return <header data-workspace-header className="shrink-0">
    <PageHeader shrink className={props.className} actions={actions}>
      {current && "onBack" in props ? <div className="flex min-w-0 flex-1 items-center gap-2">
        <button type="button" disabled={busy} onClick={props.onBack}
          aria-label={`Back from ${props.itemLabel}`}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-950 disabled:opacity-50">
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Back</span>
        </button>
        {editing ? <Input autoFocus aria-label={`Rename ${props.itemLabel}`} value={title}
          disabled={busy} onChange={(event) => setTitle(event.target.value)}
          onBlur={commitRename} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") {
              event.preventDefault(); cancelRename.current = true;
              setTitle(current.title); setEditing(false);
            }
          }} className="h-9 max-w-xl border-gray-400 text-lg font-medium" />
          : <h1 className="truncate text-2xl font-medium leading-tight text-gray-900">
            {current.title}
          </h1>}
      </div> : <h1 className="truncate text-2xl font-medium leading-tight text-gray-900">
        {props.title}
      </h1>}
    </PageHeader>
    {current && "onDelete" in props && <ConfirmPopup open={confirmDelete}
      title={`Delete ${props.itemLabel}?`} message={`Permanently delete ${current.title}?`}
      confirmLabel="Delete" confirmStatus={busy ? "loading" : "idle"}
      onConfirm={props.onDelete} onCancel={() => !busy && setConfirmDelete(false)} />}
  </header>;
}
