"use client";

import { X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
    ReadSubagentDock,
    type ReadSubagentPanel,
    type ReadSubagentSource,
} from "./ReadSubagentDock";

export type ReadSubagentGroup = {
    id: string;
    label: string;
    panels: ReadSubagentPanel[];
};

export function ReadSubagentTabs({
    groups,
    activeId,
    onActivate,
    onClose,
    onSourceClick,
}: {
    groups: ReadSubagentGroup[];
    activeId: string | null;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
    onSourceClick: (source: ReadSubagentSource) => void;
}) {
    const active = groups.find((group) => group.id === activeId) ?? groups[0];
    if (!active) {
        return (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-gray-500">
                Reading-agent runs will appear here.
            </div>
        );
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div
                role="tablist"
                aria-label="Reading agents"
                className="grid shrink-0 grid-flow-col auto-cols-fr gap-1 overflow-hidden border-b border-gray-200 bg-gray-50 px-3 py-2"
            >
                {groups.map((group, index) => {
                    const selected = group.id === active.id;
                    const done = group.panels.every(
                        (panel) => panel.status === "completed",
                    );
                    return (
                        <div
                            key={group.id}
                            className={cn(
                                "flex h-8 min-w-0 items-center overflow-hidden rounded-md border",
                                selected
                                    ? "border-gray-300 bg-white text-gray-900 shadow-sm"
                                    : "border-transparent text-gray-500 hover:bg-white hover:text-gray-800",
                            )}
                        >
                            <button
                                type="button"
                                role="tab"
                                id={`reading-agent-tab-${group.id}`}
                                aria-controls={`reading-agent-panel-${group.id}`}
                                aria-selected={selected}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => onActivate(group.id)}
                                onKeyDown={(event) => {
                                    const offset =
                                        event.key === "ArrowRight"
                                            ? 1
                                            : event.key === "ArrowLeft"
                                              ? -1
                                              : null;
                                    if (offset === null) return;
                                    event.preventDefault();
                                    const next = groups[(index + offset + groups.length) % groups.length];
                                    onActivate(next.id);
                                    document.getElementById(`reading-agent-tab-${next.id}`)?.focus();
                                }}
                                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900"
                            >
                                <span className="min-w-0 flex-1 truncate">
                                    {group.label}
                                </span>
                                {done && (
                                    <span
                                        className="size-1.5 shrink-0 rounded-full bg-gray-400"
                                        title="Done"
                                    >
                                        <span className="sr-only">Done</span>
                                    </span>
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => onClose(group.id)}
                                aria-label={`Close ${group.label}`}
                                className="me-1 grid size-6 shrink-0 place-items-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900"
                            >
                                <X className="size-3" aria-hidden="true" />
                            </button>
                        </div>
                    );
                })}
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden">
                {groups.map((group) => (
                    <div
                        key={group.id}
                        role="tabpanel"
                        id={`reading-agent-panel-${group.id}`}
                        aria-labelledby={`reading-agent-tab-${group.id}`}
                        aria-hidden={group.id !== active.id}
                        className={cn(
                            "absolute inset-0 overflow-hidden",
                            group.id !== active.id && "invisible pointer-events-none",
                        )}
                    >
                        <ReadSubagentDock
                            idPrefix={`reading-agent-${group.id}`}
                            panels={group.panels}
                            onClose={() => onClose(group.id)}
                            onSourceClick={onSourceClick}
                            embedded
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
