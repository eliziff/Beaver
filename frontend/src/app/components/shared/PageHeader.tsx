import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronLeft, Loader2, Plus } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
    APP_SURFACE_PRESSED_CLASS,
} from "@/app/components/ui/liquid-surface";

export interface PageHeaderBreadcrumb {
    label?: ReactNode;
    onClick?: () => void;
    loading?: boolean;
    skeletonClassName?: string;
    title?: string;
}
type ButtonAction = {
    type?: never;
    icon?: ReactNode;
    label?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    iconOnly?: boolean;
};
type SearchAction = {
    type: "search";
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    booleanSearch?: boolean;
};
type NewAction = {
    type: "new";
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    title?: string;
};
type CustomAction = { type: "custom"; render: ReactNode };
export type PageHeaderAction =
    | ButtonAction
    | SearchAction
    | NewAction
    | CustomAction;
type OptionalAction = PageHeaderAction | null | false | undefined;

export function PageHeader({
    children,
    actions,
    shrink = false,
    stacked = false,
    breadcrumbs,
    loading = false,
    className,
}: {
    children?: ReactNode;
    actions?: OptionalAction[];
    shrink?: boolean;
    stacked?: boolean;
    breadcrumbs?: PageHeaderBreadcrumb[];
    loading?: boolean;
    className?: string;
}) {
    const items = actions?.filter(
        (action): action is PageHeaderAction => Boolean(action),
    );
    const disabled =
        loading || !!breadcrumbs?.some((breadcrumb) => breadcrumb.loading);
    const stackActions = (items?.length ?? 0) > 4;
    const wideMobileActions = stackActions || !!items?.some((action) =>
        action.type === "search");
    return (
        <div
            className={cn(
                "mx-4 flex min-h-14 min-w-0 flex-row flex-wrap items-center justify-between gap-3 py-2 md:mx-6 lg:min-h-[max(76px,4.625rem)] lg:flex-nowrap lg:gap-4 lg:pb-4 lg:pt-5.5",
                shrink && "shrink-0",
                stacked && "flex-col items-stretch lg:flex-col lg:items-stretch",
                className,
            )}
        >
            {breadcrumbs?.length ? (
                <Breadcrumbs items={breadcrumbs} stacked={stacked} />
            ) : (
                children
            )}
            {!!items?.length && (
                <div className={cn(
                    "flex min-w-0 items-center justify-end gap-2 md:shrink-0",
                    wideMobileActions ? "w-full md:w-auto" : "shrink-0",
                    stackActions && "w-full flex-wrap sm:w-auto sm:flex-nowrap",
                    stacked && "w-full justify-start sm:w-full sm:flex-wrap md:w-full",
                )}>
                    {items.map((action, index) => (
                        <Action
                            key={index}
                            action={action}
                            disabled={disabled}
                            stackOnMobile={stackActions}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function Action({
    action,
    disabled,
    stackOnMobile,
}: {
    action: PageHeaderAction;
    disabled: boolean;
    stackOnMobile: boolean;
}) {
    if (action.type === "search") {
        return <SearchBar data-page-search aria-keyshortcuts="/"
            aria-label={action.placeholder ?? "Search"}
            disabled={disabled} placeholder={action.placeholder ?? "Search\u2026"}
            value={action.value} onValueChange={action.onChange}
            booleanSearch={action.booleanSearch}
            wrapperClassName={cn(APP_SURFACE_ACTIVE_CLASS,
                stackOnMobile
                    ? "w-full max-w-none flex-none sm:w-64"
                    : "w-36 max-w-none flex-1 sm:w-64 sm:flex-none")} />;
    }
    if (action.type === "custom") {
        return (
            <span
                className={cn(
                    "inline-flex h-9 items-center",
                    disabled && "pointer-events-none opacity-40",
                )}
            >
                {action.render}
            </span>
        );
    }
    if (action.type === "new") {
        return <NewPageAction {...action} disabled={disabled || action.disabled} />;
    }
    return (
        <ActionButton
            onClick={action.onClick}
            disabled={disabled || action.disabled}
            title={action.title}
            aria-label={action.title}
            iconOnly={action.iconOnly ?? !action.label}
        >
            {action.icon}
            {action.label}
        </ActionButton>
    );
}

export function NewPageAction({ title = "New", onClick, disabled, loading }: Omit<NewAction, "type">) {
    return (
        <ActionButton
            primary
            onClick={onClick}
            disabled={disabled || loading}
            title={title}
            aria-label={title}
            aria-keyshortcuts="Alt+N"
            data-page-new
        >
            {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Plus className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">{title}</span>
        </ActionButton>
    );
}

function ActionButton({
    children,
    iconOnly = false,
    primary = false,
    disabled,
    ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
    iconOnly?: boolean;
    primary?: boolean;
}) {
    return (
        <Button
            disabled={disabled}
            variant={primary ? "default" : "outline"}
            size={iconOnly ? "icon-sm" : "default"}
            className={cn(
                "h-9 disabled:cursor-default",
                !primary && "text-gray-500 hover:text-gray-900 disabled:text-gray-400 disabled:hover:bg-white disabled:hover:text-gray-400",
                !primary && APP_SURFACE_HOVER_CLASS,
                !primary && APP_SURFACE_PRESSED_CLASS,
                iconOnly ? "w-9" : "gap-1.5 px-3",
                disabled ? "cursor-default" : "cursor-pointer",
            )}
            {...props}
        >
            {children}
        </Button>
    );
}

function Breadcrumbs({ items, stacked }: { items: PageHeaderBreadcrumb[]; stacked: boolean }) {
    if (stacked) {
        const current = items.at(-1)!;
        return <div className="w-full min-w-0">
            {items.length > 1 && <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                {items.slice(0, -1).map((item, index) => <span key={index} className="inline-flex items-center gap-1.5">
                    {index > 0 && <span aria-hidden>›</span>}
                    {item.onClick ? <button type="button" onClick={item.onClick} className="hover:text-gray-800">{item.label}</button> : item.label}
                </span>)}
            </nav>}
            <h1 className="font-serif text-2xl font-medium leading-snug text-gray-900 [overflow-wrap:anywhere]">
                {current.loading ? <span className="block h-7 w-48 rounded bg-gray-100" /> : current.label}
            </h1>
        </div>;
    }
    const parent = [...items]
        .slice(0, -1)
        .reverse()
        .find((item) => item.onClick);
    return (
        <div className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 font-serif text-2xl font-medium md:flex-1">
            {parent?.onClick && (
                <button
                    onClick={parent.onClick}
                    className="shrink-0 text-gray-600 hover:text-gray-900 sm:hidden"
                    title={parent.title ?? "Back"}
                    aria-label={parent.title ?? "Back"}
                >
                    <ChevronLeft className="h-5 w-5" />
                </button>
            )}
            <div className="flex min-w-0 items-center gap-1.5">
                {items.map((item, index) => (
                    <Breadcrumb
                        key={index}
                        item={item}
                        current={index === items.length - 1}
                    />
                ))}
            </div>
        </div>
    );
}

function Breadcrumb({
    item,
    current,
}: {
    item: PageHeaderBreadcrumb;
    current: boolean;
}) {
    const content = item.loading ? (
        <span
            className={cn(
                "h-6 rounded bg-gray-100",
                item.skeletonClassName ?? "w-32",
            )}
        />
    ) : (
        <span className="truncate">{item.label}</span>
    );
    const className = cn(
        "min-w-0 truncate",
        current && "w-full text-gray-900",
        !current &&
            (item.onClick
                ? "text-gray-500 hover:text-gray-700"
                : "text-gray-500"),
    );
    return (
        <div
            className={cn(
                "min-w-0 items-center gap-1.5",
                current
                    ? "flex flex-1"
                    : "hidden max-w-40 font-sans text-sm sm:flex",
            )}
        >
            {current ? (
                <h1 className={className}>{content}</h1>
            ) : item.onClick ? (
                <button onClick={item.onClick} className={className}>
                    {content}
                </button>
            ) : (
                <span className={className}>{content}</span>
            )}
            {!current && (
                <span className="shrink-0 text-gray-300">{"\u203A"}</span>
            )}
        </div>
    );
}
