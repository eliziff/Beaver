"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
} from "@/app/lib/mikeApi";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI" | "Codex";
}

export const MODELS: ModelOption[] = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    { id: "codex-exec", label: "Codex (local)", group: "Codex" },
];

export const SETTINGS_MODELS: ModelOption[] = [
    ...MODELS,
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
    {
        id: "gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash Lite",
        group: "Google",
    },
    { id: "gpt-5.4-lite", label: "GPT-5.4 Lite", group: "OpenAI" },
];

export const DEFAULT_MODEL_ID =
    process.env.NEXT_PUBLIC_DEFAULT_MODEL === "codex-exec"
        ? "codex-exec"
        : "gemini-3-flash-preview";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "OpenAI",
    "Codex",
];
const itemClassName =
    "rounded-xl px-2.5 py-1.5 text-gray-700 focus:bg-app-surface-hover focus:text-gray-900 data-[highlighted]:bg-app-surface-hover data-[highlighted]:text-gray-900";

interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    reasoningEffort?: string;
    onReasoningEffortChange?: (value: string) => void;
}

export function ModelToggle({
    value,
    onChange,
    apiKeys,
    reasoningEffort,
    onReasoningEffortChange,
}: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const [codexCatalog, setCodexCatalog] =
        useState<CodexModelCatalog | null>(null);
    const catalogRequestedRef = useRef(false);
    const [catalogLoading, setCatalogLoading] = useState(false);

    useEffect(() => {
        if (!isOpen || codexCatalog || catalogRequestedRef.current) return;
        catalogRequestedRef.current = true;
        let cancelled = false;
        const loadCatalog = async () => {
            await Promise.resolve();
            if (cancelled) return;
            setCatalogLoading(true);
            try {
                const catalog = await getCodexModelCatalog();
                if (!cancelled) setCodexCatalog(catalog);
            } catch {
                if (!cancelled) {
                    setCodexCatalog({
                        models: [],
                        source: "unavailable",
                    });
                }
            } finally {
                if (!cancelled) setCatalogLoading(false);
            }
        };
        void loadCatalog();
        return () => {
            cancelled = true;
        };
    }, [codexCatalog, isOpen]);

    const allModels = useMemo(() => {
        const dynamicModels = (codexCatalog?.models ?? []).map((model) => ({
            id: `codex:${model.slug}`,
            label: model.displayName,
            group: "Codex" as const,
        }));
        const knownIds = new Set(MODELS.map((model) => model.id));
        return [
            ...MODELS,
            ...dynamicModels.filter((model) => !knownIds.has(model.id)),
        ];
    }, [codexCatalog]);

    const selected = allModels.find((m) => m.id === value);
    const selectedLabel = selected?.label ?? "Model";
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys)
        : true;
    const selectedCatalogModel = value.startsWith("codex:")
        ? codexCatalog?.models.find(
              (model) => `codex:${model.slug}` === value,
          )
        : undefined;
    const supportedEfforts = useMemo(
        () => selectedCatalogModel?.supportedReasoningLevels ?? [],
        [selectedCatalogModel],
    );

    useEffect(() => {
        if (!onReasoningEffortChange || supportedEfforts.length === 0) return;
        if (
            reasoningEffort &&
            supportedEfforts.some((level) => level.effort === reasoningEffort)
        ) {
            return;
        }
        const nextEffort =
            selectedCatalogModel?.defaultReasoningLevel ??
            supportedEfforts[0]?.effort;
        if (nextEffort) onReasoningEffortChange(nextEffort);
    }, [
        onReasoningEffortChange,
        reasoningEffort,
        selectedCatalogModel,
        supportedEfforts,
    ]);

    const handleModelSelect = (id: string) => {
        onChange(id);
        if (!onReasoningEffortChange) return;
        const descriptor = id.startsWith("codex:")
            ? codexCatalog?.models.find(
                  (model) => `codex:${model.slug}` === id,
              )
            : undefined;
        if (!descriptor) return;
        const currentEffort = reasoningEffort?.trim();
        if (
            currentEffort &&
            descriptor.supportedReasoningLevels.some(
                (level) => level.effort === currentEffort,
            )
        ) {
            return;
        }
        const nextEffort =
            descriptor.defaultReasoningLevel ??
            descriptor.supportedReasoningLevels[0]?.effort;
        if (nextEffort) onReasoningEffortChange(nextEffort);
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
                            : "Choose model"
                    }
                >
                    {!selectedAvailable && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                    )}
                    <span className="max-w-[140px] truncate">{selectedLabel}</span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50 max-h-[min(70vh,30rem)] w-60 overflow-y-auto p-1.5 text-gray-700"
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
                {selected?.group === "Codex" && onReasoningEffortChange && (
                    <>
                        <DropdownMenuSeparator className="-mx-1 my-1 bg-white/70" />
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                            Reasoning effort
                        </DropdownMenuLabel>
                        <select
                            aria-label="Codex reasoning effort"
                            value={reasoningEffort ?? ""}
                            disabled={supportedEfforts.length === 0}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                                onReasoningEffortChange(event.target.value)
                            }
                            className="mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-lg border border-white/70 bg-white/70 px-2 py-1.5 text-xs text-gray-700 outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                            {supportedEfforts.map((level) => (
                                <option key={level.effort} value={level.effort}>
                                    {level.effort}
                                </option>
                            ))}
                        </select>
                        {supportedEfforts.length === 0 && (
                            <p className="px-2 pb-1 text-[11px] text-gray-400">
                                {catalogLoading
                                    ? "Loading Codex catalog..."
                                    : "Codex catalog unavailable"}
                            </p>
                        )}
                    </>
                )}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
