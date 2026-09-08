import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { TabList } from "@/app/components/ui/tabs";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/api/account";
import { cn } from "@/app/lib/utils";
import type { ModelOption } from "@/app/lib/api/account";
export type { ModelOption } from "@/app/lib/api/account";
export function ModelPicker({
    value,
    models,
    onChange,
    apiKeys,
    disabled = false,
    className,
    detail,
    effortControls,
    onOpen,
}: {
    value: string;
    models: ModelOption[];
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    disabled?: boolean;
    className?: string;
    detail?: string;
    effortControls?: ReactNode;
    onOpen?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [provider, setProvider] = useState<ModelOption["group"] | undefined>();
    const selected = models.find((model) => model.id === value);
    const label = selected?.label ?? value;
    const compactLabel = detail
        ? label.replace(/^GPT[- ]\d+(?:\.\d+)*[- ]+(?=[A-Za-z])/, "").replace(/ · .+$/, "")
        : label;
    const displayLabel = detail ? `${label} ${detail}` : label;
    const available = (model?: ModelOption) =>
        model?.available !== false &&
        !!model &&
        (apiKeys
            ? isModelAvailable(model.id, apiKeys)
            : model.group === "Codex" || model.group === "Desktop");
    const availableModels = models.filter(available);
    const providers = [...new Set(availableModels.map((model) => model.group))];
    const activeProvider = provider && providers.includes(provider) ? provider : providers[0];
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
                <span className="min-w-0 flex-1 truncate">{compactLabel}</span>
                {detail && <span className="shrink-0 whitespace-nowrap text-gray-500">· <span>{detail}</span></span>}
                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>
            </div>
            <SearchableChoiceModal
                open={open}
                onClose={() => setOpen(false)}
                title={detail ? "Model and effort" : "Models"}
                size="2xl"
                className="h-[min(36rem,calc(100dvh-2rem))]"
                sidePanel={effortControls}
                controls={<TabList value={activeProvider ?? "Codex"} onValueChange={setProvider}
                    options={providers.map((group) => ({ value: group, label: group }))}
                    ariaLabel="Model providers" variant="dock" className="mb-4 px-0" />}
                closeOnSelect={!effortControls}
                searchLabel="Search models"
                value={value}
                options={availableModels.filter((model) => model.group === activeProvider).map((model) => ({
                    value: model.id,
                    label: model.label,
                    keywords: model.id,
                }))}
                onChange={(model) => {
                    if (model) onChange(model);
                }}
            />
        </span>
    );
}
