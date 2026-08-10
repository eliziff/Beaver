import { useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/beaverApi";
import { cn } from "@/app/lib/utils";
export interface ModelOption {
    id: string;
    label: string;
    group:
        | "Anthropic"
        | "Anthropic subscription"
        | "Google"
        | "OpenAI"
        | "DeepSeek"
        | "Meta"
        | "Codex"
        | "Desktop";
    available?: boolean;
}
export function ModelPicker({
    value,
    models,
    onChange,
    apiKeys,
    disabled = false,
    className,
    detail,
}: {
    value: string;
    models: ModelOption[];
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    disabled?: boolean;
    className?: string;
    detail?: string;
}) {
    const [open, setOpen] = useState(false);
    const selected = models.find((model) => model.id === value);
    const label = selected?.label ?? value;
    const displayLabel = detail ? `${label} · ${detail}` : label;
    const available = (model?: ModelOption) =>
        model?.available !== false &&
        !!model &&
        (apiKeys
            ? isModelAvailable(model.id, apiKeys)
            : model.group === "Codex" || model.group === "Desktop");
    const availableModels = models.filter(available);
    const selectedAvailable = available(selected);
    return (
        <span
            className={cn(
                "relative flex w-full min-w-0 items-center gap-1",
                className,
            )}
        >
            <AlertCircle
                aria-hidden="true"
                className={cn(
                    "h-3 w-3 shrink-0 text-red-600",
                    selectedAvailable && "invisible",
                )}
            />
            <button
                type="button"
                aria-expanded={open}
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={() => setOpen(true)}
                title={
                    selectedAvailable
                        ? displayLabel
                        : "Selected model is unavailable"
                }
                aria-label={`Model: ${displayLabel}`}
                className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-2 text-left text-sm text-gray-700 hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-default disabled:opacity-50"
            >
                <span className="truncate">{displayLabel}</span>
                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>
            <SearchableChoiceModal
                open={open}
                onClose={() => setOpen(false)}
                title="Models"
                searchLabel="Search models"
                value={value}
                options={availableModels.map((model) => ({
                    value: model.id,
                    label: model.label,
                    group: model.group,
                    keywords: model.id,
                }))}
                onChange={(model) => {
                    if (model) onChange(model);
                }}
            />
        </span>
    );
}
