import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Modal } from "./Modal";
type ModalSelectOption =
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
    const [open, setOpen] = useState(false);
    const normalizedOptions = options.map((option) =>
        typeof option === "string" ? { value: option, label: option } : option,
    );
    const selected = normalizedOptions.find((option) => option.value === value);
    if (searchable || normalizedOptions.length > 8) {
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
                    <ChevronDown
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                    />
                </button>
                <SearchableChoiceModal
                    open={open}
                    onClose={() => setOpen(false)}
                    title={ariaLabel ?? "Choose option"}
                    value={value}
                    options={normalizedOptions}
                    onChange={(next) => {
                        if (next !== null) onChange(next);
                    }}
                />
            </>
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
type SearchableChoice = {
    value: string | null;
    label: string;
    group?: string;
    keywords?: string;
};
export function SearchableChoiceModal({
    open,
    onClose,
    title,
    searchLabel = "Search options",
    value,
    options,
    onChange,
}: {
    open: boolean;
    onClose: () => void;
    title: string;
    searchLabel?: string;
    value: string | null;
    options: readonly SearchableChoice[];
    onChange: (value: string | null) => void;
}) {
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => searchRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);
    const needle = query.trim().toLowerCase();
    const visible = needle
        ? options.filter((option) =>
              `${option.label} ${option.group ?? ""} ${option.keywords ?? ""}`
                  .toLowerCase()
                  .includes(needle),
          )
        : options;
    const close = () => {
        setQuery("");
        onClose();
    };
    const choose = (next: string | null) => {
        onChange(next);
        close();
    };
    return (
        <Modal
            open={open}
            onClose={close}
            breadcrumbs={[title]}
            size="sm"
            className="!h-[min(20rem,calc(100dvh-2rem))]"
        >
            <label className="flex h-10 shrink-0 items-center gap-2 border-y border-gray-200 px-2">
                <Search
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-gray-500"
                />
                <span className="sr-only">{searchLabel}</span>
                <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && visible[0]) {
                            event.preventDefault();
                            choose(visible[0].value);
                        }
                    }}
                    placeholder={searchLabel}
                    className="h-full min-w-0 flex-1 bg-white text-sm outline-none"
                />
            </label>
            <div
                role="listbox"
                aria-label={title}
                className="min-h-0 flex-1 overflow-y-auto py-1"
            >
                {visible.map((option, index) => (
                    <Fragment key={option.value ?? index}>
                        {option.group &&
                            option.group !== visible[index - 1]?.group && (
                                <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
                                    {option.group}
                                </div>
                            )}
                        <button
                            type="button"
                            role="option"
                            aria-selected={option.value === value}
                            onClick={() => choose(option.value)}
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
                    </Fragment>
                ))}
                {!visible.length && (
                    <p className="px-3 py-6 text-center text-sm text-gray-600">
                        No matching options
                    </p>
                )}
            </div>
        </Modal>
    );
}
