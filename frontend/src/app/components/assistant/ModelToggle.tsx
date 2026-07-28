"use client";

import { useEffect, useMemo, useState } from "react";
import {
    type ApiKeyState,
    type CodexModelCatalog,
} from "@/app/lib/beaverApi";
import {
    getSessionCodexModelCatalog,
    preloadCodexModelCatalog,
} from "@/app/lib/codexModelCatalog";
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
export const DEFAULT_MODEL_ID =
    configuredDefaultModel?.startsWith("codex:") &&
    configuredDefaultModel.length > "codex:".length
        ? configuredDefaultModel
        : (MODELS.find((model) => model.id === configuredDefaultModel)?.id ??
          "codex:gpt-5.6-terra");

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

function useCodexCatalog(): CodexModelCatalog | null {
    const [catalog, setCatalog] = useState(getSessionCodexModelCatalog);

    useEffect(() => {
        let cancelled = false;
        const request = preloadCodexModelCatalog();
        const cached = getSessionCodexModelCatalog();
        if (cached) {
            queueMicrotask(() => {
                if (!cancelled) setCatalog(cached);
            });
        }

        void request
            .then((next) => {
                if (!cancelled) setCatalog(next);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return catalog;
}

function fallbackCodexLabel(modelId: string): string | null {
    if (!modelId.startsWith("codex:")) return null;
    const slug = modelId.slice("codex:".length).trim();
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
}

export function ModelToggle({
    value,
    onChange,
    apiKeys,
}: Props) {
    const codexCatalog = useCodexCatalog();
    const allModels = useMemo(() => {
        const dynamicModels: ModelOption[] = (codexCatalog?.models ?? [])
            .filter((model) => model.supportedInApi !== false)
            .map((model) => ({
                id: `codex:${model.slug}`,
                label: model.displayName,
                group: "Codex",
            }));
        return [...dynamicModels, ...MODELS];
    }, [codexCatalog]);
    const selected = allModels.find((m) => m.id === value);
    const selectedLabel =
        selected?.label ?? fallbackCodexLabel(value) ?? "Model";
    const selectedGroup =
        selected?.group ?? (value.startsWith("codex:") ? "Codex" : MODELS[0].group);
    const visibleModels = allModels.some((model) => model.id === value)
        ? allModels
        : [
              {
                  id: value,
                  label: selectedLabel,
                  group: selectedGroup,
              },
              ...allModels,
          ];

    return (
        <ModelPicker
            value={value}
            models={visibleModels}
            onChange={onChange}
            apiKeys={apiKeys}
            className="sm:w-56"
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
    const catalog = useCodexCatalog();
    const selectedModel = catalog?.models.find(
        (item) =>
            item.supportedInApi !== false &&
            `codex:${item.slug}` === model,
    );
    const efforts = model.startsWith("deepseek-")
        ? [{ effort: "high" }, { effort: "max" }]
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
                : model === "meta/muse-spark-1.1"
                  ? "medium"
                  : (selectedModel?.defaultReasoningLevel ??
                    efforts[0]?.effort));

    useEffect(() => {
        if (supported && selectedEffort && value !== selectedEffort) {
            onChange(selectedEffort);
        }
    }, [onChange, selectedEffort, supported, value]);

    return (
        <label className="reasoning-effort-toggle flex h-8 shrink-0 items-center gap-1 rounded-md border border-gray-300 bg-white px-2">
            <span className="chat-input-control-label text-[10px] uppercase tracking-wide text-gray-500">
                Effort
            </span>
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
                className="h-full min-w-0 flex-1 cursor-pointer bg-white text-sm capitalize text-gray-700"
            >
                {supported ? (
                    efforts.map((level) => (
                        <option key={level.effort} value={level.effort}>
                            {level.effort}
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
