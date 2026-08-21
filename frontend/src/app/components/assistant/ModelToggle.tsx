import { useLayoutEffect, useState, useSyncExternalStore } from "react";import {
    type ApiKeyState,
    type ModelCatalog,
} from "@/app/lib/beaverApi";
import {
    getSessionModelCatalog,
    preloadModelCatalog,
} from "@/app/lib/modelCatalog";
import { ModelPicker, type ModelOption } from "./ModelPicker";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
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
const catalogListeners = new Set<() => void>();
let catalogRefresh: Promise<ModelCatalog> | null = null;
function subscribeModelCatalog(listener: () => void) {
    catalogListeners.add(listener);
    return () => catalogListeners.delete(listener);
}
function refreshModelCatalog() {
    catalogRefresh ??= preloadModelCatalog().finally(() => {
        catalogRefresh = null;
        catalogListeners.forEach((notify) => notify());
    });
}
function useModelCatalog(): ModelCatalog | null {
    return useSyncExternalStore(
        subscribeModelCatalog,
        getSessionModelCatalog,
        () => null,
    );
}
function fallbackDynamicLabel(modelId: string): string | null {
    const prefix = ["claude-p:", "codex:", "ollama:"].find((candidate) =>
        modelId.startsWith(candidate),
    );
    if (!prefix) return null;
    const slug = modelId.slice(prefix.length).trim();
    if (!slug) return null;
    const label = slug
        .split("-")
        .map((part) =>
            part.toLowerCase() === "gpt"
                ? "GPT"
                : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
        )
        .join(" ");
    return prefix === "claude-p:" ? `${label} · subscription` : label;
}
interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    models?: ModelOption[];
    disabled?: boolean;
    className?: string;
    detail?: string;
    onDetailClick?: () => void;
}
export function ModelToggle({
    value,
    onChange,
    apiKeys,
    models = MODELS,
    disabled,
    className = "sm:w-56",
    detail,
    onDetailClick,
}: Props) {
    const catalog = useModelCatalog();
    const dynamicModels: ModelOption[] = (catalog?.models ?? []).map((model) => ({
            id: `codex:${model.slug}`,
            label: model.displayName,
            group: "Codex",
        }));
    const catalogDesktopModels: ModelOption[] = (catalog?.ollama?.models ?? []).map(
        (model) => ({
            id: `ollama:${model.name}`,
            label: model.displayName,
            group: "Desktop",
        }),
    );
    const desktopModels = catalog?.ollama
        ? catalogDesktopModels.map((model) => ({
              ...model,
              label:
                  catalog.ollama?.source === "unavailable"
                      ? `${model.label} — desktop offline`
                      : model.label,
          }))
        : DESKTOP_MODELS;
    const subscriptionModels: ModelOption[] = models
        .filter((model) => model.group === "Anthropic")
        .map((model) => ({
            ...model,
            id: `claude-p:${model.id}`,
            label: `${model.label} · subscription`,
            group: "Anthropic subscription" as const,
        }));
    const allModels = [
        ...desktopModels,
        ...dynamicModels,
        ...models,
        ...subscriptionModels,
    ];
    const selected = allModels.find((m) => m.id === value);
    const selectedLabel =
        selected?.label ?? fallbackDynamicLabel(value) ?? "Model";
    const selectedGroup =
        selected?.group ??
        (value.startsWith("codex:")
            ? "Codex"
            : value.startsWith("ollama:")
              ? "Desktop"
              : value.startsWith("claude-p:")
                ? "Anthropic subscription"
              : models[0]?.group ?? "Codex");
    const visibleModels = allModels.some((model) => model.id === value)
        ? allModels
        : [
              {
                  id: value,
                  label: selectedLabel,
                  group: selectedGroup,
                  available: !value.startsWith("ollama:"),
              },
              ...allModels,
          ];
    return (
        <ModelPicker
            value={value}
            models={visibleModels}
            onChange={onChange}
            apiKeys={apiKeys}
            disabled={disabled}
            className={className}
            detail={detail}
            onDetailClick={onDetailClick}
            onOpen={refreshModelCatalog}
        />
    );
}
function reasoningEfforts(model: string, catalog: ModelCatalog | null) {
    const selectedModel = catalog?.models.find(
        (item) => `codex:${item.slug}` === model,
    );
    const selectedDesktopModel = catalog?.ollama?.models.find(
        (item) => `ollama:${item.name}` === model,
    );
    // Same reasoning ladder on both Muse Spark transports (direct + OpenRouter).
    const isMuseSpark = model.includes("muse-spark-");
    return model.startsWith("deepseek-")
        ? [{ effort: "low" }, { effort: "high" }, { effort: "max" }]
        : selectedDesktopModel?.supportsThinking
          ? ["off", "low", "medium", "high"].map((effort) => ({
                effort,
            }))
        : isMuseSpark
          ? [
                { effort: "xhigh" },
                { effort: "high" },
                { effort: "medium" },
                { effort: "low" },
                { effort: "minimal" },
            ]
          : (selectedModel?.supportedReasoningLevels ?? []);
}
function selectedReasoningEffort(
    model: string,
    value: string | undefined,
    catalog: ModelCatalog | null,
) {
    const efforts = reasoningEfforts(model, catalog);
    const selectedModel = catalog?.models.find(
        (item) => `codex:${item.slug}` === model,
    );
    const selectedDesktopModel = catalog?.ollama?.models.find(
        (item) => `ollama:${item.name}` === model,
    );
    const isMuseSpark = model.includes("muse-spark-");
    const defaultCodexReasoning = model.endsWith("gpt-5.6-sol") ? "low"
        : model.endsWith("gpt-5.3-codex-spark") ? "high" : "medium";
    return (
        value && (
            efforts.some((level) => level.effort === value) ||
            (!selectedModel && model.startsWith("codex:"))
        )
            ? value
            : (model.startsWith("codex:") && !selectedModel
            ? defaultCodexReasoning
            : model.startsWith("deepseek-")
            ? "high"
            : selectedDesktopModel?.supportsThinking
              ? "off"
            : isMuseSpark
                  ? "medium"
                  : (selectedModel?.defaultReasoningLevel ??
                    efforts[0]?.effort))
    );
}
interface ReasoningEffortToggleProps {
    model: string;
    value?: string;
    onChange: (value: string) => void;
}
export function ReasoningEffortToggle({
    model,
    value,
    onChange,
}: ReasoningEffortToggleProps) {
    const catalog = useModelCatalog();
    const efforts = reasoningEfforts(model, catalog);
    const selectedEffort = selectedReasoningEffort(model, value, catalog);
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
    return (        <label className="reasoning-effort-toggle flex h-8 shrink-0 items-center rounded-md border border-gray-300 bg-white px-2">            <select                value={selectedEffort ?? ""}                disabled={!supported}                onChange={(event) => onChange(event.currentTarget.value)}                title="Choose reasoning effort"                aria-label={                    supported                        ? `Reasoning effort: ${selectedEffort}`                        : "Reasoning effort unavailable"                }                className="h-full min-w-0 flex-1 cursor-pointer bg-white text-sm capitalize text-gray-700"            >                {supported ? (                    efforts.map((level) => (                        <option key={level.effort} value={level.effort}>                            {level.effort}                        </option>                    ))                ) : (                    <option>                        {model.startsWith("codex:") && !catalog                            ? "Loading"                            : "Automatic"}                    </option>                )}            </select>        </label>    );}

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
    const [effortModel, setEffortModel] = useState<string | null>(null);
    const selectedEffort = selectedReasoningEffort(model, effort, catalog);
    const stagedEfforts = reasoningEfforts(effortModel ?? model, catalog);
    const stagedEffort = selectedReasoningEffort(
        effortModel ?? model,
        effort,
        catalog,
    );
    useLayoutEffect(() => {
        if (effort !== undefined && selectedEffort && effort !== selectedEffort) {
            onEffortChange(selectedEffort);
        }
    }, [effort, onEffortChange, selectedEffort]);
    return (
        <>
            <ModelToggle
                value={model}
                onChange={(next) => {
                    onModelChange(next);
                }}
                apiKeys={apiKeys}
                className="chat-input-model-toggle"
                detail={selectedEffort ?? "Automatic"}
                onDetailClick={() => {
                    refreshModelCatalog();
                    setEffortModel(model);
                }}
            />
            <SearchableChoiceModal
                open={effortModel !== null}
                onClose={() => setEffortModel(null)}
                title="Reasoning effort"
                searchable={false}
                value={stagedEffort ?? null}
                options={stagedEfforts.map(({ effort: value }) => ({
                    value,
                    label: value[0].toUpperCase() + value.slice(1),
                }))}
                onChange={(next) => {
                    if (next) onEffortChange(next);
                }}
            />
        </>
    );
}
