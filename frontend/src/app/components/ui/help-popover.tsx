import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "@/app/lib/utils";

export function HelpPopover({ label, children, className }: {
    label: string; children: ReactNode; className?: string;
}) {
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const tooltip = useRef<HTMLSpanElement>(null);
    const id = useId();
    useLayoutEffect(() => {
        const trigger = button.current, popup = tooltip.current;
        if (!open || !trigger || !popup) return;
        if (popup.showPopover) popup.showPopover(); else popup.removeAttribute("popover");
        const place = () => {
            const anchor = trigger.getBoundingClientRect(), box = popup.getBoundingClientRect();
            const maxLeft = Math.max(8, innerWidth - box.width - 8);
            popup.style.left = `${Math.min(maxLeft, Math.max(8, anchor.right - box.width))}px`;
            popup.style.top = `${anchor.bottom + box.height + 14 <= innerHeight
                ? anchor.bottom + 6 : Math.max(8, anchor.top - box.height - 6)}px`;
        };
        place(); addEventListener("resize", place); addEventListener("scroll", place, true);
        return () => {
            removeEventListener("resize", place); removeEventListener("scroll", place, true);
            popup.hidePopover?.();
        };
    }, [open]);
    return <span className={cn("inline-flex", className)}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
        <button ref={button} type="button" aria-label={label} aria-expanded={open}
            aria-describedby={open ? id : undefined}
            aria-controls={id} onClick={() => setOpen(true)}
            onFocus={() => setOpen(true)} onBlur={(event) => {
                if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setOpen(false);
            }} onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
            }} className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            <CircleHelp aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        {open && <span ref={tooltip} id={id} role="tooltip" popover="manual"
            className="fixed inset-auto m-0 max-h-[calc(100dvh-1rem)] w-[min(18rem,calc(100vw-1rem))] overflow-auto rounded-md border border-gray-200 bg-white p-3 text-left text-xs font-normal leading-5 text-gray-700 shadow-lg">
            {children}
        </span>}
    </span>;
}
