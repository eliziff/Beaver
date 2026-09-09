import { useEffect, useLayoutEffect, type ReactNode } from "react";
import type { ApiKeyState, ModelCatalog } from "@/app/lib/api/account";
import {
    useModelCatalog,
    preloadModelCatalog,
} from "@/app/lib/modelCatalog";
import { ModelPicker, type ModelOption } from "./ModelPicker";
export type { ModelOption } from "./ModelPicker";
export const DEFAULT_MODEL_ID = "codex:gpt-5.6-terra";
function fallbackModel(id: string): ModelOption {
    const provider = ([ ["claude-p:", "Claude Code"], ["codex:", "Codex"],
        ["ollama:", "Desktop"], ["opencode-go/", "OpenCode Go"] ] as const)
        .find(([prefix]) => id.startsWith(prefix));
    const slug = provider ? id.slice(provider[0].length).trim() : "";
    const label = !slug ? id : provider?.[1] === "OpenCode Go" ? `${slug} · OpenCode Go`
        : slug.split("-").map(part => part.toLowerCase() === "gpt"
            ? "GPT" : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
    return { id, label, group: provider?.[1] ?? "Unavailable", available: false };
}
interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    includeSettingsModels?: boolean;
    disabled?: boolean;
    className?: string;
    detail?: string;
    effortControls?: ReactNode;
}
export function ModelToggle({
    value,
    onChange,
    apiKeys,
    includeSettingsModels = false,
    disabled,
    className = "sm:w-56",
    detail,
    effortControls,
}: Props) {
    const catalog = useModelCatalog();
    // Fetch in the background on mount so opening the picker never waits on the network.
    useEffect(() => { void preloadModelCatalog(); }, []);
    const allModels = (catalog?.models ?? []).filter(model => includeSettingsModels || !model.settingsOnly);
    const selected = allModels.find((model) => model.id === value);
    const visibleModels = selected
        ? allModels
        : [fallbackModel(value), ...allModels];
    return (
        <ModelPicker
            value={value}
            models={visibleModels}
            onChange={onChange}
            apiKeys={apiKeys}
            disabled={disabled}
            className={className}
            detail={detail}
            effortControls={effortControls}
            onOpen={() => { void preloadModelCatalog(); }}
        />
    );
}
function modelReasoning(model: string, value: string | undefined, catalog: ModelCatalog | null) {
    const entry = catalog?.models?.find(item => item.id === model);
    const efforts = entry?.reasoningEfforts ?? [];
    return { efforts, selectedEffort: value && (!entry || efforts.includes(value)) ? value
        : entry?.defaultReasoningEffort ?? efforts[0] };
}
interface ReasoningEffortToggleProps {
    model: string;
    value?: string;
    onChange: (value: string) => void;
    expanded?: boolean;
}
const effortLabel = (effort: string) => effort === "xhigh" ? "xHigh" : effort;
export function ReasoningEffortToggle({
    model,
    value,
    onChange,
    expanded = false,
}: ReasoningEffortToggleProps) {
    const catalog = useModelCatalog();
    const { efforts, selectedEffort } = modelReasoning(model, value, catalog);
    const supported = efforts.length > 0;
    useLayoutEffect(() => {
        if (
            value !== undefined &&
            supported &&
            selectedEffort &&
            value !== selectedEffort
        ) {
            onChange(selectedEffort);
        }
    }, [onChange, selectedEffort, supported, value]);
    if (expanded) return <fieldset className="flex flex-col gap-1">
        <legend className="mb-3 text-sm font-medium text-gray-700">Reasoning effort</legend>
        {supported ? efforts.map((level) => <label key={level}
            className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-sm hover:bg-gray-100 ${selectedEffort === level ? "bg-gray-100 text-gray-950" : "text-gray-600"}`}>
            <input type="radio" name={`effort-${model}`} value={level}
                checked={selectedEffort === level} onChange={() => onChange(level)}
                className="accent-gray-900" />{effortLabel(level)}
        </label>) : <p className="text-sm text-gray-500">{model.startsWith("codex:") && !catalog ? "Loading…" : "Automatic"}</p>}
    </fieldset>;
    return (
        <label className="reasoning-effort-toggle flex h-8 shrink-0 items-center rounded-md border border-gray-300 bg-white px-2">
            <select
                value={selectedEffort ?? ""}
                disabled={!supported}
                onChange={(event) => onChange(event.currentTarget.value)}
                title="Choose reasoning effort"
                aria-label={
                    supported
                        ? `Reasoning effort: ${selectedEffort}`
                        : "Reasoning effort unavailable"
                }
                className="h-full min-w-0 flex-1 cursor-pointer bg-white text-sm text-gray-700"
            >
                {supported ? (
                    efforts.map((level) => (
                        <option key={level} value={level}>
                            {effortLabel(level)}
                        </option>
                    ))
                ) : (
                    <option>
                        {model.startsWith("codex:") && !catalog
                            ? "Loading"
                            : "Automatic"}
                    </option>
                )}
            </select>
        </label>
    );
}

export function ModelEffortToggle({
    model,
    effort,
    onModelChange,
    onEffortChange,
    apiKeys,
}: {
    model: string;
    effort?: string;
    onModelChange: (model: string) => void;
    onEffortChange: (effort: string) => void;
    apiKeys?: ApiKeyState;
}) {
    const catalog = useModelCatalog();
    const { selectedEffort } = modelReasoning(model, effort, catalog);
    useLayoutEffect(() => {
        if (effort !== undefined && selectedEffort && effort !== selectedEffort) {
            onEffortChange(selectedEffort);
        }
    }, [effort, onEffortChange, selectedEffort]);
    return (
        <ModelToggle
            value={model}
            onChange={onModelChange}
            apiKeys={apiKeys}
            className="chat-input-model-toggle"
            detail={effortLabel(selectedEffort ?? "Automatic")}
            effortControls={<ReasoningEffortToggle expanded model={model} value={effort} onChange={onEffortChange} />}
        />
    );
}
