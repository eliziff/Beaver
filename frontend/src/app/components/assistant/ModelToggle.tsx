import { useLayoutEffect, useMemo, type ReactNode } from "react";
import type { ApiKeyState, ModelCatalog } from "@/app/lib/api/account";
import {
    useModelCatalog,
    preloadModelCatalog,
} from "@/app/lib/modelCatalog";
import { ModelPicker, type ModelOption } from "./ModelPicker";
export type { ModelOption } from "./ModelPicker";
export const MODELS: ModelOption[] = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        group: "DeepSeek",
    },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "DeepSeek" },
    { id: "muse-spark-1.2", label: "Muse Spark 1.2", group: "Meta" },
    { id: "muse-spark-1.1", label: "Muse Spark 1.1", group: "Meta" },
    {
        id: "meta/muse-spark-1.1",
        label: "Muse Spark 1.1 (OpenRouter)",
        group: "Meta",
    },
];
export const SETTINGS_MODELS: ModelOption[] = [
    ...MODELS,
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
    {
        id: "gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash Lite",
        group: "Google",
    },
    { id: "gpt-5.4-lite", label: "GPT-5.4 Lite", group: "OpenAI" },
    // Contributor tier trades ~12x cheaper tokens for Meta training on the
    // prompts and completions, so it stays out of the default picker.
    {
        id: "muse-spark-1.2-contributor",
        label: "Muse Spark 1.2 (contributor · trains on input)",
        group: "Meta",
    },
];
export const DEFAULT_MODEL_ID = "codex:gpt-5.6-terra";
export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));
const DESKTOP_MODELS: ModelOption[] = [
    { id: "ollama:qwen3.8:27b-ud-q2-k-xl", label: "Qwen 3.8 27B (UD-Q2_K_XL)", group: "Desktop" },
];
function fallbackModel(id: string, defaultGroup: ModelOption["group"] = "Codex"): ModelOption {
    const provider = ([ ["claude-p:", "Claude Code"], ["codex:", "Codex"],
        ["ollama:", "Desktop"], ["opencode-go/", "OpenCode Go"] ] as const)
        .find(([prefix]) => id.startsWith(prefix));
    const slug = provider ? id.slice(provider[0].length).trim() : "";
    const label = !slug ? "Model" : provider?.[1] === "OpenCode Go" ? `${slug} · OpenCode Go`
        : slug.split("-").map(part => part.toLowerCase() === "gpt"
            ? "GPT" : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
    return { id, label, group: provider?.[1] ?? defaultGroup, available: !id.startsWith("ollama:") };
}
interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    models?: ModelOption[];
    disabled?: boolean;
    className?: string;
    detail?: string;
    effortControls?: ReactNode;
}
export function ModelToggle({
    value,
    onChange,
    apiKeys,
    models = MODELS,
    disabled,
    className = "sm:w-56",
    detail,
    effortControls,
}: Props) {
    const catalog = useModelCatalog();
    const allModels = useMemo<ModelOption[]>(() => [
        ...(catalog?.ollama ? catalog.ollama.models.map<ModelOption>(model => ({
            id: `ollama:${model.name}`, group: "Desktop",
            label: model.displayName + (catalog.ollama?.source === "unavailable" ? " — desktop offline" : ""),
        })) : DESKTOP_MODELS),
        ...(catalog?.models ?? []).map<ModelOption>(model => ({ id: `codex:${model.slug}`, label: model.displayName, group: "Codex" })),
        ...(catalog?.openCodeGo?.models ?? []).map<ModelOption>(model => ({ id: `opencode-go/${model.id}`, label: model.displayName, group: "OpenCode Go" })),
        ...models,
        ...models.filter(model => model.group === "Anthropic").map<ModelOption>(model => ({ ...model, id: `claude-p:${model.id}`, group: "Claude Code" })),
    ], [catalog, models]);
    const selected = allModels.find((model) => model.id === value);
    const visibleModels = selected
        ? allModels
        : [fallbackModel(value, models[0]?.group), ...allModels];
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
    const codex = catalog?.models.find(item => `codex:${item.slug}` === model);
    const thinking = catalog?.ollama?.models.find(item => `ollama:${item.name}` === model)?.supportsThinking;
    const deepseek = model.startsWith("deepseek-"), muse = model.includes("muse-spark-");
    const unknownCodex = model.startsWith("codex:") && !codex;
    const efforts = deepseek ? ["low", "high", "max"] : thinking ? ["off", "low", "medium", "high"]
        : muse ? ["xhigh", "high", "medium", "low", "minimal"]
        : (codex?.supportedReasoningLevels ?? []).map(level => level.effort);
    const fallback = unknownCodex
        ? model.endsWith("gpt-5.6-sol") ? "low" : model.endsWith("gpt-5.3-codex-spark") ? "high" : "medium"
        : deepseek ? "high" : thinking ? "off" : muse ? "medium" : codex?.defaultReasoningLevel ?? efforts[0];
    return { efforts, selectedEffort: value && (unknownCodex || efforts.includes(value)) ? value : fallback };
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
