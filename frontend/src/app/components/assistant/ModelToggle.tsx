import { useLayoutEffect, useSyncExternalStore } from "react";import {
    type ApiKeyState,
    type ModelCatalog,
} from "@/app/lib/beaverApi";
import {
    getSessionModelCatalog,
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
    {
        id: "meta/muse-spark-1.1",
        label: "Muse Spark 1.1",
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
];
const configuredDefaultModel = process.env.NEXT_PUBLIC_DEFAULT_MODEL;
const configuredDynamicModel =
    configuredDefaultModel && /^(codex|ollama):.+/u.test(configuredDefaultModel)
        ? configuredDefaultModel
        : null;
export const DEFAULT_MODEL_ID =
    configuredDynamicModel ??
    MODELS.find((model) => model.id === configuredDefaultModel)?.id ??
    "codex:gpt-5.6-terra";
export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));
const DESKTOP_MODELS: ModelOption[] = [
    { id: "ollama:qwen3.5:2b-q4_K_M", label: "Qwen 3.5 2B (Q4_K_M)", group: "Desktop" },
    { id: "ollama:qwen3.5:4b-q4_K_M", label: "Qwen 3.5 4B (Q4_K_M)", group: "Desktop" },
    { id: "ollama:qwen3.5:9b", label: "Qwen 3.5 9B", group: "Desktop" },
];
const catalogListeners = new Set<() => void>();
let catalogRefresh: Promise<ModelCatalog> | null = null;
function subscribeModelCatalog(listener: () => void) {
    catalogListeners.add(listener);
    catalogRefresh ??= preloadModelCatalog().finally(() => {
        catalogRefresh = null;
        catalogListeners.forEach((notify) => notify());
    });
    return () => catalogListeners.delete(listener);
}
function useModelCatalog(): ModelCatalog | null {
    return useSyncExternalStore(
        subscribeModelCatalog,
        getSessionModelCatalog,
        () => null,
    );
}
function fallbackDynamicLabel(modelId: string): string | null {
    const prefix = modelId.startsWith("codex:")
        ? "codex:"
        : modelId.startsWith("ollama:")
          ? "ollama:"
          : null;
    if (!prefix) return null;
    const slug = modelId.slice(prefix.length).trim();
    if (!slug) return null;
    return slug
        .split("-")
        .map((part) =>
            part.toLowerCase() === "gpt"
                ? "GPT"
                : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
        )
        .join(" ");
}
interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    models?: ModelOption[];
    disabled?: boolean;
    className?: string;
}
export function ModelToggle({
    value,
    onChange,
    apiKeys,
    models = MODELS,
    disabled,
    className = "sm:w-56",
}: Props) {
    const catalog = useModelCatalog();
    const dynamicModels: ModelOption[] = (catalog?.models ?? [])
        .filter((model) => model.supportedInApi !== false)
        .map((model) => ({
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
    const allModels = [...desktopModels, ...dynamicModels, ...models];
    const selected = allModels.find((m) => m.id === value);
    const selectedLabel =
        selected?.label ?? fallbackDynamicLabel(value) ?? "Model";
    const selectedGroup =
        selected?.group ??
        (value.startsWith("codex:")
            ? "Codex"
            : value.startsWith("ollama:")
              ? "Desktop"
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
        />
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
    const selectedModel = catalog?.models.find(
        (item) =>
            item.supportedInApi !== false &&
            `codex:${item.slug}` === model,
    );
    const selectedDesktopModel = catalog?.ollama?.models.find(
        (item) => `ollama:${item.name}` === model,
    );
    const efforts = model.startsWith("deepseek-")
        ? [{ effort: "high" }, { effort: "max" }]
        : selectedDesktopModel?.supportsThinking
          ? ["off", "low", "medium", "high", "max"].map((effort) => ({
                effort,
            }))
        : model === "meta/muse-spark-1.1"
          ? [
                { effort: "xhigh" },
                { effort: "high" },
                { effort: "medium" },
                { effort: "low" },
                { effort: "minimal" },
            ]
          : (selectedModel?.supportedReasoningLevels ?? []);
    const supported = efforts.length > 0;
    const selectedEffort =
        value && efforts.some((level) => level.effort === value)
            ? value
            : (model.startsWith("deepseek-")
            ? "high"
            : selectedDesktopModel?.supportsThinking
              ? "off"
            : model === "meta/muse-spark-1.1"
                  ? "medium"
                  : (selectedModel?.defaultReasoningLevel ??
                    efforts[0]?.effort));
    useLayoutEffect(() => {
        if (supported && selectedEffort && value !== selectedEffort) {
            onChange(selectedEffort);
        }
    }, [onChange, selectedEffort, supported, value]);
    return (        <label className="reasoning-effort-toggle flex h-8 shrink-0 items-center gap-1 rounded-md border border-gray-300 bg-white px-2">            <span className="chat-input-control-label text-[10px] uppercase tracking-wide text-gray-500">                Effort            </span>            <select                value={selectedEffort ?? ""}                disabled={!supported}                onChange={(event) => onChange(event.currentTarget.value)}                title="Choose reasoning effort"                aria-label={                    supported                        ? `Reasoning effort: ${selectedEffort}`                        : "Reasoning effort unavailable"                }                className="h-full min-w-0 flex-1 cursor-pointer bg-white text-sm capitalize text-gray-700"            >                {supported ? (                    efforts.map((level) => (                        <option key={level.effort} value={level.effort}>                            {level.effort}                        </option>                    ))                ) : (                    <option>                        {model.startsWith("codex:") && !catalog                            ? "Loading"                            : "Automatic"}                    </option>                )}            </select>        </label>    );}
