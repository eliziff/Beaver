import {
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
