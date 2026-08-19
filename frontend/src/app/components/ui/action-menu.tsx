import {
    type KeyboardEvent,
    type ReactNode,
    useEffect,
    useId,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/app/lib/utils";

export type ActionMenuItem = {
    label: string;
    onSelect: () => void;
    disabled?: boolean;
};

export function ActionMenu({
    label,
    items,
    children,
    className,
    triggerClassName,
}: {
    label: string;
    items: ActionMenuItem[];
    children: ReactNode;
    className?: string;
    triggerClassName?: string;
}) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ top: 0, right: 8 });
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuId = useId();

    function close(restoreFocus = false) {
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus();
    }

    function show() {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const estimatedHeight = items.length * 40 + 16;
        setPosition({
            top: rect.bottom + estimatedHeight <= window.innerHeight
                ? rect.bottom + 4
                : Math.max(8, rect.top - estimatedHeight - 4),
            right: Math.max(8, window.innerWidth - rect.right),
        });
        setOpen(true);
    }

    useEffect(() => {
        if (!open) return;
        menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        const dismiss = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node) &&
                !triggerRef.current?.contains(event.target as Node)) close();
        };
        const closeOnViewportChange = () => close();
        document.addEventListener("pointerdown", dismiss);
        window.addEventListener("resize", closeOnViewportChange);
        window.addEventListener("scroll", closeOnViewportChange, true);
        return () => {
            document.removeEventListener("pointerdown", dismiss);
            window.removeEventListener("resize", closeOnViewportChange);
            window.removeEventListener("scroll", closeOnViewportChange, true);
        };
    }, [open]);

    function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === "Escape") {
            event.preventDefault();
            close(true);
            return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
        ) ?? []);
        if (!enabled.length) return;
        const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0
            : event.key === "End" ? enabled.length - 1
            : event.key === "ArrowUp"
                ? (current - 1 + enabled.length) % enabled.length
                : (current + 1) % enabled.length;
        enabled[next]?.focus();
    }

    return (
        <span className={cn("relative inline-flex shrink-0", className)}>
            <button
                ref={triggerRef}
                type="button"
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                disabled={items.every((item) => item.disabled)}
                className={cn(
                    "inline-flex shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500 disabled:cursor-default",
                    triggerClassName,
                )}
                onClick={(event) => {
                    event.stopPropagation();
                    if (open) close(true);
                    else show();
                }}
            >
                {children}
            </button>
            {open && createPortal(
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label={label}
                    onKeyDown={handleMenuKeyDown}
                    className="fixed z-[260] min-w-44 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg"
                    style={position}
                >
                    {items.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            disabled={item.disabled}
                            onClick={(event) => {
                                event.stopPropagation();
                                close(true);
                                item.onSelect();
                            }}
                            className="flex min-h-9 w-full items-center rounded-md px-3 text-left text-sm text-gray-800 hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:outline-none disabled:cursor-default disabled:text-gray-400"
                        >
                            {item.label}
                        </button>
                    ))}
                </div>,
                document.body,
            )}
        </span>
    );
}
