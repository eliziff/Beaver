export function InlineNameInput({ kind, value, label, disabled, onCommit, onCancel }: {
    kind: "document" | "folder" | "new-folder" | "new-document";
    value?: string;
    label?: string;
    disabled?: boolean;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const blockRow = kind !== "new-folder";
    return <input autoFocus defaultValue={value} aria-label={label} disabled={disabled}
        className={kind === "folder"
            ? "flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none"
            : "min-w-0 flex-1 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"}
        placeholder={label ?? (kind === "new-folder" ? "Folder name" : undefined)}
        onClick={blockRow ? (event) => event.stopPropagation() : undefined}
        onDragStart={blockRow ? (event) => {
            event.preventDefault(); event.stopPropagation();
        } : undefined}
        onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault(); event.stopPropagation();
                if (event.key === "Enter") onCommit(event.currentTarget.value);
                else onCancel();
            }
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)} />;
}
