"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";

export function PreResponseWrapper({
    children,
    isStreaming,
    compact = false,
    label,
}: {
    children?: React.ReactNode;
    isStreaming: boolean;
    compact?: boolean;
    label: string;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const canExpand = children !== undefined;
    const visibleLabel = isOpen ? "Activity" : label;

    const buttonTextClass = compact ? "text-xs" : "text-sm";
    const childrenGapClass = compact ? "gap-2.5" : "gap-4";
    const rowClass = `flex h-9 max-w-full items-center gap-2 rounded-md px-1 font-serif text-gray-600 ${buttonTextClass}`;
    const rowContent = (
        <>
            {isStreaming && (
                <span aria-hidden="true" className="shrink-0">
                    <ThinkingSpinner size={14} />
                </span>
            )}
            <span className="min-w-0 truncate">{visibleLabel}</span>
        </>
    );

    return (
        <div className="min-w-0">
            {canExpand ? (
                <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={visibleLabel}
                    onClick={() => setIsOpen((open) => !open)}
                    className={`${rowClass} hover:text-gray-900`}
                >
                    {rowContent}
                    <ChevronDown
                        size={12}
                        className={`shrink-0 ${isOpen ? "" : "-rotate-90"}`}
                    />
                </button>
            ) : (
                <div role="status" aria-label={label} className={rowClass}>
                    {rowContent}
                </div>
            )}
            {canExpand && isOpen && (
                <div
                    role="list"
                    className={`ml-2 mt-1 flex flex-col border-l border-gray-200 pb-1 pl-3 ${childrenGapClass}`}
                >
                    {children}
                </div>
            )}
        </div>
    );
}
