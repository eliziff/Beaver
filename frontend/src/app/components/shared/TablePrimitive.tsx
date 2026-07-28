"use client";

import {
    useRef,
    useState,
    type HTMLAttributes,
    type ReactNode,
    type RefObject,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_GROUP_HOVER_CLASS,
    APP_SURFACE_HOVER_CLASS,
    LIQUID_TABLE_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { CheckboxControl } from "@/app/components/ui/checkbox";

export const TABLE_STICKY_CELL_BG = "bg-app-surface";
export const TABLE_PRIMARY_CELL_WIDTH_CLASS =
    "w-[248px] sm:w-[292px] md:w-[332px] shrink-0";
export const TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS =
    "w-[190px] sm:w-[260px] md:w-[300px] xl:w-[320px] 2xl:w-[332px] shrink-0";
type DivProps = HTMLAttributes<HTMLDivElement>;

export type TableFilterOption<T extends string> = {
    value: T;
    label: string;
};

export type TableSortDirection = "asc" | "desc";

export function TableFilters<T extends string>({
    label,
    value,
    allLabel,
    options,
    onChange,
    searchable = false,
}: {
    label: string;
    value: T | null;
    allLabel: string;
    options: TableFilterOption<T>[];
    onChange: (value: T | null) => void;
    searchable?: boolean;
}) {
    if (searchable || options.length > 8) {
        return (
            <SearchableTableFilter
                label={label}
                value={value}
                allLabel={allLabel}
                options={options}
                onChange={onChange}
            />
        );
    }

    const selected = options.find((option) => option.value === value);

    return (
        <label
            title={selected?.label ?? label}
            className={`relative flex h-7 w-7 items-center justify-center rounded ${
                value
                    ? `text-gray-700 ${APP_SURFACE_HOVER_CLASS} hover:text-gray-900`
                    : `text-gray-400 ${APP_SURFACE_HOVER_CLASS} hover:text-gray-700`
            }`}
        >
            <select
                aria-label={label}
                value={value ?? ""}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) =>
                    onChange(
                        event.currentTarget.value
                            ? (event.currentTarget.value as T)
                            : null,
                    )
                }
                className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            >
                <option value="">{allLabel}</option>
                {options.map((option) => {
                    return (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    );
                })}
            </select>
            <ChevronDown className="h-4 w-4 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gray-500" />
        </label>
    );
}

function SearchableTableFilter<T extends string>({
    label,
    value,
    allLabel,
    options,
    onChange,
}: {
    label: string;
    value: T | null;
    allLabel: string;
    options: TableFilterOption<T>[];
    onChange: (value: T | null) => void;
}) {
    const [open, setOpen] = useState(false);
    const items = [{ value: null, label: allLabel }, ...options];

    return (
        <>
            <button
                type="button"
                aria-label={label}
                title={items.find((item) => item.value === value)?.label ?? label}
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen(true);
                }}
                className={cn(
                    "relative flex h-7 w-7 items-center justify-center rounded",
                    value
                        ? "text-gray-700 hover:bg-gray-100"
                        : "text-gray-500 hover:bg-gray-100 hover:text-gray-800",
                )}
            >
                <ChevronDown className="h-4 w-4" />
            </button>
            <SearchableChoiceModal
                open={open}
                onClose={() => setOpen(false)}
                title={label}
                value={value}
                options={items}
                onChange={(next) => onChange(next as T | null)}
            />
        </>
    );
}

export function SkeletonLine({ className }: { className?: string }) {
    return (
        <div
            className={cn("h-3 rounded bg-gray-200", className)}
        />
    );
}

export function SkeletonDot({ className }: { className?: string }) {
    return (
        <div
            className={cn(
                "h-3 w-3 shrink-0 rounded bg-gray-200",
                className,
            )}
        />
    );
}

export function TableSelectionPlaceholder() {
    return (
        <span
            aria-hidden="true"
            className="-ml-2 mr-1 inline-flex min-h-9 min-w-9 shrink-0"
        />
    );
}

