"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { cn } from "@/app/lib/utils";

export type AssistantDockTab = {
    id: string;
    label: string;
    content: ReactNode;
};

export function AssistantDock({
    tabs,
    activeTabId,
    onActivateTab,
    expanded,
    onExpandedChange,
    inspectorContent,
    inspectorOpen = false,
    onCloseInspector,
}: {
    tabs: AssistantDockTab[];
    activeTabId: string;
    onActivateTab: (id: string) => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    inspectorContent?: ReactNode;
    inspectorOpen?: boolean;
    onCloseInspector?: () => void;
}) {
    const [width, setWidth] = useState(560);
    const resizeStart = useRef<{ x: number; width: number } | null>(null);
    const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

    useEffect(() => {
        const resize = (event: PointerEvent) => {
            if (!resizeStart.current) return;
            setWidth(
                Math.max(
                    360,
                    Math.min(
                        window.innerWidth - 48,
                        resizeStart.current.width + resizeStart.current.x - event.clientX,
                    ),
                ),
            );
        };
        const stop = () => {
            resizeStart.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", resize);
        window.addEventListener("pointerup", stop);
        return () => {
            window.removeEventListener("pointermove", resize);
            window.removeEventListener("pointerup", stop);
            stop();
        };
    }, []);

    if (!active) return null;
    if (!expanded) {
        return (
            <aside
                aria-label="Assistant dock"
                className="relative z-40 my-3 ms-3 me-3 hidden h-[calc(100dvh-1.5rem)] w-12 shrink-0 justify-center pt-2 md:flex"
            >
                <button
                    type="button"
                    onClick={() => onExpandedChange(true)}
                    className="grid size-9 place-items-center rounded-md border border-gray-300 bg-app-surface text-gray-500 shadow-sm hover:bg-app-surface-hover hover:text-gray-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                    aria-label="Expand assistant dock"
                >
                    <PanelRightOpen className="size-4" aria-hidden="true" />
                </button>
            </aside>
        );
    }
    const showingInspector = active.id !== "sources" && inspectorOpen;
    const moveTabFocus = (current: number, offset: number) => {
        const next = (current + offset + tabs.length) % tabs.length;
        onActivateTab(tabs[next].id);
        document.getElementById(`assistant-dock-tab-${tabs[next].id}`)?.focus();
    };

    return (
        <aside
            aria-label="Assistant dock"
            className={cn(
                "z-40 flex min-h-0 flex-col overflow-hidden border border-gray-300 bg-app-surface shadow-lg",
                "relative h-full w-1/2 shrink-0",
                "md:my-3 md:me-3 md:h-[calc(100dvh-1.5rem)] md:w-[min(var(--assistant-dock-width),50%)] md:rounded-2xl",
            )}
            style={{ "--assistant-dock-width": `${width}px` } as CSSProperties}
        >
            <div
                role="separator"
                aria-label="Resize assistant dock"
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={(event) => {
                    resizeStart.current = { x: event.clientX, width };
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                }}
                onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    setWidth((current) =>
                        Math.max(
                            360,
                            Math.min(
                                window.innerWidth - 48,
                                current + (event.key === "ArrowLeft" ? 24 : -24),
                            ),
                        ),
                    );
                }}
                className="absolute inset-y-0 start-0 z-20 hidden w-1 cursor-col-resize bg-transparent hover:bg-gray-300 focus-visible:bg-gray-400 focus-visible:outline-none md:block"
            />
            <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-1.5">
                <div
                    role="tablist"
                    aria-label="Assistant panels"
                    className="grid min-w-0 flex-1 grid-flow-col auto-cols-fr gap-1 overflow-hidden"
                >
                    {tabs.map((tab, index) => {
                        const selected = tab.id === active.id;
                        return (
                            <button
                                key={tab.id}
                                id={`assistant-dock-tab-${tab.id}`}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={`assistant-dock-panel-${tab.id}`}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => onActivateTab(tab.id)}
                                onKeyDown={(event) => {
                                    if (event.key === "ArrowRight") moveTabFocus(index, 1);
                                    else if (event.key === "ArrowLeft") moveTabFocus(index, -1);
                                    else if (event.key === "Home") moveTabFocus(index, -index);
                                    else if (event.key === "End") moveTabFocus(index, tabs.length - index - 1);
                                    else return;
                                    event.preventDefault();
                                }}
                                className={cn(
                                    "h-9 min-w-0 truncate rounded-md px-2 py-1.5 text-center text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-current",
                                    selected
                                        ? "bg-gray-900 text-white"
                                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-950",
                                )}
                            >
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
                <div className="flex shrink-0 items-center gap-1 pe-1">
                    <button
                        type="button"
                        onClick={() => onExpandedChange(false)}
                        className="grid size-9 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                        aria-label="Collapse assistant dock"
                    >
                        <PanelRightClose className="size-4" aria-hidden="true" />
                    </button>
                </div>
            </header>
            <div
                className={cn(
                    "relative min-h-0 flex-1 overflow-hidden",
                    showingInspector &&
                        "grid grid-rows-[minmax(0,2fr)_minmax(0,3fr)]",
                )}
            >
                <div
                    className={cn(
                        "relative min-h-0 overflow-hidden",
                        showingInspector ? "" : "absolute inset-0",
                    )}
                >
                    {tabs.map((tab) => (
                        <div
                            key={tab.id}
                            id={`assistant-dock-panel-${tab.id}`}
                            role="tabpanel"
                            aria-labelledby={`assistant-dock-tab-${tab.id}`}
                            aria-hidden={tab.id !== active.id}
                            className={cn(
                                "absolute inset-0 flex flex-col overflow-hidden",
                                tab.id !== active.id && "invisible pointer-events-none",
                            )}
                        >
                            {tab.content}
                        </div>
                    ))}
                </div>
                {showingInspector && <div
                    id="assistant-dock-source-inspector"
                    role="tabpanel"
                    aria-labelledby="assistant-dock-tab-sources"
                    className="flex min-h-0 flex-col overflow-hidden border-t border-gray-300"
                >
                    <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 bg-gray-50 ps-3 pe-2">
                        <span className="text-xs font-medium text-gray-600">Sources</span>
                        <button
                            type="button"
                            onClick={onCloseInspector}
                            aria-label="Close sources"
                            className="grid size-8 place-items-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                        >
                            <X className="size-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{inspectorContent}</div>
                </div>}
            </div>
        </aside>
    );
}
