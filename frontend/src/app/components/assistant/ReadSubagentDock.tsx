"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleStop, LoaderCircle, X } from "lucide-react";
import type { AssistantEvent } from "../shared/types";
import { CitationPillMarkdown } from "./message/MarkdownContent";

export type ReadSubagentPanel = Extract<
    AssistantEvent,
    { type: "subagent_run" }
>;
export type ReadSubagentSource = NonNullable<ReadSubagentPanel["sources"]>[number];

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
    const contentRef = useRef<HTMLDivElement>(null);
    const pinnedToBottom = useRef(true);
    useLayoutEffect(() => {
        const body = bodyRef.current;
        const content = contentRef.current;
        if ((!embedded && collapsed) || !body || !content) return;
        const keepBottomPinned = () => {
            if (pinnedToBottom.current) body.scrollTop = body.scrollHeight;
        };
        keepBottomPinned();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(keepBottomPinned);
        observer.observe(body);
        observer.observe(content);
        return () => observer.disconnect();
    }, [collapsed, embedded]);
    if (!panels.length) return null;

    const rounds = new Map<string, number>();
    const runs = panels.map((panel, index) => {
        const slot = panel.id.match(/:(\d+)$/u)?.[1] ?? String(index + 1);
        const round = (rounds.get(slot) ?? 0) + 1;
        rounds.set(slot, round);
        return { panel, slot, round };
    });

    return (
        <section
            aria-labelledby={`${idPrefix}-title`}
            className={
                embedded
                    ? "flex h-full min-h-0 flex-col overflow-hidden bg-white"
                    : `flex shrink-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm ${collapsed ? "h-11" : "h-[32rem]"}`
            }
        >
            {!embedded && <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-gray-200 ps-1 pe-2">
                <button
                    type="button"
                    aria-expanded={!collapsed}
                    aria-controls={`${idPrefix}-body`}
                    onClick={() => setCollapsed((current) => !current)}
                    className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                >
                    <ChevronDown
                        aria-hidden="true"
                        className={`size-3.5 shrink-0 text-gray-500 ${collapsed ? "-rotate-90" : ""}`}
                    />
                    <h2 id={`${idPrefix}-title`} className="truncate text-sm font-medium text-gray-900">
                        Reading agents
                    </h2>
                </button>
                <button
                    type="button"
                    onClick={() => panels.forEach((panel) => onClose(panel.id))}
                    className="grid size-10 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                    aria-label="Close reading agents"
                >
                    <X className="size-4" />
                </button>
            </header>}
            {embedded && <h2 id={`${idPrefix}-title`} className="sr-only">Reading agent</h2>}
            <div
                id={`${idPrefix}-body`}
                ref={bodyRef}
                className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
                onScroll={(event) => {
                    const body = event.currentTarget;
                    pinnedToBottom.current =
                        body.scrollHeight - body.scrollTop - body.clientHeight <= 4;
                }}
                hidden={!embedded && collapsed}
            >
                <div ref={contentRef} className="space-y-4">
                {runs.map(({ panel, slot, round }) => (
                    <section key={panel.id} aria-label={`Agent ${slot}, round ${round}`}>
                        {round > 1 && (
                            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-gray-500">
                                <span className="whitespace-nowrap">Round {round}</span>
                                <span className="h-px flex-1 bg-gray-200" aria-hidden="true" />
                            </div>
                        )}
                        <div className="me-5 rounded-xl rounded-tl-sm bg-gray-900 px-3 py-2.5 text-xs leading-5 text-white">
                            {panel.task}
                        </div>
                        {panel.activities?.length ? (
                            <details
                                className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5"
                            >
                                <summary className="cursor-pointer text-xs font-medium text-gray-600">
                                    <span className="inline-flex items-center gap-1.5">
                                        {panel.activities.length} tool {panel.activities.length === 1 ? "call" : "calls"}
                                        {panel.status === "running" && (
                                            <LoaderCircle
                                                className="size-3 motion-safe:animate-spin"
                                                aria-label="Working"
                                            />
                                        )}
                                    </span>
                                </summary>
                                <ol aria-label="Reading activity" className="mt-2 space-y-1.5">
                                    {panel.activities.map((activity) => {
                                        const paragraphs = activity.paragraphs ?? [];
                                        const shownParagraphs = paragraphs.slice(0, 3);
                                        const firstParagraph = paragraphs[0]?.match(/^\d+/u)?.[0];
                                        const paragraphSuffix = paragraphs.length > shownParagraphs.length
                                            ? ` + ${paragraphs.length - shownParagraphs.length} more`
                                            : "";
                                        return (
                                        <li
                                            key={activity.id}
                                            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-xs leading-5 text-gray-600"
                                        >
                                            {activity.status === "running" ? (
                                                <LoaderCircle className="mt-1 size-3 motion-safe:animate-spin" aria-label="Working" />
                                            ) : activity.status === "completed" ? (
                                                <Check className="mt-1 size-3 text-gray-500" aria-hidden="true" />
                                            ) : activity.status === "error" ? (
                                                <X className="mt-1 size-3 text-red-600" aria-hidden="true" />
                                            ) : (
                                                <CircleStop className="mt-1 size-3 text-gray-400" aria-hidden="true" />
                                            )}
                                            <span className="min-w-0">
                                                {activity.source && onSourceClick ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => onSourceClick({
                                                            ...activity.source!,
                                                            ...(firstParagraph && { locator: `par${firstParagraph}` }),
                                                        })}
                                                        className="flex w-full min-w-0 items-baseline text-left underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                                                        title={`${activity.source.name ? `${activity.source.name}, ` : ""}${activity.source.citation}`}
                                                    >
                                                        <span className="me-1 shrink-0">
                                                            {activity.status === "running" ? "Reading" : "Read"}
                                                        </span>
                                                        {activity.source.name && (
                                                            <em className="min-w-0 truncate">{activity.source.name}</em>
                                                        )}
                                                        <span className="shrink-0">
                                                            {activity.source.name ? ", " : ""}{activity.source.citation}
                                                        </span>
                                                        {!!shownParagraphs.length && (
                                                            <span className="ms-1 shrink-0 text-gray-500">
                                                                at {shownParagraphs.length === 1 ? "para." : "paras."} {shownParagraphs.join(", ")}{paragraphSuffix}
                                                            </span>
                                                        )}
                                                    </button>
                                                ) : (
                                                    <span className="break-words">{activity.label}</span>
                                                )}
                                                {activity.tool && activity.input && (
                                                    <details className="mt-1 rounded border border-gray-200 bg-white px-2 py-1">
                                                        <summary className="cursor-pointer font-mono text-[11px] text-gray-700">
                                                            {activity.tool}
                                                        </summary>
                                                        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-gray-600">
                                                            {JSON.stringify(activity.input, null, 2)}
                                                        </pre>
                                                    </details>
                                                )}
                                            </span>
                                        </li>
                                        );
                                    })}
                                    {panel.status === "running" &&
                                        !panel.activities.some(
                                            (activity) => activity.status === "running",
                                        ) && (
                                            <li
                                                role="status"
                                                className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-xs leading-5 text-gray-600"
                                            >
                                                <LoaderCircle
                                                    className="mt-1 size-3 motion-safe:animate-spin"
                                                    aria-hidden="true"
                                                />
                                                <span>Thinking</span>
                                            </li>
                                        )}
                                </ol>
                            </details>
                        ) : panel.status === "running" ? (
                            <div role="status" className="mt-2 flex min-h-8 items-center gap-2 text-xs text-gray-600">
                                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                                Starting…
                            </div>
                        ) : panel.status === "cancelled" || panel.status === "interrupted" ? (
                            <div role="status" className="mt-2 flex min-h-8 items-center gap-2 text-xs text-gray-500">
                                <CircleStop className="size-3.5" aria-hidden="true" />
                                {panel.status === "cancelled" ? "Stopped" : "Interrupted"}
                            </div>
                        ) : null}
                        {panel.output ? (
                            <details
                                open
                                className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs leading-5 text-gray-700"
                            >
                                <summary className="cursor-pointer font-medium text-gray-600">
                                    Final output
                                    {panel.grounding?.status === "passed"
                                        ? ` · ${panel.grounding.evidence.length} verified ${panel.grounding.evidence.length === 1 ? "passage" : "passages"}`
                                        : ""}
                                </summary>
                                <div
                                    aria-label="Agent final output"
                                    className="prose prose-sm mt-2 max-w-none break-words text-xs leading-5 text-gray-700 [overflow-wrap:anywhere] [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_li]:text-xs [&_p]:text-xs"
                                >
                                    <CitationPillMarkdown
                                        text={panel.output}
                                        sources={panel.sources}
                                        onSourceClick={(source) => onSourceClick?.(source as ReadSubagentSource)}
                                    />
                                </div>
                            </details>
                        ) : panel.status === "error" ? (
                            <p className="ms-5 mt-2 rounded-xl rounded-br-sm bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">
                                {panel.error ?? "Reading agent failed."}
                            </p>
                        ) : null}
                    </section>
                ))}
                </div>
            </div>
        </section>
    );
}