export function TableScrollArea({
    children,
    className,
    header,
    scrollRef,
}: Omit<DivProps, "onScroll"> & {
    header?: ReactNode;
    scrollRef?: RefObject<HTMLDivElement | null>;
}) {
    const headerViewportRef = useRef<HTMLDivElement>(null);

    return (
        <div className={cn("mx-4 mb-2 min-h-0 min-w-0 flex-1 md:mx-6 md:mb-3", className)}>
            <div className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden", LIQUID_TABLE_SURFACE_CLASS)}>
                {header && (
                    <div
                        ref={headerViewportRef}
                        className="min-w-0 shrink-0 overflow-hidden [scrollbar-gutter:stable]"
                    >
                        {header}
                    </div>
                )}
                <div
                    ref={scrollRef}
                    className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto overscroll-x-none"
                    onScroll={(event) => {
                        if (headerViewportRef.current) {
                            headerViewportRef.current.scrollLeft =
                                event.currentTarget.scrollLeft;
                        }
                    }}
                >
                    {children}
                </div>
            </div>
        </div>
    );
}

export function TableHeaderRow({ children, className, ...props }: DivProps) {
    return (
        <div
            className={cn(
                "z-[70] flex h-11 min-w-max items-center bg-app-surface pr-3 text-sm font-semibold text-gray-700 select-none",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableRow({
    children,
    className,
    interactive = true,
    selected = false,
    ...props
}: DivProps & {
    interactive?: boolean;
    selected?: boolean;
}) {
    return (
        <div
            className={cn(
                "group flex h-11 min-w-max items-center pr-3",
                interactive && "cursor-pointer",
                interactive && !selected && APP_SURFACE_HOVER_CLASS,
                selected && APP_SURFACE_ACTIVE_CLASS,
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableStickyCell({
    children,
    className,
    widthClassName = TABLE_PRIMARY_CELL_WIDTH_CLASS,
    bgClassName = TABLE_STICKY_CELL_BG,
    header = false,
    hover = true,
}: DivProps & {
    widthClassName?: string;
    bgClassName?: string;
    header?: boolean;
    hover?: boolean;
}) {
    return (
        <div
            className={cn(
                "sticky left-0 z-[60] flex pl-4 pr-2 text-left",
                widthClassName,
                bgClassName,
                header
                    ? "z-[80] items-center self-stretch"
                    : "py-2",
                !header && hover && APP_SURFACE_GROUP_HOVER_CLASS,
                className,
            )}
        >
            {children}
        </div>
    );
}

export function TablePrimaryCell({
    children,
    className,
    widthClassName = TABLE_PRIMARY_CELL_WIDTH_CLASS,
    bgClassName,
    selected,
    onSelectionChange,
    checkboxTitle,
    label,
    editing = false,
    editValue,
    onEditValueChange,
    onEditCommit,
    onEditCancel,
}: DivProps & {
    widthClassName?: string;
    bgClassName?: string;
    selected: boolean;
    onSelectionChange: () => void;
    checkboxTitle?: string;
    label?: ReactNode;
    editing?: boolean;
    editValue?: string;
    onEditValueChange?: (value: string) => void;
    onEditCommit?: () => void;
    onEditCancel?: () => void;
}) {
    const content =
        label !== undefined ? (
            editing ? (
                <input
                    autoFocus
                    value={editValue ?? ""}
                    onChange={(e) => onEditValueChange?.(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onEditCommit?.();
                        if (e.key === "Escape") onEditCancel?.();
                    }}
                    onBlur={onEditCommit}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 text-sm text-gray-800 bg-transparent outline-none"
                />
            ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-gray-900">
                    {label}
                </span>
            )
        ) : (
            children
        );

    return (
        <TableStickyCell
            widthClassName={widthClassName}
            bgClassName={
                selected ? APP_SURFACE_ACTIVE_CLASS : bgClassName
            }
            className={className}
            hover={!selected}
        >
            <div className="flex min-w-0 items-center">
                <CheckboxControl
                    checked={selected}
                    onChange={onSelectionChange}
                    onClick={(e) => e.stopPropagation()}
                    className="-ml-2 mr-1"
                    title={checkboxTitle}
                />
                {content}
            </div>
        </TableStickyCell>
    );
}

export function TableHeaderCell({ children, className, ...props }: DivProps) {
    return (
        <div
            className={cn(
                "flex shrink-0 items-center px-2 text-left",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableCell({ children, className, ...props }: DivProps) {
    return (
        <div
            className={cn(
                "shrink-0 truncate px-2 text-sm text-gray-700",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableBody({ children, className, ...props }: DivProps) {
    return (
        <div className={cn("flex-1", className)} {...props}>
            {children}
        </div>
    );
}

export function TableEmptyState({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full max-w-xs flex-1 flex-col items-start justify-center py-24",
                className,
            )}
        >
            {children}
        </div>
    );
}
