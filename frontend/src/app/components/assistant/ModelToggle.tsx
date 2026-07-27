"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import {
    getCodexModelCatalog,
    type ApiKeyState,
    type CodexModelCatalog,
    type CodexModelDescriptor,
} from "@/app/lib/mikeApi";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI" | "DeepSeek" | "Meta" | "Codex";
}

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

const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "DeepSeek",
    "Meta",
    "Codex",
];
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

const itemClassName =
    "rounded-xl px-2.5 py-1.5 text-gray-700 focus:bg-app-surface-hover focus:text-gray-900 data-[highlighted]:bg-app-surface-hover data-[highlighted]:text-gray-900";

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
    const [isOpen, setIsOpen] = useState(false);
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
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys)
        : true;

    const handleModelSelect = (id: string) => {
        onChange(id);
    };

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2 text-sm text-gray-400 transition-colors hover:text-gray-700 ${isOpen ? "text-gray-700" : ""}`}
                    title={
                        !selectedAvailable
                            ? "API key missing for selected model"
                            : selectedLabel
                    }
                    aria-label={`Model: ${selectedLabel}`}
                >
                    {!selectedAvailable && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                    )}
                    <span className="whitespace-nowrap">{selectedLabel}</span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] w-max min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto p-1.5 text-gray-700"
                side="top"
                align="end"
            >
                {GROUP_ORDER.map((group, gi) => {
                    const items = allModels.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && (
                                <DropdownMenuSeparator className="-mx-1 my-1 bg-white/70" />
                            )}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys)
                                    : true;
                                return (
                                    <LiquidDropdownItem
                                        key={m.id}
                                        className={`${itemClassName} ${m.id === value ? "bg-app-surface-hover text-gray-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]" : ""}`}
                                        onSelect={() => handleModelSelect(m.id)}
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle
                                                className="h-3.5 w-3.5 text-red-500 ml-1"
                                                aria-label="API key missing"
                                            />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </LiquidDropdownItem>
                                );
                            })}
                        </div>
                    );
                })}
            </LiquidDropdownContent>
        </DropdownMenu>
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
    const [isOpen, setIsOpen] = useState(false);
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

    if (!supported) return null;

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2 text-sm text-gray-400 transition-colors hover:text-gray-700 ${isOpen ? "text-gray-700" : ""}`}
                    title="Choose reasoning effort"
                    aria-label={`Reasoning effort: ${selectedEffort}`}
                >
                    <span className="chat-input-control-label text-[10px] uppercase tracking-wide text-gray-400">
                        Effort
                    </span>
                    <span className="capitalize text-gray-600">
                        {selectedEffort}
                    </span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50 min-w-36 p-1.5 text-gray-700"
                side="top"
                align="end"
            >
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                    Reasoning effort
                </DropdownMenuLabel>
                {efforts.map((level) => (
                    <LiquidDropdownItem
                        key={level.effort}
                        className={`${itemClassName} ${level.effort === selectedEffort ? "bg-app-surface-hover text-gray-900" : ""}`}
                        onSelect={() => onChange(level.effort)}
                    >
                        <span className="flex-1 capitalize">{level.effort}</span>
                        {level.effort === selectedEffort && (
                            <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                        )}
                    </LiquidDropdownItem>
                ))}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
