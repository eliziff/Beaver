import { ChevronDown, X } from "lucide-react";
import type { ColumnConfig } from "@/app/lib/api/tabular";
import { Button } from "../ui/button";
import { ColumnEditor } from "./ColumnEditor";

export type ColumnMark = "added" | "removed" | "renamed" | "prompt" | "format" | "tags" | "moved" | "changed";
const MARK_LABEL: Record<ColumnMark, string> = {
    added: "Added", removed: "Removed", renamed: "Renamed", prompt: "Prompt",
    format: "Format", tags: "Tags", moved: "Moved", changed: "Changed",
};

export function ColumnList({ columns, marks, expanded, onExpand, onChange, onRemove }: {
    columns: ColumnConfig[];
    /** Proposal review only: how each column differs from the saved table. */
    marks?: Record<number, ColumnMark>;
    expanded: number | null;
    onExpand: (index: number | null) => void;
    onChange: (column: ColumnConfig) => void;
    onRemove: (column: ColumnConfig) => void;
}) {
    if (!columns.length) return <p className="py-2 text-sm text-gray-500">Add columns now or after creating the review.</p>;
    return <>{columns.map((column, position) => {
        const mark = marks?.[column.index], dropped = mark === "removed", open = expanded === column.index;
        const name = column.name || `Column ${position + 1}`;
        return <div key={column.index} className="border-b border-gray-200 pb-2">
            <div className="flex items-center gap-2">
                <button type="button" aria-expanded={open} disabled={dropped}
                    onClick={() => onExpand(open ? null : column.index)}
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
                    <ChevronDown aria-hidden className={`size-3.5 shrink-0 text-gray-500 ${open ? "" : "-rotate-90"} ${dropped ? "invisible" : ""}`} />
                    {dropped ? <del className="truncate text-gray-500">{name}</del> : <span className="truncate">{name}</span>}
                </button>
                {mark && <span className="shrink-0 text-xs text-gray-500">{MARK_LABEL[mark]}</span>}
                <Button type="button" variant={dropped ? "outline" : "ghost"} size={dropped ? "compact" : "icon-sm"}
                    aria-label={`${dropped ? "Keep" : "Remove"} column ${position + 1}`} onClick={() => onRemove(column)}>
                    {dropped ? "Keep" : <X />}
                </Button>
            </div>
            {open && !dropped && <ColumnEditor column={column} onChange={onChange} />}
        </div>;
    })}</>;
}
