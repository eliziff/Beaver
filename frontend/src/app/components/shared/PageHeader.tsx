"use client";

import {
    type ButtonHTMLAttributes,
    type ReactNode,
} from "react";
import { ChevronLeft, Loader2, Plus, Search } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
    APP_SURFACE_PRESSED_CLASS,
} from "@/app/components/ui/liquid-surface";

export interface PageHeaderBreadcrumb {
    label?: ReactNode;
    onClick?: () => void;
    cursor?: "text";
    loading?: boolean;
    skeletonClassName?: string;
    title?: string;
}

type PageHeaderButtonAction = {
    type?: never;
    icon?: ReactNode;
    label?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    iconOnly?: boolean;
};

type PageHeaderSearchAction = {
    type: "search";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
};

type PageHeaderNewAction = {
    type: "new";
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    title?: string;
};

type PageHeaderCustomAction = {
    type: "custom";
    render: ReactNode;
};

export type PageHeaderAction =
    | PageHeaderButtonAction
    | PageHeaderSearchAction
    | PageHeaderNewAction
    | PageHeaderCustomAction;

type MaybePageHeaderAction = PageHeaderAction | null | false | undefined;
const CONTROL_CLASS =
    "flex h-9 items-center justify-center rounded-md border border-gray-300 bg-white text-sm text-gray-500 hover:text-gray-900 disabled:cursor-default disabled:text-gray-400 disabled:hover:bg-white disabled:hover:text-gray-400";

interface PageHeaderProps {
    children?: ReactNode;
    actions?: MaybePageHeaderAction[];
    shrink?: boolean;
    breadcrumbs?: PageHeaderBreadcrumb[];
    loading?: boolean;
}

export function PageHeader({
    children,
    actions,
    shrink = false,
    breadcrumbs,
    loading = false,
}: PageHeaderProps) {
    const headerContent = breadcrumbs?.length ? (
        <PageHeaderBreadcrumbs items={breadcrumbs} />
    ) : (
        children
    );
    const actionsDisabled =
        loading || !!breadcrumbs?.some((item) => item.loading);
    const actionItems = actions?.filter(isPresentAction) ?? [];
    const hasActions = actionItems.length > 0;

    return (
        <div
            className={cn(
                "flex min-w-0 flex-wrap items-center justify-between gap-4",
                "mx-4 md:mx-6",
                "min-h-[76px] pb-4 pt-5.5",
                shrink && "shrink-0",
            )}
        >
            {headerContent}
            {hasActions && (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-3 md:flex-none">
                    <PageHeaderActions
                        actions={actionItems}
                        actionsDisabled={actionsDisabled}
                    />
                </div>
            )}
        </div>
    );
}

function PageHeaderActions({
    actions,
    actionsDisabled,
}: {
    actions: PageHeaderAction[];
    actionsDisabled: boolean;
}) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            {actions.map((action, index) => (
                <PageHeaderActionRenderer
                    key={index}
                    action={action}
                    disabled={actionsDisabled}
                />
            ))}
        </div>
    );
}

function isPresentAction(action: MaybePageHeaderAction): action is PageHeaderAction {
    return Boolean(action);
}

function PageHeaderActionRenderer({
    action,
    disabled,
}: {
    action: PageHeaderAction;
    disabled: boolean;
}) {
    switch (action.type) {
        case "search":
            return (
                <PageHeaderSearchActionControl
                    action={action}
                    disabled={disabled}
                />
            );
        case "new":
            return (
                <PageHeaderNewActionControl
                    action={action}
                    disabled={disabled}
                />
            );
        case "custom":
            return (
                <span
                    className={cn(
                        "inline-flex h-7 items-center",
                        disabled && "pointer-events-none opacity-40",
                    )}
                >
                    {action.render}
                </span>
            );
        default:
            return (
                <PageHeaderButtonActionControl
                    action={action}
                    disabled={disabled}
                />
            );
    }
}

function PageHeaderButtonActionControl({
    action,
    disabled,
}: {
    action: PageHeaderButtonAction;
    disabled: boolean;
}) {
    const iconOnly = action.iconOnly ?? !action.label;
    return (
        <PageHeaderActionButton
            onClick={action.onClick}
            disabled={disabled || action.disabled}
            title={action.title}
            aria-label={action.title}
            iconOnly={iconOnly}
        >
            {action.icon}
            {action.label}
        </PageHeaderActionButton>
    );
}

