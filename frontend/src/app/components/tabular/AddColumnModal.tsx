import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/beaverApi";
import { FORMAT_OPTIONS } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import { getPresetConfig, PROMPT_PRESETS } from "./columnPresets";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { ModalTextInput } from "../modals/ModalTextInput";

interface Draft {
    id: number;
    name: string;
    prompt: string;
    preset: string;
    format: ColumnFormat;
    tags: string[];
    generating: boolean;
}

function createDraft(id: number, column?: ColumnConfig): Draft {
    const name = column?.name ?? "";
    return {
        id,
        name,
        prompt: column?.prompt ?? "",
        preset: PROMPT_PRESETS.some((preset) => preset.name === name) ? name : "",
        format: column?.format ?? "text",
        tags: column?.tags ?? [],
        generating: false,
    };
}

const PRESET_OPTIONS = [
    { value: "", label: "Custom column" },
    ...PROMPT_PRESETS.map(({ name }) => ({ value: name, label: name })),
];

interface Props {
    open: boolean;
    existingCount: number;
    onClose: () => void;
    onAdd: (columns: ColumnConfig[]) => void | Promise<void>;
    editingColumn?: ColumnConfig;
    onSave?: (column: ColumnConfig) => void | Promise<void>;
    onDelete?: () => void | Promise<void>;
}

export function AddColumnModal({ open, ...props }: Props) {
    return open ? <ColumnForm {...props} /> : null;
}

