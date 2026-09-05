import { SearchableChoiceModal } from "./ModalSelect";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { COURT_JURISDICTIONS } from "@/app/lib/courtRegistry";

export type JurisdictionOption = {
    value: string; label: string; preferenceKey?: string; disabled?: boolean;
};

export function courtJurisdictionOptions(availableValues: Iterable<string>) {
    const available = new Set(availableValues);
    return COURT_JURISDICTIONS.filter(({ id }) => available.has(id)).map(({ id, label, preferenceKey }) => ({
        value: id, label, preferenceKey,
    }));
}

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
    const ranked = options.filter((option) => !option.disabled).map((option, index) => ({ option, index,
        rank: preferredKeys.indexOf(option.preferenceKey ?? option.value) }));
    ranked.sort((left, right) => {
        if (left.rank >= 0 || right.rank >= 0) {
            return (left.rank < 0 ? Infinity : left.rank) -
                (right.rank < 0 ? Infinity : right.rank) || left.index - right.index;
        }
        return options.length > 8 ? left.option.label.localeCompare(right.option.label) : left.index - right.index;
    });

    return <SearchableChoiceModal open={open} value={value} options={ranked.map(({ option }) => option)}
        title={title} searchLabel="Search jurisdictions"
        searchable={searchable ?? true} onClose={onClose} size="lg"
        className="!h-fit max-h-[calc(100dvh-2rem)]"
        onChange={(next) => next !== null && onChange(next)}
        listClassName="[&>button[aria-pressed=true]]:bg-gray-100" />;
}

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
