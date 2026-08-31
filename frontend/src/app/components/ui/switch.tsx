import { Loader2 } from "lucide-react";
import { cn } from "@/app/lib/utils";

const sizes = {
    sm: ["h-4 w-7 p-0.5", "size-3", "translate-x-3"],
    md: ["h-5 w-9 p-0.5", "size-4", "translate-x-4"],
    lg: ["h-6 w-10 p-1", "size-4", "translate-x-4"],
} as const;

export function Switch({ checked, disabled, loading, onChange, size = "sm",
    tone = "green", label, ariaLabel, className }: {
    checked: boolean; disabled?: boolean; loading?: boolean;
    onChange: (checked: boolean) => void; size?: keyof typeof sizes;
    tone?: "green" | "dark" | "dock"; label?: string; ariaLabel?: string; className?: string;
}) {
    const [track, thumb, shift] = sizes[size];
    const control = <span className="relative inline-flex shrink-0">
        <input type="checkbox" role="switch" checked={checked}
            aria-label={ariaLabel ?? label} disabled={disabled || loading}
            onChange={(event) => onChange(event.currentTarget.checked)}
            className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
        <span aria-hidden="true" className={cn(
            "pointer-events-none rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gray-900 peer-disabled:opacity-40",
            checked ? tone === "green" ? "bg-emerald-600" : "bg-gray-900"
                : tone === "dark" ? "bg-gray-100" : tone === "dock" ? "bg-gray-300" : "bg-gray-200", track,
        )}>
            <span className={cn("flex items-center justify-center rounded-full bg-white transition-transform", thumb, checked && shift)}>
                {loading && <Loader2 className="size-2.5 animate-spin text-gray-400" />}
            </span>
        </span>
    </span>;
    return label ? <label className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
        checked ? "text-emerald-700" : "text-gray-500", className,
    )}>{label}{control}</label> : control;
}
