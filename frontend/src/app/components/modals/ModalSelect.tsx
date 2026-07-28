"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Modal } from "./Modal";

export type ModalSelectOption =
    | string
    | {
          value: string;
          label: string;
      };

interface ModalSelectProps {
    id: string;
    value: string;
    options: readonly ModalSelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    searchable?: boolean;
    ariaLabel?: string;
}

function normalizeOption(option: ModalSelectOption) {
    return typeof option === "string"
        ? { value: option, label: option }
        : option;
}

export function ModalSelect({
    id,
    value,
    options,
    onChange,
    placeholder = "Select...",
    disabled = false,
    className,
    searchable = false,
    ariaLabel,
}: ModalSelectProps) {
    const normalizedOptions = options.map(normalizeOption);
    const selected = normalizedOptions.find((option) => option.value === value);

    if (searchable || normalizedOptions.length > 8) {
        return (
            <SearchableModalSelect
                id={id}
                value={value}
                options={normalizedOptions}
                onChange={onChange}
                placeholder={placeholder}
                disabled={disabled}
                className={className}
                ariaLabel={ariaLabel}
            />
        );
    }

    return (
        <select
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            title={selected?.label ?? placeholder}
            aria-label={ariaLabel}
            className={cn(
                "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-600 disabled:cursor-not-allowed disabled:opacity-60",
                className,
            )}
        >
            {!normalizedOptions.some((option) => option.value === "") && (
                <option value="" disabled>
                    {placeholder}
                </option>
            )}
            {normalizedOptions.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

function SearchableModalSelect({
    id,
    value,
    options,
    onChange,
    placeholder,
    disabled,
    className,
    ariaLabel,
}: {
    id: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    placeholder: string;
    disabled: boolean;
    className?: string;
    ariaLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const selected = options.find((option) => option.value === value);
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return needle
            ? options.filter((option) =>
                  option.label.toLowerCase().includes(needle),
              )
            : options;
    }, [options, query]);
    const close = () => {
        setOpen(false);
        setQuery("");
    };

    return (
        <>
            <button
                id={id}
                type="button"
                disabled={disabled}
                onClick={() => setOpen(true)}
                title={selected?.label ?? placeholder}
                aria-label={ariaLabel}
                className={cn(
                    "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 text-left text-sm text-gray-900 outline-none hover:border-gray-500 focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-not-allowed disabled:opacity-60",
                    className,
                )}
            >
                <span className="truncate">
                    {selected?.label ?? placeholder}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            </button>
            <Modal
                open={open}
                onClose={close}
                breadcrumbs={["Choose option"]}
                size="sm"
                className="!h-[min(20rem,calc(100dvh-2rem))] max-w-[calc(100vw-2rem)]"
            >
                <label className="flex h-10 shrink-0 items-center gap-2 border-y border-gray-200 px-2">
                    <Search
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-gray-500"
                    />
                    <span className="sr-only">Search options</span>
                    <input
                        type="search"
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                close();
                            } else if (event.key === "Enter" && filtered[0]) {
                                event.preventDefault();
                                onChange(filtered[0].value);
                                close();
                            }
                        }}
                        placeholder="Search options"
                        className="h-full min-w-0 flex-1 bg-white text-sm outline-none"
                    />
                </label>
                <div
                    role="listbox"
                    className="min-h-0 flex-1 overflow-y-auto py-1"
                >
                    {filtered.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={option.value === value}
                            onClick={() => {
                                onChange(option.value);
                                close();
                            }}
                            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-100"
                        >
                            <Check
                                aria-hidden="true"
                                className={cn(
                                    "h-4 w-4 shrink-0 text-red-700",
                                    option.value !== value && "invisible",
                                )}
                            />
                            <span className="truncate">{option.label}</span>
                        </button>
                    ))}
                    {!filtered.length && (
                        <p className="px-3 py-6 text-center text-sm text-gray-600">
                            No matching options
                        </p>
                    )}
                </div>
            </Modal>
        </>
    );
}
