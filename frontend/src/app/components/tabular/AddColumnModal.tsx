import { useState } from "react";
import { X } from "lucide-react";
import type { ColumnConfig } from "@/app/lib/api/tabular";
import { Modal } from "../modals/Modal";
import { Button } from "../ui/button";
import { ColumnEditor, emptyColumn } from "./ColumnEditor";

interface Props {
    open: boolean; existingCount: number; onClose: () => void;
    onAdd: (columns: ColumnConfig[]) => void | Promise<void>;
    editingColumn?: ColumnConfig;
    onSave?: (column: ColumnConfig) => void | Promise<void>;
    onDelete?: () => void | Promise<void>;
}
export function AddColumnModal({ open, ...props }: Props) {
    return open ? <ColumnForm {...props} /> : null;
}
function ColumnForm({ existingCount, onClose, onAdd, editingColumn, onSave, onDelete }: Omit<Props, "open">) {
    const [columns, setColumns] = useState([editingColumn ?? emptyColumn(0)]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    async function save(remove = false) {
        setSubmitting(true); setError("");
        try {
            if (remove) await onDelete?.();
            else {
                const normalized = columns.map((column, index) => ({ ...column,
                    index: editingColumn?.index ?? existingCount + index,
                    name: column.name.trim(), prompt: column.prompt.trim(),
                    tags: column.format === "tag" ? column.tags : undefined }));
                if (editingColumn && onSave) await onSave(normalized[0]);
                else await onAdd(normalized);
            }
            onClose();
        } catch { setError("Could not save columns. Try again."); }
        finally { setSubmitting(false); }
    }
    return <Modal open onClose={onClose} breadcrumbs={[editingColumn ? "Edit column" : "New columns"]}
        primaryAction={{ label: submitting ? "Saving…" : editingColumn ? "Save changes" : "Add columns",
            type: "submit", form: "add-column-modal-form",
            disabled: submitting || columns.some((column) => !column.name.trim() || !column.prompt.trim()) }}
        secondaryAction={editingColumn && onDelete ? { label: "Delete", variant: "danger",
            onClick: () => void save(true), disabled: submitting } : undefined}>
        <form id="add-column-modal-form" onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4 pb-4">
            {columns.map((column, position) => <section key={column.index} className="space-y-2">
                {columns.length > 1 && <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Column {position + 1}</span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove column ${position + 1}`}
                        onClick={() => setColumns(columns.filter((item) => item.index !== column.index))}><X /></Button>
                </div>}
                <ColumnEditor column={column} onChange={(updated) => setColumns((items) => items.map((item) => item.index === column.index ? updated : item))} />
            </section>)}
            {!editingColumn && <Button type="button" variant="outline" size="compact"
                onClick={() => setColumns([...columns, emptyColumn(Math.max(...columns.map(({ index }) => index)) + 1)])}>Add another column</Button>}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </form>
    </Modal>;
}
