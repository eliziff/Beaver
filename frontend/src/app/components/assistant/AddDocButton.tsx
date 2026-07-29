"use client";
import { PlusIcon } from "lucide-react";
interface Props {
    onBrowseAll: () => void;
    selectedDocIds?: string[];
}
export function AddDocButton({
    onBrowseAll,
    selectedDocIds = [],
}: Props) {
    const count = selectedDocIds.length;
    const label = count ? `${count} documents selected` : "Add document";
    return (
        <button
            type="button"
            onClick={onBrowseAll}
            className={`flex items-center gap-1 px-2 h-8 rounded-lg text-sm cursor-pointer ${
                count > 0
                    ? "text-gray-700 hover:text-gray-900"
                    : "text-gray-400 hover:text-gray-700"
            }`}
            title={label}
            aria-label={label}
        >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-medium tabular-nums">
                {count > 0 ? (
                    count > 99 ? "99+" : count
                ) : (
                    <PlusIcon className="h-4 w-4" />
                )}
            </span>
            <span className="chat-input-control-label hidden sm:inline">
                Documents
            </span>
        </button>
    );
}
