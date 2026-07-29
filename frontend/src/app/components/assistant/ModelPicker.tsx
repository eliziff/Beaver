"use client";
import { useEffect, useRef, useState } from "react";import { AlertCircle, Check, ChevronDown, Search } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/beaverApi";
import { cn } from "@/app/lib/utils";
export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI" | "DeepSeek" | "Meta" | "Codex";
}
export function ModelPicker({
    value,
    models,
    onChange,
    apiKeys,
    disabled = false,
    className,
}: {
    value: string;
    models: ModelOption[];
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    disabled?: boolean;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    const selected = models.find((model) => model.id === value);
    const label = selected?.label ?? value;
    const availableModels = models.filter((model) =>        apiKeys            ? isModelAvailable(model.id, apiKeys)            : model.group === "Codex",    );    const groups = [...new Set(availableModels.map((model) => model.group))];
    const needle = query.trim().toLowerCase();    const filtered = needle        ? availableModels.filter((model) =>              `${model.group} ${model.label} ${model.id}`                  .toLowerCase()                  .includes(needle),          )        : availableModels;    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys)
        : selected?.group === "Codex";
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => searchRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);
    const close = () => {
        setOpen(false);
        setQuery("");
    };
    const choose = (id: string) => {
        onChange(id);
        close();
    };
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
                role="combobox"
                aria-expanded={open}
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={() => {
                    setQuery("");
                    setOpen(true);
                }}
                title={
                    selectedAvailable
                        ? label
                        : "API key missing for selected model"
                }
                aria-label={`Model: ${label}`}
                className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-2 text-left text-sm text-gray-700 hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-default disabled:opacity-50"
            >
                <span className="truncate">{label}</span>
                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>
            <Modal
                open={open}
                onClose={close}
                breadcrumbs={["Choose model"]}
                size="sm"
                className="!h-[min(20rem,calc(100dvh-2rem))] max-w-[calc(100vw-2rem)]"
            >
                <label className="flex h-10 shrink-0 items-center gap-2 border-y border-gray-200 px-2">
                    <Search
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-gray-500"
                    />
                    <span className="sr-only">Search models</span>
                    <input
                        ref={searchRef}
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                close();
                            } else if (event.key === "Enter" && filtered[0]) {
                                event.preventDefault();
                                choose(filtered[0].id);
                            }
                        }}
                        placeholder="Search models"
                        className="h-full min-w-0 flex-1 bg-white text-sm text-gray-900 outline-none placeholder:text-gray-500"
                    />
                </label>
                <div
                    role="listbox"
                    aria-label="Models"
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
                >
                    {groups.map((group) => {
                        const options = filtered.filter(
                            (model) => model.group === group,
                        );
                        if (!options.length) return null;
                        return (
                            <div key={group} role="group" aria-label={group}>
                                <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
                                    {group}
                                </div>
                                {options.map((model) => (
                                    <button
                                        key={model.id}
                                        type="button"
                                        role="option"
                                        aria-selected={model.id === value}
                                        onClick={() => choose(model.id)}
                                        className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
                                    >
                                        <Check
                                            aria-hidden="true"
                                            className={cn(
                                                "h-4 w-4 shrink-0 text-red-700",
                                                model.id !== value &&
                                                    "invisible",
                                            )}
                                        />
                                        <span className="min-w-0 flex-1 truncate">
                                            {model.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        );
                    })}
                    {!filtered.length && (
                        <p className="px-3 py-6 text-center text-sm text-gray-600">
                            {availableModels.length
                                ? "No matching models"
                                : "No configured models"}
                        </p>
                    )}
                </div>
            </Modal>
        </span>
    );
}
