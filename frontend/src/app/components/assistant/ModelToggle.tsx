"use client";

import { useEffect, useMemo, useState } from "react";
import {
    getCodexModelCatalog,
    type ApiKeyState,
    type CodexModelCatalog,
    type CodexModelDescriptor,
} from "@/app/lib/beaverApi";
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

const CODEX_CATALOG_STORAGE_KEY = "mike.codexModelCatalog.v1";
let pendingCatalogRequest: Promise<CodexModelCatalog> | null = null;

function normalizedDisplayName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalSlug(value: string): string {
    return value.trim().replace(/^codex:/i, "").toLowerCase();
}

function preferCatalogModel(
    candidate: CodexModelDescriptor,
    current: CodexModelDescriptor,
): boolean {
    const candidateIsCanonical = candidate.slug.startsWith("gpt-");
    const currentIsCanonical = current.slug.startsWith("gpt-");
    return candidateIsCanonical && !currentIsCanonical;
}

export function normalizeCodexCatalog(
    catalog: CodexModelCatalog,
): CodexModelCatalog {
    const models: CodexModelDescriptor[] = [];
    const slugIndexes = new Map<string, number>();
    const displayIndexes = new Map<string, number>();

    for (const raw of catalog.models) {
        const slug = canonicalSlug(raw.slug);
        if (!slug) continue;
        const displayName = raw.displayName.trim() || slug;
        const model = {
            ...raw,
            slug,
            displayName,
            supportedReasoningLevels: raw.supportedReasoningLevels.filter(
                (level, index, levels) =>
                    !!level.effort.trim() &&
                    levels.findIndex(
                        (candidate) =>
                            candidate.effort.trim().toLowerCase() ===
                            level.effort.trim().toLowerCase(),
                    ) === index,
            ),
        };
        const slugIndex = slugIndexes.get(slug);
        if (slugIndex !== undefined) continue;

        const displayKey = normalizedDisplayName(displayName);
        const displayIndex = displayIndexes.get(displayKey);
        if (displayIndex !== undefined) {
            const current = models[displayIndex];
            if (!preferCatalogModel(model, current)) continue;
            slugIndexes.delete(current.slug);
            models[displayIndex] = model;
            slugIndexes.set(slug, displayIndex);
            continue;
        }

        const nextIndex = models.length;
        models.push(model);
        slugIndexes.set(slug, nextIndex);
        displayIndexes.set(displayKey, nextIndex);
    }
    return { ...catalog, models };
}

function readCachedCatalog(): CodexModelCatalog | null {
    if (typeof window === "undefined") return null;
    try {
        const value = JSON.parse(
            window.localStorage.getItem(CODEX_CATALOG_STORAGE_KEY) ?? "null",
        ) as { catalog?: CodexModelCatalog } | null;
        return value?.catalog ? normalizeCodexCatalog(value.catalog) : null;
    } catch {
        return null;
    }
}

function cacheCatalog(catalog: CodexModelCatalog): void {
    if (typeof window === "undefined" || catalog.models.length === 0) return;
    try {
        window.localStorage.setItem(
            CODEX_CATALOG_STORAGE_KEY,
            JSON.stringify({ savedAt: Date.now(), catalog }),
        );
    } catch {
        // A full or disabled browser cache should not disable model picking.
    }
}

function requestCodexCatalog(): Promise<CodexModelCatalog> {
    pendingCatalogRequest ??= getCodexModelCatalog()
        .then(normalizeCodexCatalog)
        .finally(() => {
            pendingCatalogRequest = null;
        });
    return pendingCatalogRequest;
}

function useCodexCatalog(): CodexModelCatalog | null {
    const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);

    useEffect(() => {
        let cancelled = false;
        const cached = readCachedCatalog();
        if (cached) {
            queueMicrotask(() => {
                if (!cancelled) setCatalog(cached);
            });
        }

        void requestCodexCatalog()
            .then((next) => {
                if (cancelled || next.models.length === 0) return;
                cacheCatalog(next);
                setCatalog(next);
            })
            .catch(() => {
                // Keep the last good catalog when the CLI/backend is offline.
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
        const dynamicModels: ModelOption[] = (codexCatalog?.models ?? []).map(
            (model) => ({
                id: `codex:${model.slug}`,
                label: model.displayName,
                group: "Codex",
            }),
        );
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
        (item) => `codex:${item.slug}` === model,
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
            {supported ? (
                <select
                    value={selectedEffort}
                    onChange={(event) => onChange(event.currentTarget.value)}
                    title="Choose reasoning effort"
                    aria-label={`Reasoning effort: ${selectedEffort}`}
                    className="h-full min-w-0 flex-1 cursor-pointer bg-white text-sm capitalize text-gray-700"
                >
                    {efforts.map((level) => (
                        <option key={level.effort} value={level.effort}>
                            {level.effort}
                        </option>
                    ))}
                </select>
            ) : (
                <select
                    aria-label="Reasoning effort unavailable"
                    disabled
                    className="h-full min-w-0 flex-1 bg-white text-sm text-gray-500"
                >
                    <option>
                        {model.startsWith("codex:") && !catalog
                            ? "Loading"
                            : "Automatic"}
                    </option>
                </select>
            )}
        </label>
    );
}
