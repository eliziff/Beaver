"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, CircleStop, LoaderCircle, X } from "lucide-react";
import type { AssistantActivity, AssistantReaderRun } from "@/app/lib/assistantSession";
import { ActivityRow } from "./message/EventBlocks";
import { CitationPillMarkdown } from "./message/MarkdownContent";

export type ReadSubagentPanel = AssistantReaderRun;
export type ReadSubagentSource = NonNullable<AssistantActivity["source"]>;

export function ReadSubagentDock({
    panels,
    onClose,
    onSourceClick,
    idPrefix = "reading-agent",
    embedded = false,
}: {
    panels: ReadSubagentPanel[];
    onClose: (id: string) => void;
    onSourceClick?: (source: ReadSubagentSource) => void;
    idPrefix?: string;
    embedded?: boolean;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    useLayoutEffect(() => {
        const body = bodyRef.current;
        if ((!embedded && collapsed) || !body) return;
        const keepPinned = () => {
            if (pinned.current) body.scrollTop = body.scrollHeight;
        };
        keepPinned();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(keepPinned);
        observer.observe(body);
        return () => observer.disconnect();
    }, [collapsed, embedded, panels]);
    if (!panels.length) return null;

    const rounds = new Map<string, number>();
    return (
        <section
            aria-labelledby={`${idPrefix}-title`}
            className={embedded
                ? "flex h-full min-h-0 flex-col overflow-hidden bg-white"
                : `flex shrink-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm ${collapsed ? "h-11" : "h-[32rem]"}`}
        >
            {!embedded ? (
                <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-gray-200 ps-1 pe-2">
                    <button
                        type="button"
                        aria-expanded={!collapsed}
                        aria-controls={`${idPrefix}-body`}
                        onClick={() => setCollapsed((value) => !value)}
                        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                    >
                        <ChevronDown aria-hidden="true" className={`size-3.5 shrink-0 text-gray-500 ${collapsed ? "-rotate-90" : ""}`} />
                        <h2 id={`${idPrefix}-title`} className="truncate text-sm font-medium text-gray-900">Reading agents</h2>
                    </button>
                    <button type="button" onClick={() => panels.forEach(({ id }) => onClose(id))} aria-label="Close reading agents" className="grid size-10 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                        <X className="size-4" />
                    </button>
                </header>
            ) : <h2 id={`${idPrefix}-title`} className="sr-only">Reading agent</h2>}
            <div
                id={`${idPrefix}-body`}
                ref={bodyRef}
                hidden={!embedded && collapsed}
                className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
                onScroll={({ currentTarget }) => {
                    pinned.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight <= 4;
                }}
            >
                <div className="space-y-4">
                    {panels.map((panel, index) => {
                        const slot = panel.id.match(/:(\d+)$/u)?.[1] ?? String(index + 1);
                        const round = (rounds.get(slot) ?? 0) + 1;
                        rounds.set(slot, round);
                        return (
                            <section key={panel.id} aria-label={`Agent ${slot}, round ${round}`}>
                                {round > 1 && <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-gray-500"><span>Round {round}</span><span className="h-px flex-1 bg-gray-200" aria-hidden="true" /></div>}
                                <div className="me-5 rounded-xl rounded-tl-sm bg-gray-900 px-3 py-2.5 text-xs leading-5 text-white">{panel.task}</div>
                                {panel.activities.length ? (
                                    <details className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5">
                                        <summary className="cursor-pointer text-xs font-medium text-gray-600">
                                            <span className="inline-flex items-center gap-1.5">
                                                {panel.activities.length} tool {panel.activities.length === 1 ? "call" : "calls"}
                                                {panel.status === "running" && <LoaderCircle className="size-3 motion-safe:animate-spin" aria-label="Working" />}
                                            </span>
                                        </summary>
                                        <div role="list" aria-label="Reading activity" className="mt-2 space-y-1.5">
                                            {panel.activities.map((activity) => <ActivityRow key={activity.id} activity={activity} onSourceClick={onSourceClick} />)}
                                            {panel.status === "running" && !panel.activities.some(({ status }) => status === "running") && <div role="status" className="flex items-center gap-2 text-xs text-gray-600"><LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />Thinking</div>}
                                        </div>
                                    </details>
                                ) : panel.status === "running" ? (
                                    <div role="status" className="mt-2 flex min-h-8 items-center gap-2 text-xs text-gray-600"><LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />Starting…</div>
                                ) : panel.status === "interrupted" ? (
                                    <div role="status" className="mt-2 flex min-h-8 items-center gap-2 text-xs text-gray-500"><CircleStop className="size-3.5" aria-hidden="true" />Interrupted</div>
                                ) : null}
                                {panel.output ? (
                                    <details open className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs leading-5 text-gray-700">
                                        <summary className="cursor-pointer font-medium text-gray-600">Final output{panel.sources.length ? ` · ${panel.sources.length} verified ${panel.sources.length === 1 ? "passage" : "passages"}` : ""}</summary>
                                        <div aria-label="Agent final output" className="prose prose-sm mt-2 max-w-none break-words text-xs leading-5 text-gray-700 [overflow-wrap:anywhere] [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_li]:text-xs [&_p]:text-xs">
                                            <CitationPillMarkdown text={panel.output} sources={panel.sources} onSourceClick={onSourceClick} />
                                        </div>
                                    </details>
                                ) : panel.status === "error" ? <p className="ms-5 mt-2 rounded-xl rounded-br-sm bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">Reading agent failed.</p> : null}
                            </section>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
