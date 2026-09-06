import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function ChoiceModalButton({ icon, label, value, disabled, onClick, className = "" }: {
    icon: ReactNode; label: string; value: string; disabled?: boolean;
    onClick: () => void; className?: string;
}) {
    return <label className={`block min-w-0 text-sm font-medium text-gray-800 ${className}`}>
        {label}
        <button type="button" aria-label={`${label}: ${value}`} title={`${label}: ${value}`}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={onClick} className="mt-1 flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-left text-sm font-normal text-gray-900 outline-none hover:border-gray-500 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60">
        {icon}<span className="min-w-0 flex-1 truncate">{value}</span>
        <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
    </button></label>;
}
