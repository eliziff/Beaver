import {
    type ComponentProps,
    type HTMLAttributes,
    type ReactNode,
    type RefObject,
} from "react";
import { cn } from "@/app/lib/utils";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
    LIQUID_TABLE_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { PillButton } from "@/app/components/ui/pill-button";
const TABLE_PRIMARY_CELL_WIDTH_CLASS =
    "w-[248px] sm:w-[292px] md:w-[332px] shrink-0";
export const TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS =
    "min-w-0 flex-1 sm:w-[260px] sm:flex-none md:w-[300px] xl:w-[320px] 2xl:w-[332px]";
type DivProps = HTMLAttributes<HTMLDivElement>;
export function SkeletonLine({ className }: { className?: string }) {
    return (
        <div
            className={cn("h-3 rounded bg-gray-200", className)}
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
export function TableSelectionCheckbox({
    className,
    indeterminate = false,
    loading = false,
    onClick,
    ...props
}: Omit<ComponentProps<typeof CheckboxControl>, "ref"> & {
    "aria-label": string;
    indeterminate?: boolean;
    loading?: boolean;
}) {
    if (loading) return <TableSelectionPlaceholder />;
    return (
        <CheckboxControl
            {...props}
            ref={(element) => { if (element) element.indeterminate = indeterminate; }}
            onClick={(event) => { event.stopPropagation(); onClick?.(event); }}
            className={cn("-ml-2 mr-1", className)}
        />
    );
}
export function useTableSelection<T extends { id: string }>(
    rows: readonly T[],
    selectedIds: readonly string[],
    onChange: (ids: string[]) => void,
) {
    const selected = new Set(selectedIds);
    const allSelected = rows.length > 0 && rows.every(({ id }) => selected.has(id));
    return {
        selected,
        allSelected,
        someSelected: !allSelected && rows.some(({ id }) => selected.has(id)),
        toggleAll: () => onChange(allSelected ? [] : rows.map(({ id }) => id)),
        toggle: (id: string) => onChange(selected.has(id)
            ? selectedIds.filter((selectedId) => selectedId !== id)
            : [...selectedIds, id]),
    };
}
export function TableScrollArea({
    children,
    className,
    header,
    scrollRef,
    horizontal = false,
}: Omit<DivProps, "onScroll"> & {
    header?: ReactNode;
    scrollRef?: RefObject<HTMLDivElement | null>;
    horizontal?: boolean;
}) {
    return (
        <div className={cn("mx-4 mb-2 min-h-0 min-w-0 flex-1 md:mx-6 md:mb-3", className)}>
            <div className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden", LIQUID_TABLE_SURFACE_CLASS)}>
                <div
                    ref={scrollRef}
                    className={cn(
                        "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]",
                        horizontal ? "overflow-x-auto" : "overflow-x-hidden",
                    )}
                >
                    {header && (
                        <div className="sticky top-0 z-[70] min-w-0 shrink-0">
                            {header}
                        </div>
                    )}
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
                "z-[70] flex h-11 min-w-0 items-center bg-app-surface pr-3 text-sm font-semibold text-gray-700 select-none",
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
                "group flex h-11 min-w-0 items-center pr-3 [content-visibility:auto] [contain-intrinsic-size:auto_44px]",
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
    header = false,
}: DivProps & {
    widthClassName?: string;
    header?: boolean;
}) {
    return (
        <div
            className={cn(
                "flex pl-4 pr-2 text-left",
                widthClassName,
                header
                    ? "items-center self-stretch"
                    : "py-2",
                className,
            )}
        >
            {children}
        </div>
    );
}
export function TableSelectionHeader({
    children, className, label, leading, loading = false,
    primaryClassName, selection, selectionLabel, widthClassName,
}: {
    children?: ReactNode;
    className?: string;
    label: ReactNode;
    leading?: ReactNode;
    loading?: boolean;
    primaryClassName?: string;
    selection?: { allSelected: boolean; someSelected: boolean; toggleAll: () => void };
    selectionLabel: string;
    widthClassName?: string;
}) {
    return (
        <TableHeaderRow className={className}>
            <TableStickyCell header className={primaryClassName} widthClassName={widthClassName}>
                {selection && <TableSelectionCheckbox loading={loading}
                    aria-label={selectionLabel} checked={selection.allSelected}
                    indeterminate={selection.someSelected} onChange={selection.toggleAll} />}
                {leading}
                <span className="mr-1">{label}</span>
            </TableStickyCell>
            {children}
        </TableHeaderRow>
    );
}
export function TablePrimaryCell({
    children,
    className,
    widthClassName = TABLE_PRIMARY_CELL_WIDTH_CLASS,
    selected,
    onSelectionChange,
    checkboxTitle,
    label,
    editing = false,
    editValue,
    onEditValueChange,
    onEditCommit,
    onEditCancel,
    selectable = true,
}: DivProps & {
    widthClassName?: string;
    selected: boolean;
    onSelectionChange: () => void;
    checkboxTitle?: string;
    label?: ReactNode;
    editing?: boolean;
    editValue?: string;
    onEditValueChange?: (value: string) => void;
    onEditCommit?: () => void;
    onEditCancel?: () => void;
    selectable?: boolean;
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
            className={className}
        >
            <div className="flex min-w-0 items-center">
                {selectable && <TableSelectionCheckbox
                    checked={selected}
                    onChange={onSelectionChange}
                    aria-label={checkboxTitle ?? (typeof label === "string"
                        ? `Select ${label}` : "Select row")}
                    title={checkboxTitle}
                />}
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
export function TableLoadingRows({
    count = 3,
    columns = [],
    primaryWidthClassName,
    primaryClassName,
    primaryLineClassName = "h-3.5 w-48",
    renderPrimary,
    rowClassName,
    selection = true,
}: {
    count?: number;
    columns?: readonly { className: string; lineClassName?: string }[];
    primaryWidthClassName?: string;
    primaryClassName?: string;
    primaryLineClassName?: string | ((index: number) => string);
    renderPrimary?: (index: number) => ReactNode;
    rowClassName?: string;
    selection?: boolean;
}) {
    return (
        <TableBody>
            {Array.from({ length: count }, (_, index) => (
                <TableRow key={index} interactive={false} className={rowClassName}>
                    <TableStickyCell widthClassName={primaryWidthClassName} className={primaryClassName}>
                        <div className="flex min-w-0 items-center">
                            {selection && <TableSelectionPlaceholder />}
                            {renderPrimary?.(index) ?? <SkeletonLine className={typeof primaryLineClassName === "function" ? primaryLineClassName(index) : primaryLineClassName} />}
                        </div>
                    </TableStickyCell>
                    {columns.map(({ className, lineClassName }, column) => (
                        <TableCell key={column} className={className}>
                            {lineClassName && <SkeletonLine className={lineClassName} />}
                        </TableCell>
                    ))}
                </TableRow>
            ))}
        </TableBody>
    );
}
export const TableLoadMore = ({ show, onClick }: {
    show: boolean; onClick: () => void;
}) => show ? (
        <div className="flex justify-center border-t border-gray-200 bg-white p-3">
            <PillButton tone="white" onClick={onClick}>Load more</PillButton>
        </div>
    ) : null;
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
