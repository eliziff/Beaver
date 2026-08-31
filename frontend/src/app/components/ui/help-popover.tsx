import { useId, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "@/app/lib/utils";

export function HelpPopover({ label, children, className }: {
    label: string; children: ReactNode; className?: string;
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return <span className={cn("relative inline-flex", className)}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
        <button type="button" aria-label={label} aria-expanded={open}
            aria-describedby={open ? id : undefined}
            aria-controls={id} onClick={() => setOpen(true)}
            onFocus={() => setOpen(true)} onBlur={(event) => {
                if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setOpen(false);
            }} onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
            }} className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            <CircleHelp aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        {open && <span id={id} role="tooltip"
            className="absolute -left-12 top-7 z-[180] w-[min(18rem,calc(100vw-2rem))] rounded-md border border-gray-200 bg-white p-3 text-left text-xs font-normal leading-5 text-gray-700 shadow-lg sm:left-auto sm:right-0">
            {children}
        </span>}
    </span>;
}
