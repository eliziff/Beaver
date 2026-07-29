import { Loader2 } from "lucide-react";
import { cn } from "@/app/lib/utils";

const sizes = {
    sm: { track: "h-4 w-7", thumb: "size-3", shift: "translate-x-3" },
    md: { track: "h-5 w-9", thumb: "size-4", shift: "translate-x-4" },
};

export function AccountToggle({
    checked,
    disabled,
    loading,
    onChange,
    size = "sm",
    label,
    className,
}: {
    checked: boolean;
    disabled?: boolean;
    loading?: boolean;
    onChange: (checked: boolean) => void;
    size?: keyof typeof sizes;
    label?: string;
    className?: string;
}) {
    const style = sizes[size];
    const toggle = (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled || loading}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative shrink-0 rounded-full p-0.5 disabled:cursor-not-allowed disabled:opacity-40",
                checked ? "bg-emerald-600" : "bg-gray-200",
                style.track,
            )}
        >
            <span
                className={cn(
                    "flex items-center justify-center rounded-full bg-white",
                    style.thumb,
                    checked && style.shift,
                )}
            >
                {loading && (
                    <Loader2 className="size-2.5 animate-spin text-gray-400" />
                )}
            </span>
        </button>
    );
    return label ? (
        <label
            className={cn(
                "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
                checked ? "text-emerald-700" : "text-gray-500",
                className,
            )}
        >
            {label}
            {toggle}
        </label>
    ) : (
        toggle
    );
}
