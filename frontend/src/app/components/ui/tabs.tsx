import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/app/lib/utils";

type TabVariant = "segmented" | "dock" | "underline" | "pill" | "settings" | "sheets";
type TabOption<T extends string = string> = { value: T; label: ReactNode;
    onClose?: () => void; closeLabel?: string };
type TabListProps<T extends string> = { value: T; onValueChange: (value: T) => void;
    options: readonly TabOption<T>[]; ariaLabel: string; variant?: TabVariant;
    actions?: ReactNode; className?: string; panelId?: string };
type TabsProps<T extends string> = { value: T; onValueChange: (value: T) => void;
    options: readonly TabOption<T>[]; ariaLabel: string; children: ReactNode;
    variant?: TabVariant; actions?: ReactNode; className?: string; railClassName?: string };

const railClass: Record<TabVariant, string> = {
    segmented: "",
    dock: "min-h-12 border-b border-gray-200 px-2 py-1.5",
    underline: "border-b border-gray-200",
    pill: "",
    settings: "sticky top-0 z-10 border-b border-gray-200 bg-white pb-2",
    sheets: "h-9 border-t border-gray-300 bg-gray-100",
};
const listClass: Record<TabVariant, string> = {
    segmented: "gap-1 rounded-lg bg-gray-100 p-1",
    dock: "gap-0.5",
    underline: "gap-0.5 sm:gap-1.5",
    pill: "w-full flex-wrap items-center gap-1 py-0.5 sm:w-auto sm:gap-2",
    settings: "grid flex-1 grid-cols-3 gap-1 sm:grid-cols-5",
    sheets: "h-full items-stretch",
};
const tabClass: Record<TabVariant, string> = {
    segmented: "h-8 shrink-0 rounded-md px-1 text-sm font-medium sm:px-3",
    dock: "h-9 max-w-40 shrink-0 rounded-md px-1.5 text-[13px] font-semibold sm:text-sm",
    underline: "min-h-10 border-b-2 px-2 text-sm font-medium sm:px-3",
    pill: "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm font-medium sm:px-4",
    settings: "min-h-10 min-w-0 rounded-md border px-2 text-sm font-medium",
    sheets: "h-full shrink-0 border-r border-gray-300 px-4 text-xs font-medium",
};
const selectedClass: Record<TabVariant, string> = {
    segmented: "bg-white text-gray-900 shadow-sm",
    dock: "bg-gray-900 text-white",
    underline: "border-gray-900 text-gray-900",
    pill: "border-gray-900 bg-gray-900 text-white",
    settings: "border-gray-900 bg-gray-900 text-white",
    sheets: "bg-white text-gray-900",
};
const idleClass: Record<TabVariant, string> = {
    segmented: "text-gray-600 hover:bg-white/70 hover:text-gray-900",
    dock: "text-gray-600 hover:bg-white/70 hover:text-gray-900",
    underline: "border-transparent text-gray-600 hover:text-gray-900",
    pill: "border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900",
    settings: "border-transparent text-gray-500 hover:bg-gray-50 hover:text-gray-900",
    sheets: "text-gray-600 hover:bg-gray-50",
};

export function TabList<T extends string>({ value, onValueChange, options,
    ariaLabel, variant = "segmented", actions, className, panelId }: TabListProps<T>) {
    const generatedId = useId();
    const listId = panelId ?? generatedId;
    const listRef = useRef<HTMLDivElement>(null);
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const active = Math.max(0, options.findIndex((option) => option.value === value));
    useEffect(() => {
        const list = listRef.current;
        const tab = refs.current[active];
        if (!list || !tab || list.scrollWidth <= list.clientWidth + 1) return;
        const rail = list.getBoundingClientRect();
        const item = tab.getBoundingClientRect();
        if (item.left < rail.left) list.scrollLeft -= rail.left - item.left;
        else if (item.right > rail.right) list.scrollLeft += item.right - rail.right;
    }, [active]);
    function move(index: number, key: string) {
        if (!options.length) return;
        const next = key === "Home" ? 0 : key === "End" ? options.length - 1
            : (index + (key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
        onValueChange(options[next].value);
        refs.current[next]?.focus({ preventScroll: true });
    }
    return <div data-tabs-rail className={cn("flex min-w-0 shrink-0 items-center",
        actions && "gap-2", railClass[variant], className)}>
            {!!options.length && <div ref={listRef} role="tablist" aria-label={ariaLabel}
                className={cn("tab-list flex min-w-0 overflow-x-auto",
                    variant === "segmented" ? "max-w-full" : "flex-1",
                    listClass[variant])}>
                {options.map((option, index) => <div key={option.value}
                    className="relative shrink-0"><button type="button"
                    ref={(node) => { refs.current[index] = node; }}
                    id={`${listId}-tab-${index}`} role="tab"
                    aria-selected={index === active} aria-controls={panelId}
                    tabIndex={index === active ? 0 : -1}
                    onClick={() => onValueChange(option.value)}
                    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                            event.preventDefault(); move(index, event.key);
                        }
                    }}
                    className={cn(tabClass[variant],
                        option.onClose && "pe-7",
                        "truncate text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900",
                        index === active ? selectedClass[variant] : idleClass[variant])}
                >{option.label}</button>{option.onClose && <button type="button"
                    onClick={(event) => { event.stopPropagation(); option.onClose?.(); }}
                    aria-label={option.closeLabel ?? `Close ${String(option.label)}`}
                    className="absolute end-1 top-1 grid size-6 place-items-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
                    <X className="size-3" aria-hidden="true" />
                </button>}</div>)}
            </div>}
            {actions && <div data-tabs-actions
                className={cn("flex shrink-0 items-center", variant === "pill" ? "gap-2" : "gap-1.5",
                    (variant === "pill" || !options.length) && "ms-auto")}>{actions}</div>}
        </div>;
}

export function Tabs<T extends string>({ value, onValueChange, options, ariaLabel, children,
    variant = "segmented", actions, className, railClassName }: TabsProps<T>) {
    const id = useId();
    const active = Math.max(0, options.findIndex((option) => option.value === value));
    const panelId = `${id}-panel`;
    return <div className={cn("flex min-h-0 flex-col", className)}>
        <TabList {...{ value, onValueChange, options, ariaLabel, variant, actions,
            panelId }} className={railClassName} />
        <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-tab-${active}`}
            className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>;
}
