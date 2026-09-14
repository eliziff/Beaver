import { useState, type ReactNode } from "react";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { TabList } from "@/app/components/ui/tabs";
import { getModelProvider, isModelAvailable, providerShortLabel } from "@/app/lib/modelAvailability";
import { PROVIDER_LOGO } from "@/app/lib/providerLogos";
import type { ApiKeyState } from "@/app/lib/api/account";
import { cn } from "@/app/lib/utils";
import type { ModelOption } from "@/app/lib/api/account";
export type { ModelOption } from "@/app/lib/api/account";

// The composer trigger has very little room; drop the creator and version so
// the distinguishing tier survives ("Claude Sonnet 4.6" → "Sonnet",
// "GPT-5.6 Luna" → "Luna"), falling back to the full label when nothing remains.
const CREATOR_PREFIX = /^\s*(?:claude|gpt|gemini|deepseek|grok|qwen|glm|kimi|minimax|mistral|llama|command|nova)\b[- ]*/iu;
function compactModelLabel(label: string): string {
    const compact = label
        .replace(CREATOR_PREFIX, "")
        .replace(/^\s*[vV]?\d+(?:\.\d+)*\b[- ]*/u, "")
        .replace(/\s+\d+(?:\.\d+)*\b/gu, " ")
        .replace(/\s{2,}/gu, " ")
        .trim();
    return compact || label;
}

/** One row per model; the provider control picks which serving is used. */
function ModelRow({ row, value, choose, showCompany = false }: {
    row: ModelOption[]; value: string;
    choose: (value: string) => void; showCompany?: boolean;
}) {
    const model = row[0];
    const effective = row.find((option) => option.id === value) ?? model;
    // The label already carries the tier; search is the only place the company adds anything.
    const subtitle = showCompany ? model.group : null;
    return <div className="flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-100 [contain-intrinsic-size:36px] [content-visibility:auto]">
        <button
            type="button"
            onClick={() => choose(effective.id)}
            className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900"
        >
            <span className="block truncate text-sm text-gray-800">{model.label}</span>
            {subtitle && <span className="block truncate text-xs text-gray-500">{subtitle}</span>}
        </button>
        <div
            role="group"
            aria-label={`Provider for ${model.label}`}
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-gray-200 bg-gray-50 p-0.5"
        >
            {row.map((option) => option.provider && <button
                key={option.id}
                type="button"
                aria-pressed={option.id === value}
                onClick={() => choose(option.id)}
                className={cn(
                    "rounded px-2 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-900",
                    option.id === value
                        ? "bg-gray-900 text-white"
                        : "text-gray-600 hover:bg-white hover:text-gray-900",
                )}
            >
                {providerShortLabel(option.provider)}
            </button>)}
        </div>
    </div>;
}

