import {
    type KeyboardEvent,
    type ReactNode,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/app/lib/utils";

const MODAL_BOUNDARY = 'dialog,[role="dialog"],[data-assistant-dock]';

export type ActionMenuItem = {
    label: string;
    icon?: ReactNode;
    onSelect: () => void;
    disabled?: boolean;
    checked?: boolean;
    keepOpen?: boolean;
};
export function ActionMenu({
    label,
    items,
    children,
    className,
    triggerClassName,
    onOpen,
}: {
    label: string;
    items: ActionMenuItem[];
    children: ReactNode;
    className?: string;
    triggerClassName?: string;
    onOpen?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuId = useId();

    function close(restoreFocus = false) {
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus();
    }

    useLayoutEffect(() => {
        const menu = menuRef.current;
        const trigger = triggerRef.current;
        if (!open || !menu || !trigger) return;
        if (typeof menu.showPopover === "function") try { menu.showPopover(); }
        catch { menu.removeAttribute("popover"); }
        else menu.removeAttribute("popover");
        const boundaryRect = trigger.closest<HTMLElement>(MODAL_BOUNDARY)?.getBoundingClientRect();
        const bounded = boundaryRect && boundaryRect.width > 0 && boundaryRect.height > 0;
        const leftEdge = Math.max(8, bounded ? boundaryRect.left + 8 : 8);
        const rightEdge = Math.min(window.innerWidth - 8, bounded ? boundaryRect.right - 8 : window.innerWidth - 8);
        const topEdge = Math.max(8, bounded ? boundaryRect.top + 8 : 8);
        const bottomEdge = Math.min(window.innerHeight - 8, bounded ? boundaryRect.bottom - 8 : window.innerHeight - 8);
        const rect = menu.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const maxHeight = bottomEdge - topEdge;
        const maxWidth = rightEdge - leftEdge;
        const height = Math.min(rect.height, maxHeight);
        const preferredTop = triggerRect.bottom + 4 + height <= bottomEdge
            ? triggerRect.bottom + 4
            : triggerRect.top - height - 4;
        Object.assign(menu.style, {
            top: `${Math.max(topEdge, Math.min(preferredTop, bottomEdge - height))}px`,
            left: `${Math.max(leftEdge, Math.min(triggerRect.left, rightEdge - Math.min(rect.width, maxWidth)))}px`,
            maxHeight: `${maxHeight}px`,
            maxWidth: `${maxWidth}px`,
        });
        return () => { try { menu.hidePopover?.(); } catch { /* Already closed. */ } };
    }, [open]);

    useEffect(() => {
        if (open && !menuRef.current?.contains(document.activeElement))
            menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    }, [open, items.filter((item) => !item.disabled).length]);

    useEffect(() => {
        if (!open) return;
        const dismiss = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node) &&
                !triggerRef.current?.contains(event.target as Node)) close();
        };
        const closeOnViewportChange = () => close();
        const closeOnOutsideScroll = (event: Event) => {
            if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close();
        };
        document.addEventListener("pointerdown", dismiss);
        window.addEventListener("resize", closeOnViewportChange);
        window.addEventListener("scroll", closeOnOutsideScroll, true);
        return () => {
            document.removeEventListener("pointerdown", dismiss);
            window.removeEventListener("resize", closeOnViewportChange);
            window.removeEventListener("scroll", closeOnOutsideScroll, true);
        };
    }, [open]);

    function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === "Tab") return close();
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
                disabled={!onOpen && items.every((item) => item.disabled)}
                className={cn(
                    "inline-flex shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-500 disabled:cursor-default",
                    triggerClassName,
                )}
                onClick={(event) => {
                    event.stopPropagation();
                    if (open) close(true);
                    else { onOpen?.(); setOpen(true); }
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
                    popover="manual"
                    data-shortcut-layer
                    data-shortcut-open="true"
                    onKeyDown={handleMenuKeyDown}
                    className="fixed inset-auto z-[220] m-0 max-h-[min(24rem,calc(100dvh-1rem))] min-w-44 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg"
                >
                    {items.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                            aria-checked={item.checked}
                            disabled={item.disabled}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (!item.keepOpen) close(true);
                                item.onSelect();
                            }}
                            className="flex min-h-9 w-full items-center rounded-md px-3 text-left text-sm text-gray-800 hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:outline-none disabled:cursor-default disabled:text-gray-400"
                        >
                            {item.checked !== undefined && <span className="me-2 w-3" aria-hidden="true">{item.checked ? "✓" : ""}</span>}
                            {item.icon && <span aria-hidden="true" className="me-2 flex shrink-0 items-center">{item.icon}</span>}
                            {item.label}
                        </button>
                    ))}
                </div>, triggerRef.current?.closest(MODAL_BOUNDARY) ?? document.body)}
        </span>
    );
}
