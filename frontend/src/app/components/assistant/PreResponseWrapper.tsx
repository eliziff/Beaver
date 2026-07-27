"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function PreResponseWrapper({
    children,
    stepCount,
    shouldMinimize,
    isStreaming,
    compact = false,
    forceOpen = false,
}: {
    children: React.ReactNode;
    stepCount: number;
    shouldMinimize: boolean;
    isStreaming: boolean;
    /** Tighter typography + child gap for narrow side panels (e.g. TR chat). */
    compact?: boolean;
    forceOpen?: boolean;
}) {
    const [userToggled, setUserToggled] = useState(false);
    const [isOpen, setIsOpen] = useState(!shouldMinimize);
    // Once content has streamed in (shouldMinimize=true even once), stay
    // minimized even if a later render briefly evaluates shouldMinimize=false.
    // Without this latch, the wrapper visibly pops open when isStreaming
    // flips off at the end of the response.
    const hasMinimizedRef = useRef(shouldMinimize);

    useEffect(() => {
        if (forceOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- streaming open/minimize latch (see comment above)
            setIsOpen(true);
            return;
        }
        if (shouldMinimize) hasMinimizedRef.current = true;
        if (userToggled) return;
        setIsOpen(!shouldMinimize && !hasMinimizedRef.current);
    }, [forceOpen, shouldMinimize, userToggled]);

    const stepWord = `step${stepCount === 1 ? "" : "s"}`;
    const label = isStreaming
        ? "Working"
        : `Completed in ${stepCount} ${stepWord}`;

    const buttonTextClass = compact ? "text-xs" : "text-sm";
    const childrenGapClass = compact ? "gap-2.5" : "gap-4";

    return (
        <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
            <button
                type="button"
                onClick={() => {
                    setUserToggled(true);
                    setIsOpen((v) => !v);
                }}
                className={`w-full flex items-center justify-between font-serif text-gray-500 hover:text-gray-700 transition-colors ${buttonTextClass}`}
            >
                <span className="flex items-baseline min-w-0">
                    <span className="truncate">{label}</span>
                    {isStreaming && (
                        <span className="inline-flex ml-1 shrink-0 items-baseline">
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400" />
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400" />
                            <span className="h-0.5 w-0.5 rounded-full bg-gray-400" />
                        </span>
                    )}
                </span>
                <ChevronDown
                    size={12}
                    className={`relative top-px shrink-0 ml-2 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                />
            </button>
            {isOpen && (
                <div className={`mt-3 flex flex-col ${childrenGapClass}`}>
                    {children}
                </div>
            )}
        </div>
    );
}