function ColumnForm({
    existingCount,
    onClose,
    onAdd,
    editingColumn,
    onSave,
    onDelete,
}: Omit<Props, "open">) {
    const isEditing = !!editingColumn;
    const formRef = useRef<HTMLFormElement>(null);
    const nextId = useRef(1);
    const [drafts, setDrafts] = useState(() => [createDraft(0, editingColumn)]);
    const [submitting, setSubmitting] = useState(false);
    const [valid, setValid] = useState(() =>
        !!editingColumn?.name.trim() && !!editingColumn.prompt.trim());

    function field(draft: Draft, name: "name" | "prompt" | "tag") {
        return formRef.current?.elements.namedItem(`column-${draft.id}-${name}`) as
            HTMLInputElement | HTMLTextAreaElement | null;
    }

    function updateDraft(id: number, patch: Partial<Draft>) {
        setDrafts((current) =>
            current.map((draft) => draft.id === id
                ? { ...draft, ...patch }
                : draft),
        );
    }

    function applyPreset(draft: Draft, name: string) {
        const preset = PROMPT_PRESETS.find((item) => item.name === name);
        const next = createDraft(
            draft.id,
            preset ? { index: 0, ...preset } : undefined,
        );
        const inputs = {
            name: field(draft, "name"),
            prompt: field(draft, "prompt"),
            tag: field(draft, "tag"),
        };
        if (inputs.name) inputs.name.value = next.name;
        if (inputs.prompt) inputs.prompt.value = next.prompt;
        if (inputs.tag) inputs.tag.value = "";
        setDrafts((current) =>
            current.map((item) => item.id === draft.id ? next : item),
        );
        setValid(formRef.current?.checkValidity() ?? false);
    }

    function handleName(draft: Draft, name: string) {
        const preset = getPresetConfig(name);
        const selected = PROMPT_PRESETS.some((item) => item.name === name)
            ? name
            : "";
        if (!preset && selected === draft.preset) return;
        const prompt = field(draft, "prompt");
        if (preset && prompt) prompt.value = preset.prompt;
        updateDraft(draft.id, {
            preset: selected,
            ...(preset && { format: preset.format, tags: preset.tags ?? [] }),
        });
    }

    function commitTag(draft: Draft, input: HTMLInputElement) {
        const tag = input.value.trim();
        if (tag && !draft.tags.includes(tag)) {
            updateDraft(draft.id, { tags: [...draft.tags, tag] });
        }
        input.value = "";
    }

    function handleTagKeyDown(
        event: React.KeyboardEvent<HTMLInputElement>,
        draft: Draft,
    ) {
        if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commitTag(draft, event.currentTarget);
        } else if (event.key === "Backspace" &&
            !event.currentTarget.value && draft.tags.length) {
            updateDraft(draft.id, { tags: draft.tags.slice(0, -1) });
        }
    }

    async function autoGeneratePrompt(draft: Draft) {
        const title = field(draft, "name")?.value.trim();
        if (!title) return;
        updateDraft(draft.id, { generating: true });
        try {
            const result = await generateTabularColumnPrompt(title, {
                format: draft.format,
                tags: draft.format === "tag" ? draft.tags : undefined,
            });
            const prompt = field(draft, "prompt");
            if (prompt) prompt.value = result.prompt;
            setValid(formRef.current?.checkValidity() ?? false);
        } finally {
            updateDraft(draft.id, { generating: false });
        }
    }

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        const columns = drafts.map((draft, index) => ({
            index: existingCount + index,
            name: field(draft, "name")?.value.trim() ?? "",
            prompt: field(draft, "prompt")?.value.trim() ?? "",
            format: draft.format,
            tags: draft.format === "tag" ? draft.tags : undefined,
        }));
        if (columns.some(({ name, prompt }) => !name || !prompt)) return;
        setSubmitting(true);
        try {
            if (isEditing && onSave && editingColumn)
                await onSave({ ...columns[0], index: editingColumn.index });
            else await onAdd(columns);
            onClose();
        } finally {
            setSubmitting(false);
        }
    }

    async function handleDelete() {
        if (!onDelete) return;
        setSubmitting(true);
        try {
            await onDelete();
            onClose();
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            open
            onClose={onClose}
            breadcrumbs={[isEditing ? "Edit column" : "New columns"]}
            primaryAction={{
                label: submitting
                    ? `${isEditing ? "Saving" : "Adding"}…`
                    : isEditing ? "Save changes" : "Add columns",
                type: "submit", form: "add-column-modal-form",
                disabled: submitting || !valid,
            }}
            cancelAction={{ label: "Cancel", onClick: onClose, disabled: submitting }}
            secondaryAction={isEditing && onDelete ? {
                label: "Delete", variant: "danger",
                onClick: handleDelete, disabled: submitting,
            } : undefined}
        >
            <form
                ref={formRef} id="add-column-modal-form" onSubmit={handleSubmit}
                onChange={() => setValid(formRef.current?.checkValidity() ?? false)}
                className="flex min-h-0 flex-1 flex-col"
            >
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3">
                    {drafts.map((draft, index) => {
                        const id = `column-${draft.id}`;
                        return (
                            <section key={draft.id} aria-labelledby={`${id}-heading`}>
                                <div className="mb-4 flex items-center justify-between gap-3">
                                    <h3 id={`${id}-heading`} className="font-serif text-2xl text-gray-950">
                                        Column {index + 1}
                                    </h3>
                                    {drafts.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const next = drafts.filter((item) =>
                                                    item.id !== draft.id);
                                                setDrafts(next);
                                                setValid(next.every((item) => !!field(
                                                    item, "name")?.value.trim() &&
                                                    !!field(item, "prompt")?.value.trim()));
                                            }}
                                            className="rounded-lg p-1.5 text-gray-300 hover:bg-gray-100 hover:text-gray-500"
                                            aria-label={`Remove column ${index + 1}`}
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>
                                <ModalFieldLabel htmlFor={`${id}-preset`}>Start from</ModalFieldLabel>
                                <ModalSelect
                                    id={`${id}-preset`} value={draft.preset} options={PRESET_OPTIONS}
                                    onChange={(name) => applyPreset(draft, name)}
                                    searchable ariaLabel="Choose column preset"
                                />
                                <ModalFieldLabel htmlFor={`${id}-name`} className="mt-4">Column title</ModalFieldLabel>
                                <ModalTextInput
                                    id={`${id}-name`} name={`${id}-name`}
                                    variant="minimal" defaultValue={draft.name}
                                    onChange={(event) => handleName(
                                        draft, event.currentTarget.value)}
                                    placeholder="Column name" className="flex-1"
                                    autoFocus={index === 0} required
                                />
                                <div className="mt-4">
                                    <ModalFieldLabel htmlFor={`${id}-format`}>Format</ModalFieldLabel>
                                    <ModalSelect
                                        id={`${id}-format`} value={draft.format} options={FORMAT_OPTIONS}
                                        onChange={(format) => {
                                            const tag = field(draft, "tag");
                                            if (tag) tag.value = "";
                                            updateDraft(draft.id, {
                                                format: format as ColumnFormat, tags: [],
                                            });
                                        }}
                                    />
                                </div>
                                {draft.format === "tag" && (
                                    <div className="mt-3">
                                        <ModalFieldLabel htmlFor={`${id}-tag`}>Tags</ModalFieldLabel>
                                        <div className="mt-1 flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-white px-2 py-1.5 shadow-sm">
                                            {draft.tags.map((tag, tagIndex) => (
                                                <span
                                                    key={tag}
                                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TAG_COLORS[tagIndex % TAG_COLORS.length]}`}
                                                >
                                                    {tag}
                                                    <button
                                                        type="button" aria-label={`Remove ${tag}`}
                                                        onClick={() => updateDraft(
                                                            draft.id, { tags: draft.tags.filter(
                                                                (item) => item !== tag) },
                                                        )}
                                                        className="text-gray-400 hover:text-gray-600"
                                                    >
                                                        <X className="h-2.5 w-2.5" />
                                                    </button>
                                                </span>
                                            ))}
                                            <ModalTextInput
                                                id={`${id}-tag`} name={`${id}-tag`} variant="minimal"
                                                onKeyDown={(event) => handleTagKeyDown(event, draft)}
                                                onBlur={(event) => commitTag(draft, event.currentTarget)}
                                                placeholder="Add tag…"
                                                className="min-w-[80px] flex-1 bg-transparent font-sans text-sm text-gray-700 shadow-none placeholder:text-gray-400"
                                            />
                                        </div>
                                        <p className="mt-1 text-xs text-gray-400">Press Enter or comma to add a tag.</p>
                                    </div>
                                )}
                                <div className="mt-4 flex items-center justify-between">
                                    <ModalFieldLabel htmlFor={`${id}-prompt`} className="mb-0">Prompt</ModalFieldLabel>
                                    <button
                                        type="button" onClick={() => autoGeneratePrompt(draft)}
                                        disabled={!field(draft, "name")?.value.trim() ||
                                            draft.generating}
                                        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 disabled:text-gray-300"
                                    >
                                        {draft.generating ? (
                                            <span className="block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                                        ) : (
                                            <Plus className="h-4 w-4" />
                                        )}
                                        Auto-Generate Prompt
                                    </button>
                                </div>
                                <ModalTextarea
                                    id={`${id}-prompt`} name={`${id}-prompt`} rows={6}
                                    defaultValue={draft.prompt}
                                    placeholder="Write the analysis prompt — describe what Beaver should extract from each document for this column…"
                                    className="mt-2 min-h-36" required
                                />
                            </section>
                        );
                    })}
                    {!isEditing && (
                        <button
                            type="button"
                            onClick={() => {
                                setDrafts((current) => [...current,
                                    createDraft(nextId.current++)]);
                                setValid(false);
                            }}
                            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
                        >
                            <Plus className="h-4 w-4" />
                            Add another column
                        </button>
                    )}
                </div>
            </form>
        </Modal>
    );
}