function PageHeaderNewActionControl({
    action,
    disabled,
}: {
    action: PageHeaderNewAction;
    disabled: boolean;
}) {
    const title = action.title ?? "New";
    return (
        <PageHeaderActionButton
            onClick={action.onClick}
            disabled={disabled || action.disabled || action.loading}
            title={title}
            aria-label={title}
            aria-keyshortcuts="Alt+N"
            data-page-new
        >
            {action.loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Plus className="h-4 w-4" />
            )}
            {title}
        </PageHeaderActionButton>
    );
}

function PageHeaderSearchActionControl({
    action,
    disabled,
}: {
    action: PageHeaderSearchAction;
    disabled: boolean;
}) {
    const placeholder = action.placeholder ?? "Search…";

    return (
        <div
            className={cn(
                CONTROL_CLASS,
                "w-56 max-w-[calc(100vw-6.5rem)] cursor-text justify-start gap-2 px-3 text-gray-700 hover:text-gray-700 sm:w-72",
                APP_SURFACE_ACTIVE_CLASS,
                disabled && "opacity-60",
            )}
        >
            <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <input
                data-page-search
                aria-keyshortcuts="/"
                disabled={disabled}
                type="search"
                placeholder={placeholder}
                value={action.value}
                onChange={(e) => action.onChange(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
            />
        </div>
    );
}

type PageHeaderActionButtonProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    iconOnly?: boolean;
};

function PageHeaderActionButton({
    children,
    iconOnly = false,
    disabled,
    ...props
}: PageHeaderActionButtonProps) {
    return (
        <button
            disabled={disabled}
            className={cn(
                CONTROL_CLASS,
                APP_SURFACE_HOVER_CLASS,
                APP_SURFACE_PRESSED_CLASS,
                iconOnly ? "w-9" : "gap-1.5 px-3",
                disabled ? "cursor-default" : "cursor-pointer",
            )}
            {...props}
        >
            {children}
        </button>
    );
}

function PageHeaderBreadcrumbs({ items }: { items: PageHeaderBreadcrumb[] }) {
    const parent = [...items]
        .slice(0, -1)
        .reverse()
        .find((item) => item.onClick);

    return (
        <div className="flex min-w-0 items-center gap-1.5 text-2xl font-medium font-serif">
            {parent?.onClick && (
                <button
                    onClick={parent.onClick}
                    className="shrink-0 text-gray-400 transition-colors hover:text-gray-600 sm:hidden"
                    title={parent.title ?? "Back"}
                    aria-label={parent.title ?? "Back"}
                >
                    <ChevronLeft className="h-5 w-5" />
                </button>
            )}
            <div className="flex min-w-0 items-center gap-1.5">
                {items.map((item, index) => (
                    <BreadcrumbItem
                        key={index}
                        item={item}
                        current={index === items.length - 1}
                    />
                ))}
            </div>
        </div>
    );
}

function BreadcrumbItem({
    item,
    current,
}: {
    item: PageHeaderBreadcrumb;
    current: boolean;
}) {
    const content = item.loading ? (
        <div
            className={cn(
                "h-6 rounded bg-gray-100",
                item.skeletonClassName ?? "w-32",
            )}
        />
    ) : (
        <>
            <span
                className={cn(
                    "truncate",
                    item.cursor === "text" && "cursor-text",
                )}
            >
                {item.label}
            </span>
        </>
    );

    const className = cn(
        "min-w-0 truncate transition-colors",
        item.cursor === "text" && "cursor-text",
        current
            ? "text-gray-900"
            : item.onClick
              ? "text-gray-500 hover:text-gray-700"
              : "text-gray-500",
    );
    const wrapperClassName = cn(
        "min-w-0 items-center gap-1.5",
        current ? "flex" : "hidden sm:flex",
    );

    return (
        <span className={wrapperClassName}>
            {current ? (
                <span className={className}>{content}</span>
            ) : item.onClick ? (
                <button onClick={item.onClick} className={className}>
                    {content}
                </button>
            ) : (
                <span className={className}>{content}</span>
            )}
            {!current && <span className="shrink-0 text-gray-300">›</span>}
        </span>
    );
}
