import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import { cn } from "@/app/lib/utils";
import { Modal, type ModalSize } from "./Modal";
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
    placeholder?: string | null;
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
                    title={selected?.label ?? placeholder ?? undefined}
                    aria-label={ariaLabel}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    className={cn(
                        "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 text-left text-sm text-gray-900 outline-none hover:border-gray-500 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
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
            title={selected?.label ?? placeholder ?? undefined}
            aria-label={ariaLabel}
            className={cn(
                "h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                className,
            )}
        >
            {placeholder !== null && !normalizedOptions.some((option) => option.value === "") && (
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
    description?: string;
    disabled?: boolean;
};
export function SearchableChoiceModal({
    open,
    onClose,
    title,
    searchLabel = "Search options",
    value,
    options,
    onChange,
    searchable = true,
    size = "sm",
    className,
    controls,
    footer,
    leadPanel,
    sidePanel,
    closeOnSelect = true,
}: {
    open: boolean;
    onClose: () => void;
    title: string;
    searchLabel?: string;
    value: string | null;
    options: readonly SearchableChoice[];
    onChange: (value: string | null) => void;
    searchable?: boolean;
    size?: ModalSize;
    className?: string;
    controls?: ReactNode;
    footer?: ReactNode;
    leadPanel?: ReactNode;
    sidePanel?: ReactNode;
    closeOnSelect?: boolean;
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
              `${option.label} ${option.group ?? ""} ${option.keywords ?? ""} ${option.description ?? ""}`
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
        if (closeOnSelect) close();
    };
    return (
        <Modal
            open={open}
            onClose={close}
            breadcrumbs={[title]}
            size={size}
            className={cn(size === "sm" && "h-[min(20rem,calc(100dvh-2rem))]", className)}
        >
            {controls}
            <div className="flex min-h-0 flex-1 gap-3 pb-4 sm:gap-5">
            {leadPanel && <nav className="w-28 shrink-0 overflow-y-auto border-r border-gray-200 pr-2 sm:w-52 sm:pr-4">{leadPanel}</nav>}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {searchable && (
                <SearchBar
                    ref={searchRef}
                    value={query}
                    onValueChange={setQuery}
                    onKeyDown={(event) => {
                        const first = visible.find((option) => !option.disabled);
                        if (event.key === "Enter" && first) {
                            event.preventDefault();
                            choose(first.value);
                        }
                    }}
                    placeholder={searchLabel}
                    aria-label={searchLabel}
                    clearable={false}
                    className="mb-2 h-9 shrink-0"
                />
            )}
            <div role="group" aria-label={title}
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
                            data-choice={option.value ?? undefined}
                            disabled={option.disabled}
                            aria-pressed={option.value === value}
                            aria-label={option.description
                                ? `${option.label}. ${option.description}` : undefined}
                            onClick={() => choose(option.value)}
                            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-800 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-700 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 disabled:hover:bg-gray-50"
                        >
                            <Check
                                aria-hidden="true"
                                className={cn(
                                    "h-4 w-4 shrink-0 text-red-700",
                                    option.value !== value && "invisible",
                                )}
                            />
                            <span className="min-w-0 flex-1">
                                <span className="block">{option.label}</span>
                                {option.description && <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                                    {option.description}
                                </span>}
                            </span>
                        </button>
                    </Fragment>
                ))}
                {!visible.length && (
                    <p className="px-3 py-6 text-center text-sm text-gray-600">
                        No matching options
                    </p>
                )}
            </div>
            </div>
            {sidePanel && <aside className="w-32 shrink-0 overflow-y-auto border-l border-gray-200 pl-4 sm:w-44">{sidePanel}</aside>}
            </div>
            {footer}
        </Modal>
    );
}
