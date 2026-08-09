"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import type { AssistantEvent } from "../shared/types";
import {
    CitationPillMarkdown,
    LEGAL_CITATION_PILL,
} from "./message/MarkdownContent";

export type ReadSubagentPanel = Extract<
    AssistantEvent,
    { type: "subagent_run" }
>;
export type ReadSubagentSource = NonNullable<ReadSubagentPanel["sources"]>[number];

function linkedCaseSummary(
    text: string,
    sources: ReadSubagentSource[] | undefined,
    onSourceClick: ((source: ReadSubagentSource) => void) | undefined,
) {
    if (!sources?.length || !onSourceClick) return text;
    const byLabel = new Map<string, ReadSubagentSource>();
    for (const source of sources) {
        for (const label of [source.name, source.citation]) {
            if (label?.trim()) byLabel.set(label.trim().toLocaleLowerCase(), source);
        }
    }
    const labels = [...byLabel.keys()].sort((left, right) => right.length - left.length);
    if (!labels.length) return text;
    const escaped = labels.map((label) =>
        label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    );
    return text
        .split(new RegExp(`(${escaped.join("|")})`, "giu"))
        .map((part, index) => {
            const source = byLabel.get(part.toLocaleLowerCase());
            return source ? (
                <button
                    key={`${index}:${part}`}
                    type="button"
                    onClick={() => onSourceClick(source)}
                    className={`${LEGAL_CITATION_PILL} text-left`}
                >
                    {part}
                </button>
            ) : part;
        });
}

