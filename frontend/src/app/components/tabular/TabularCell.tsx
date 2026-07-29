"use client";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";
import { SkeletonLine } from "../shared/TablePrimitive";
interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: (cell: TCell) => void;
    onCitationClick: (
        cell: TCell,
        page: number | undefined,
        quote: string,
        citationRef: number,
        sheet?: string,
        citationCell?: string,
    ) => void;
}
const FLAG_STYLES = {
    green: "bg-green-500",
    grey: "bg-gray-400",
    yellow: "bg-amber-400",
    red: "bg-red-500",
} as const;
function TabularCellSkeleton() {
    return (
        <div className="flex h-8 items-center px-2">
            <SkeletonLine className="h-3.5 w-full" />
        </div>
    );
}
function preprocessCellMarkdown(text: string): {
    processed: string;
    citations: ParsedCitation[];
    pills: string[];
} {
    const { processed: withCits, citations } = preprocessCitations(text);
    const pills: string[] = [];
    let out = withCits.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\`\u200B`;
    });
    out = out.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\`\u200B`);
    return { processed: out, citations, pills };
}
function CellMarkdown({
    text,
    citations,
    pills,
    column,
    onCitationClick,
    inline,
}: {
    text: string;
    citations: ParsedCitation[];
    pills: string[];
    column?: ColumnConfig;
    onCitationClick: (
        page: number | undefined,
        quote: string,
        citationRef: number,
        sheet?: string,
        cell?: string,
    ) => void;
    inline?: boolean;
}) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p className="mb-1 last:mb-0 leading-relaxed" {...props} />
                    ),
                ul: ({ node, ...props }) => (
                    <ul className="list-disc pl-4 space-y-0.5" {...props} />
                ),
                ol: ({ node, ...props }) => (
                    <ol className="list-decimal pl-4 space-y-0.5" {...props} />
                ),
                li: ({ node, ...props }) => <li {...props} />,
                strong: ({ node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node, ...props }) => <em className="italic" {...props} />,
                a: ({ node, href, children, ...props }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-700 underline"
                        {...props}
                    >
                        {children}
                    </a>
                ),
                code: ({ node, children, ...props }) => {
                    const t = String(children);
                    const citMatch = t.match(/^§c(\d+)§$/);
                    if (citMatch) {
                        const idx = parseInt(citMatch[1]);
                        const citation = citations[idx];
                        if (citation) {
                            return (
                                <span
                                    title={`${formatCitationLocation(citation)}: "${citation.quote}"`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCitationClick(
                                            citation.page,
                                            citation.quote,
                                            idx + 1,
                                            citation.sheet,
                                            citation.cell,
                                        );
                                    }}
                                    className="mx-0.5 inline-flex items-center justify-center rounded-full bg-gray-200 w-3.5 h-3.5 text-[9px] font-medium text-gray-700 align-super cursor-pointer hover:bg-gray-300"
                                >
                                    {idx + 1}
                                </span>
                            );
                        }
                    }
                    const pillMatch = t.match(/^§p(\d+)§$/);
                    if (pillMatch) {
                        const content = pills[parseInt(pillMatch[1])];
                        if (content !== undefined) {
                            return (
                                <span
                                    className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${getPillClass(content, column)}`}
                                >
                                    {content}
                                </span>
                            );
                        }
                    }
                    return (
                        <code
                            className="bg-gray-100 px-1 py-0.5 rounded text-[11px] font-mono"
                            {...props}
                        >
                            {children}
                        </code>
                    );
                },
            }}
        >
            {text}
        </ReactMarkdown>
    );
}
function formatCitationLocation(citation: ParsedCitation): string {
    if (citation.sheet && citation.cell) {
        return `${citation.sheet}!${citation.cell}`;
    }
    return `Page ${citation.page ?? 1}`;
}
export const TabularCell = memo(function TabularCell({
    cell,
    column,
    onExpand,
    onCitationClick,
}: Props) {
    if (cell.status === "generating") {
        return <TabularCellSkeleton />;
    }
    if (cell.status === "error") {
        return (
            <div className="h-8 flex items-center justify-center text-gray-300">
                <AlertCircle className="h-4 w-4 text-red-300" />
            </div>
        );
    }
    if (!cell.content?.summary) {
        return <div className="h-8" />;
    }
    const { processed, citations, pills } = preprocessCellMarkdown(
        cell.content.summary,
    );
    const firstLine = processed.split("\n").find((l) => l.trim()) ?? processed;
    const collapsedDisplay = firstLine.replace(/^[-*•]\s+/, "");
    function handleCitationClick(
        page: number | undefined,
        quote: string,
        citationRef: number,
        sheet?: string,
        citationCell?: string,
    ) {
        onCitationClick(cell, page, quote, citationRef, sheet, citationCell);
    }
    function handleSeeDetails() {
        onExpand(cell);
    }
    return (
        <div
            className="group relative flex h-8 cursor-pointer items-center px-2 text-xs leading-relaxed text-gray-800 hover:bg-gray-50"
            onClick={handleSeeDetails}
        >
            {cell.content.flag && (
                <span
                    className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                    title={cell.content.flag}
                />
            )}
            <div className="line-clamp-1 w-full min-w-0">
                <CellMarkdown
                    text={collapsedDisplay}
                    citations={citations}
                    pills={pills}
                    column={column}
                    onCitationClick={handleCitationClick}
                    inline
                />
            </div>
        </div>
    );
});
