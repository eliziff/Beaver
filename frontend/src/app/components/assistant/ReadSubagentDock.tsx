"use client";

import { LoaderCircle, X } from "lucide-react";
import type { AssistantEvent } from "../shared/types";
import { GfmMarkdown } from "./message/MarkdownContent";

export type ReadSubagentPanel = Extract<
    AssistantEvent,
    { type: "subagent_run" }
>;

export function ReadSubagentDock({
    panels,
    onClose,
}: {
    panels: ReadSubagentPanel[];
    onClose: (id: string) => void;
}) {
    if (!panels.length) return null;
    return (
        <aside
            className="hidden h-full w-72 shrink-0 flex-col gap-2 py-3 pe-3 2xl:flex"
            aria-label="Reading agent panels"
        >
            {panels.map((panel) => {
                return (
                    <section
                        key={panel.id}
                        aria-labelledby={`subagent-panel-${panel.id}`}
                        className="flex min-h-0 max-h-64 flex-1 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm"
                    >
                        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-gray-200 px-3">
                            <div className="min-w-0 flex-1">
                                <h2
                                    id={`subagent-panel-${panel.id}`}
                                    className="truncate text-sm font-medium text-gray-900"
                                >
                                    Reading agent
                                </h2>
                                <p className="truncate text-xs text-gray-500">
                                    {panel.model} · {panel.effort} reasoning
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => onClose(panel.id)}
                                className="grid size-10 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                                aria-label="Close reading-agent panel"
                            >
                                <X className="size-4" />
                            </button>
                        </header>
                        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                            <p className="mb-2 line-clamp-2 text-xs leading-5 text-gray-500">
                                {panel.task}
                            </p>
                            {panel.grounding?.status === "passed" && (
                                <p className="mb-2 text-xs font-medium text-gray-700">
                                    {panel.grounding.evidence.length} verified{" "}
                                    {panel.grounding.evidence.length === 1
                                        ? "passage"
                                        : "passages"}
                                </p>
                            )}
                            {panel.status === "running" ? (
                                <div
                                    role="status"
                                    className="flex min-h-16 items-center gap-2 text-sm text-gray-600"
                                >
                                    <LoaderCircle
                                        className="size-4 animate-spin"
                                        aria-hidden="true"
                                    />
                                    Reading sources…
                                </div>
                            ) : panel.output ? (
                                <div className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere]">
                                    <GfmMarkdown>{panel.output}</GfmMarkdown>
                                </div>
                            ) : (
                                <p className="text-sm text-red-600">
                                    {panel.error ?? "Reading agent failed."}
                                </p>
                            )}
                        </div>
                    </section>
                );
            })}
        </aside>
    );
}