export function ModelPicker({
    value,
    models,
    onChange,
    apiKeys,
    disabled = false,
    className,
    detail,
    detailIcon,
    effortControls,
    onOpen,
    disabledProviders,
}: {
    value: string;
    models: ModelOption[];
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    disabled?: boolean;
    className?: string;
    detail?: string;
    detailIcon?: ReactNode;
    effortControls?: ReactNode;
    onOpen?: () => void;
    /** Providers the reader hid in settings. */
    disabledProviders?: string[];
}) {
    const [open, setOpen] = useState(false);
    const [provider, setProvider] = useState<ModelOption["group"] | undefined>();
    const [family, setFamily] = useState<string | undefined>();
    const [query, setQuery] = useState("");
    const selected = models.find((model) => model.id === value);
    const label = selected?.label ?? value;
    const selectedProvider = selected ? getModelProvider(selected.id) : null;
    const logo = selectedProvider ? PROVIDER_LOGO[selectedProvider] : undefined;
    const compactLabel = detail
        ? compactModelLabel(label).replace(/ · .+$/u, "") || label
        : label;
    const displayLabel = detail ? `${label} ${detail}` : label;
    const available = (model?: ModelOption) =>
        model?.available !== false &&
        !!model &&
        (apiKeys
            ? isModelAvailable(model.id, apiKeys)
            : model.group === "Codex" || model.group === "Desktop");
    const enabledModels = disabledProviders?.length
        ? models.filter((model) => !model.provider || !disabledProviders.includes(model.provider))
        : models;
    // OpenAI leads the company rail; the rest keep their catalogue order.
    const isOpenAi = (model: ModelOption) =>
        getModelProvider(model.id) === "openai" || model.group === "OpenAI";
    const availableModels = enabledModels.filter(available)
        .sort((left, right) => Number(isOpenAi(right)) - Number(isOpenAi(left)));
    const providers = [...new Set(availableModels.map((model) => model.group))];
    const activeProvider = provider && providers.includes(provider) ? provider : providers[0];
    const laneModels = availableModels.filter((model) => model.group === activeProvider);
    // Aggregator lanes expose several upstream sources; first-party lanes stay flat.
    const families = [...new Set(laneModels
        .map((model) => model.family)
        .filter((name): name is string => !!name))];
    const activeFamily = family && families.includes(family) ? family : families[0];
    // Always render the second rail (a single tab when there is nothing to
    // split) so switching companies never shifts the list.
    const familyTabs = families.length ? families : ["All"];
    const searching = query.trim().length > 0;
    const visibleModels = families.length > 1 && !searching && activeFamily
        ? laneModels.filter((model) => model.family === activeFamily)
        : laneModels;
    // Search spans the whole catalogue, not just the active company.
    const sourceModels = searching ? availableModels : visibleModels;
    const rows = [...sourceModels.reduce((byKey, model) => {
        const key = model.modelKey ?? model.id;
        return byKey.set(key, [...(byKey.get(key) ?? []), model]);
    }, new Map<string, ModelOption[]>()).values()];
    const selectedAvailable = available(selected);
    return (
        <span
            className={cn(
                "relative block w-full min-w-0",
                className,
            )}
        >
            <div className={cn(
                "flex h-8 w-full min-w-0 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:border-gray-400 focus-within:ring-2 focus-within:ring-red-600",
                !selectedAvailable && "border-red-600",
            )}>
            <button
                type="button"
                aria-expanded={open}
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={() => {
                    onOpen?.();
                    setProvider(selected?.group);
                    setFamily(selected?.family);
                    setQuery("");
                    setOpen(true);
                }}
                title={
                    selectedAvailable
                        ? displayLabel
                        : "Selected model is unavailable"
                }
                aria-label={`Model: ${displayLabel}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left focus-visible:outline-none disabled:cursor-default disabled:opacity-50"
            >
                {logo && <img src={logo} alt="" aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{compactLabel}</span>
                {detail && <span className="min-w-0 shrink truncate whitespace-nowrap text-gray-500 @max-[30rem]:hidden">· <span>{detail}</span></span>}
                {detailIcon && <span className="shrink-0 text-gray-600 @min-[30rem]:hidden">{detailIcon}</span>}
            </button>
            </div>
            <SearchableChoiceModal
                open={open}
                onClose={() => { setOpen(false); setQuery(""); }}
                title={detail ? "Model and effort" : "Models"}
                size="2xl"
                className="h-[min(36rem,calc(100dvh-2rem))]"
                bodyClassName="px-8 pt-4"
                sidePanel={effortControls}
                query={query}
                onQueryChange={setQuery}
                controls={<div className="mb-4 flex flex-col gap-2">
                    <TabList value={activeProvider ?? "Codex"}
                        onValueChange={(next) => { setProvider(next); setFamily(undefined); setQuery(""); }}
                        options={providers.map((group) => ({ value: group, label: group }))}
                        ariaLabel="Model companies" variant="dock" className="px-0" />
                    <TabList value={activeFamily ?? familyTabs[0]}
                        onValueChange={setFamily}
                        options={familyTabs.map((name) => ({ value: name, label: name }))}
                        ariaLabel="Model tiers" variant="subtab" className="px-0" />
                </div>}
                closeOnSelect={!effortControls}
                searchLabel="Search models"
                value={value}
                options={rows.map((row) => ({
                    value: (row.find((model) => model.id === value) ?? row[0]).id,
                    label: row[0].label,
                    keywords: [row[0].label, row[0].family, ...row.flatMap((model) =>
                        [model.id, model.provider ?? ""])].filter(Boolean).join(" "),
                    render: (choose) => <ModelRow row={row} value={value}
                        choose={(next) => choose(next)} showCompany={searching} />,
                }))}
                onChange={(model) => {
                    if (model) onChange(model);
                }}
            />
        </span>
    );
}