export function ReadSubagentDock({
    panels,
    onClose,
    onSourceClick,
    idPrefix = "reading-agent",
}: {
    panels: ReadSubagentPanel[];
    onClose: (id: string) => void;
    onSourceClick?: (source: ReadSubagentSource) => void;
    idPrefix?: string;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const [activeId, setActiveId] = useState(() => panels[0]?.id ?? "");
    useEffect(() => {
        if (!panels.some((panel) => panel.id === activeId)) {
            setActiveId(panels.at(-1)?.id ?? "");
        }
    }, [activeId, panels]);
    if (!panels.length) return null;
    const panel = panels.find((item) => item.id === activeId) ?? panels.at(-1)!;
    const panelIndex = panels.findIndex((item) => item.id === panel.id);
    return (
        <section
            aria-labelledby={`${idPrefix}-title`}
            className={`flex shrink-0 flex-col overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm ${collapsed ? "h-11" : "h-72"}`}
        >
            <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-gray-200 ps-1 pe-2">
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
                    <h2
                        id={`${idPrefix}-title`}
                        className="truncate text-sm font-medium text-gray-900"
                    >
                        Reading agents
                    </h2>
                </button>
                <button
                    type="button"
                    onClick={() => onClose(panel.id)}
                    className="grid size-10 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                    aria-label={`Close reading agent ${panelIndex + 1}`}
                >
                    <X className="size-4" />
                </button>
            </header>
            <div
                id={`${idPrefix}-body`}
                className="flex min-h-0 flex-1 flex-col"
                hidden={collapsed}
            >
                <div
                    role="tablist"
                    aria-label="Reading agents"
                    className="grid shrink-0 border-b border-gray-200 bg-gray-50"
                    style={{
                        gridTemplateColumns: `repeat(${panels.length}, minmax(0, 1fr))`,
                    }}
                >
                    {panels.map((item, index) => (
                        <button
                            key={item.id}
                            id={`${idPrefix}-tab-${item.id}`}
                            type="button"
                            role="tab"
                            aria-selected={item.id === panel.id}
                            aria-controls={`${idPrefix}-panel-${item.id}`}
                            onClick={() => setActiveId(item.id)}
                            className={`min-h-9 truncate border-b-2 px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-gray-900 ${item.id === panel.id ? "border-gray-900 bg-white text-gray-950" : "border-transparent text-gray-500 hover:bg-white hover:text-gray-900"}`}
                        >
                            Agent {index + 1}
                        </button>
                    ))}
                </div>
                <div
                    id={`${idPrefix}-panel-${panel.id}`}
                    role="tabpanel"
                    aria-labelledby={`${idPrefix}-tab-${panel.id}`}
                    className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
                >
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
                            {panel.activities?.length ? (
                                <ol
                                    aria-label="Reading activity"
                                    className="mb-2 space-y-1.5 border-y border-gray-100 py-2"
                                >
                                    {panel.activities.map((activity) => (
                                        <li
                                            key={activity.id}
                                            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-xs leading-5 text-gray-600"
                                        >
                                            {activity.status === "running" ? (
                                                <LoaderCircle
                                                    className="mt-1 size-3 shrink-0 animate-spin"
                                                    aria-hidden="true"
                                                />
                                            ) : activity.status === "completed" ? (
                                                <Check
                                                    className="mt-1 size-3 shrink-0 text-gray-500"
                                                    aria-hidden="true"
                                                />
                                            ) : (
                                                <X
                                                    className="mt-1 size-3 shrink-0 text-red-600"
                                                    aria-hidden="true"
                                                />
                                            )}
                                            <span className="min-w-0">
                                                {activity.source && onSourceClick ? (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            onSourceClick(activity.source!)
                                                        }
                                                        className="flex w-full min-w-0 items-baseline text-left underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                                                        title={`${activity.source.name ? `${activity.source.name}, ` : ""}${activity.source.citation}`}
                                                    >
                                                        <span className="me-1 shrink-0">
                                                            {activity.status === "running"
                                                                ? "Reading"
                                                                : "Read"}
                                                        </span>
                                                        {activity.source.name && (
                                                            <em className="min-w-0 truncate">
                                                                {activity.source.name}
                                                            </em>
                                                        )}
                                                        <span className="shrink-0">
                                                            {activity.source.name ? ", " : ""}
                                                            {activity.source.citation}
                                                        </span>
                                                    </button>
                                                ) : (
                                                    <span className="break-words">
                                                        {activity.label}
                                                    </span>
                                                )}
                                                {activity.tool && activity.input && (
                                                    <details className="mt-1 rounded border border-gray-200 bg-gray-50 px-2 py-1">
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
                                    ))}
                                </ol>
                            ) : panel.status === "running" ? (
                                <div
                                    role="status"
                                    className="flex min-h-10 items-center gap-2 text-sm text-gray-600"
                                >
                                    <LoaderCircle
                                        className="size-4 animate-spin"
                                        aria-hidden="true"
                                    />
                                    Starting…
                                </div>
                            ) : null}
                            {panel.reasoning?.length ? (
                                <details className="mb-2 rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700">
                                    <summary className="cursor-pointer font-medium">
                                        Provider reasoning summaries
                                    </summary>
                                    <div className="mt-2 space-y-2">
                                        {panel.reasoning.map((entry, index) => (
                                            <pre
                                                key={index}
                                                className="whitespace-pre-wrap break-words font-sans text-xs leading-5"
                                            >
                                                {linkedCaseSummary(
                                                    entry,
                                                    panel.sources,
                                                    onSourceClick,
                                                )}
                                            </pre>
                                        ))}
                                    </div>
                                </details>
                            ) : null}
                            {panel.output ? (
                                <div className="prose prose-sm max-w-none break-words text-sm leading-5 text-gray-600 [overflow-wrap:anywhere] [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_li]:text-sm [&_p]:text-sm">
                                    <CitationPillMarkdown
                                        text={panel.output}
                                        sources={panel.sources}
                                        onSourceClick={(source) =>
                                            onSourceClick?.(source as ReadSubagentSource)
                                        }
                                    />
                                </div>
                            ) : panel.status === "error" ? (
                                <p className="text-sm text-red-600">
                                    {panel.error ?? "Reading agent failed."}
                                </p>
                            ) : null}
                </div>
            </div>
        </section>
    );
}
