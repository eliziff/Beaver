import type { ButtonHTMLAttributes, ReactNode } from "react";
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
const CONTROL =
    "flex h-9 items-center justify-center rounded-md border border-gray-300 bg-white text-sm text-gray-500 hover:text-gray-900 disabled:cursor-default disabled:text-gray-400 disabled:hover:bg-white disabled:hover:text-gray-400";

export function PageHeader({
    children,
    actions,
    shrink = false,
    breadcrumbs,
    loading = false,
}: {
    children?: ReactNode;
    actions?: OptionalAction[];
    shrink?: boolean;
    breadcrumbs?: PageHeaderBreadcrumb[];
    loading?: boolean;
}) {
    const items = actions?.filter(
        (action): action is PageHeaderAction => Boolean(action),
    );
    const disabled =
        loading || !!breadcrumbs?.some((breadcrumb) => breadcrumb.loading);
    return (
        <div
            className={cn(
                "mx-4 flex min-h-[max(76px,4.625rem)] min-w-0 flex-col items-stretch justify-between gap-4 pb-4 pt-5.5 md:mx-6 md:flex-row md:items-center",
                shrink && "shrink-0",
            )}
        >
            {breadcrumbs?.length ? (
                <Breadcrumbs items={breadcrumbs} />
            ) : (
                children
            )}
            {!!items?.length && (
                <div className="flex min-w-0 items-center justify-end gap-2 md:shrink-0">
                    {items.map((action, index) => (
                        <Action
                            key={index}
                            action={action}
                            disabled={disabled}
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
}: {
    action: PageHeaderAction;
    disabled: boolean;
}) {
    if (action.type === "search") {
        return (
            <label
                className={cn(
                    CONTROL,
                    APP_SURFACE_ACTIVE_CLASS,
                    "w-36 min-w-0 max-w-[calc(100vw-6.5rem)] flex-1 cursor-text justify-start gap-2 px-3 text-gray-700 hover:text-gray-700 sm:w-72 sm:flex-none",
                    disabled && "opacity-60",
                )}
            >
                <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <input
                    data-page-search
                    aria-keyshortcuts="/"
                    disabled={disabled}
                    type="search"
                    placeholder={action.placeholder ?? "Search\u2026"}
                    value={action.value}
                    onChange={(event) => action.onChange(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
                />
            </label>
        );
    }
    if (action.type === "custom") {
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
    }
    if (action.type === "new") {
        const title = action.title ?? "New";
        return (
            <ActionButton
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
                <span className="hidden sm:inline">{title}</span>
            </ActionButton>
        );
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

function ActionButton({
    children,
    iconOnly = false,
    disabled,
    ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
    iconOnly?: boolean;
}) {
    return (
        <button
            disabled={disabled}
            className={cn(
                CONTROL,
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

function Breadcrumbs({ items }: { items: PageHeaderBreadcrumb[] }) {
    const parent = [...items]
        .slice(0, -1)
        .reverse()
        .find((item) => item.onClick);
    return (
        <div className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 font-serif text-2xl font-medium md:flex-1">
            {parent?.onClick && (
                <button
                    onClick={parent.onClick}
                    className="shrink-0 text-gray-400 hover:text-gray-600 sm:hidden"
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
        <span
            className={cn(
                "min-w-0 items-center gap-1.5",
                current ? "flex flex-1" : "hidden max-w-40 sm:flex",
            )}
        >
            {current ? (
                <span className={className}>{content}</span>
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
        </span>
    );
}
