import { useId, useState } from "react";
import { X } from "lucide-react";
import { type ColumnConfig, type ColumnFormat, generateTabularColumnPrompt } from "@/app/lib/api/tabular";
import { FORMAT_OPTIONS } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import { PROMPT_PRESETS } from "./columnPresets";
import { FieldGroup, FormField, ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { ModalTextInput } from "../modals/ModalTextInput";
import { Button } from "../ui/button";

export const emptyColumn = (index: number): ColumnConfig => ({ index, name: "", prompt: "", format: "text" });

export function ColumnEditor({ column, onChange }: {
    column: ColumnConfig; onChange: (column: ColumnConfig) => void;
}) {
    const id = useId();
    const [tag, setTag] = useState("");
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState("");
    const [preset, setPreset] = useState(() => PROMPT_PRESETS.find(({ name, prompt }) =>
        name === column.name && prompt === column.prompt)?.name ?? "");
    function commitTag() {
        const value = tag.trim();
        if (value && !column.tags?.includes(value)) onChange({ ...column, tags: [...(column.tags ?? []), value] });
        setTag("");
    }
    async function generate() {
        setGenerating(true); setError("");
        try {
            const { prompt } = await generateTabularColumnPrompt(column.name.trim(), {
                format: column.format ?? "text", tags: column.format === "tag" ? column.tags : undefined,
            });
            onChange({ ...column, prompt });
        } catch { setError("Could not generate a prompt. Try again."); }
        finally { setGenerating(false); }
    }
    return <fieldset disabled={generating} className="@container min-w-0 space-y-2.5 [&_label]:mb-1">
        <FormField label="Preset" htmlFor={`${id}-preset`}>
            <ModalSelect id={`${id}-preset`} value={preset} searchable ariaLabel="Choose column preset"
                options={[{ value: "", label: "None" }, ...PROMPT_PRESETS.map(({ name }) => ({ value: name, label: name }))]}
                onChange={(name) => {
                    setPreset(name);
                    const selected = PROMPT_PRESETS.find((item) => item.name === name);
                    if (selected) onChange({ index: column.index, name: selected.name, prompt: selected.prompt, format: selected.format, tags: selected.tags });
                    setTag("");
                }} />
        </FormField>
        <div className="grid grid-cols-1 gap-3 @min-[20rem]:grid-cols-[minmax(0,1fr)_8rem]">
            <FormField label="Column title" htmlFor={`${id}-name`}>
                <ModalTextInput value={column.name} autoFocus required onChange={(event) => {
                    const name = event.currentTarget.value;
                    setPreset("");
                    onChange({ ...column, name });
                }} />
            </FormField>
            <FormField label="Format" htmlFor={`${id}-format`}>
                <ModalSelect id={`${id}-format`} value={column.format ?? "text"} options={FORMAT_OPTIONS}
                    onChange={(format) => { onChange({ ...column, format: format as ColumnFormat, tags: undefined }); setTag(""); }} />
            </FormField>
        </div>
        {column.format === "tag" && <FieldGroup legend="Tags">
            <div className="flex flex-wrap items-center gap-1.5">
                {column.tags?.map((value, index) => <span key={value}
                    className={`inline-flex items-center rounded-full pl-2 text-xs ${TAG_COLORS[index % TAG_COLORS.length]}`}>
                    {value}<button type="button" aria-label={`Remove ${value}`} className="grid size-7 place-items-center rounded-full"
                        onClick={() => onChange({ ...column, tags: column.tags?.filter((item) => item !== value) })}>
                        <X aria-hidden className="size-3" /></button>
                </span>)}
                <ModalTextInput id={`${id}-tag`} aria-label="Tags" value={tag} placeholder="Add tag…" className="min-w-20 flex-1"
                    onChange={(event) => setTag(event.currentTarget.value)} onBlur={commitTag}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commitTag(); }
                        else if (event.key === "Backspace" && !tag) onChange({ ...column, tags: column.tags?.slice(0, -1) });
                    }} />
            </div>
        </FieldGroup>}
        <div>
            <div className="mb-1 flex items-center justify-between gap-2">
                <ModalFieldLabel htmlFor={`${id}-prompt`} className="mb-0">Prompt</ModalFieldLabel>
                <Button type="button" variant="ghost" size="compact" disabled={generating || !column.name.trim()}
                    aria-label={column.prompt.trim() ? "Regenerate prompt" : "Generate prompt"}
                    onClick={() => void generate()}>
                    {generating ? "Generating…" : column.prompt.trim() ? "Regenerate" : "Generate"}
                </Button>
            </div>
            <ModalTextarea id={`${id}-prompt`} value={column.prompt} rows={3} required placeholder="Describe what to extract from each document."
                onChange={(event) => onChange({ ...column, prompt: event.currentTarget.value })} />
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </fieldset>;
}

