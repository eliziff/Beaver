import { SearchableChoiceModal } from "./ModalSelect";
import type { ReactNode } from "react";

export type JurisdictionOption = { value: string; label: string; preferenceKey?: string };

export function JurisdictionModal({ open, value, options, preferredKeys = [],
    title = "Choose jurisdiction", searchable, onChange, onClose }: {
    open: boolean;
    value: string | null;
    options: readonly JurisdictionOption[];
    preferredKeys?: readonly string[];
    title?: string;
    searchable?: boolean;
    onChange: (value: string) => void;
    onClose: () => void;
}) {
    const grouped = options.length > 8;
    const ranked = options.map((option, index) => ({ option, index,
        rank: preferredKeys.indexOf(option.preferenceKey ?? option.value) }));
    ranked.sort((left, right) => {
        if (left.rank >= 0 || right.rank >= 0) {
            return (left.rank < 0 ? Infinity : left.rank) -
                (right.rank < 0 ? Infinity : right.rank) || left.index - right.index;
        }
        return grouped ? left.option.label.localeCompare(right.option.label) ||
            left.index - right.index : left.index - right.index;
    });
    const choices = ranked.map(({ option, rank }) => ({ ...option,
        ...(grouped && { group: rank >= 0 ? "Your jurisdictions" : "All jurisdictions" }) }));

    return <SearchableChoiceModal open={open} value={value} options={choices}
        title={title} searchLabel="Search jurisdictions" size="2xl"
        searchable={searchable ?? grouped} onClose={onClose}
        onChange={(next) => next !== null && onChange(next)}
        listClassName="grid content-start gap-1 sm:grid-cols-2 [&>div]:col-span-full" />;
}

export function ChoiceModalButton({ icon, label, value, disabled, onClick, className = "" }: {
    icon: ReactNode; label: string; value: string; disabled?: boolean;
    onClick: () => void; className?: string;
}) {
    return <button type="button" aria-label={`${label}: ${value}`} disabled={disabled}
        onClick={onClick} className={`inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg border border-gray-300 bg-white px-3 text-left shadow-sm outline-none hover:border-gray-400 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
        {icon}<span className="min-w-0"><span className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</span>
        <span className="block max-w-64 truncate text-sm font-medium text-gray-950">{value}</span></span>
    </button>;
}
