import { useState } from "react";
import { ChevronDown } from "lucide-react";
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
    onDetailClick,
    onOpen,
}: {
    value: string;
    models: ModelOption[];
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    disabled?: boolean;
    className?: string;
    detail?: string;
    onDetailClick?: () => void;
    onOpen?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const selected = models.find((model) => model.id === value);
    const label = selected?.label ?? value;
    const displayLabel = detail ? `${label} ${detail}` : label;
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
                    setOpen(true);
                }}
                title={
                    selectedAvailable
                        ? displayLabel
                        : "Selected model is unavailable"
                }
                aria-label={`Model: ${displayLabel}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left focus-visible:outline-none disabled:cursor-default disabled:opacity-50"
            >
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>
            {detail && onDetailClick && (
                <button
                    type="button"
                    onClick={onDetailClick}
                    className="flex shrink-0 items-center gap-1 rounded-r-md border-l border-gray-300 px-2 capitalize focus-visible:outline-none"
                    aria-label={`Reasoning effort: ${detail}`}
                    title={`Reasoning effort: ${detail}`}
                >
                    {detail}
                    <ChevronDown aria-hidden="true" className="h-4 w-4" />
                </button>
            )}
            </div>
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
