import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnConfig } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";

type ParsedTabularMarkdown = {
    processed: string;
    citations: ParsedCitation[];
    pills: string[];
};

export function parseTabularMarkdown(text: string): ParsedTabularMarkdown {
    const { processed: cited, citations } = preprocessCitations(text);
    const pills: string[] = [];
    const processed = cited
        .replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
            pills.push(content);
            return `\`§p${pills.length - 1}§\`\u200B`;
        })
        .replace(/§(\d+)§/g, "`§c$1§`\u200B");
    return { processed, citations, pills };
}

export function TabularMarkdown({
    parsed,
    column,
    onCitationClick,
    citationOffset = 0,
    inline = false,
}: {
    parsed: ParsedTabularMarkdown;
    column?: ColumnConfig;
    onCitationClick: (citation: ParsedCitation, citationRef: number) => void;
    citationOffset?: number;
    inline?: boolean;
}) {
    if (!parsed.processed) return null;
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ node: _node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p className="mb-1 last:mb-0 leading-relaxed" {...props} />
                    ),
                ul: ({ node: _node, ...props }) => (
                    <ul className="mb-1 list-disc space-y-0.5 pl-4 last:mb-0" {...props} />
                ),
                ol: ({ node: _node, ...props }) => (
                    <ol className="mb-1 list-decimal space-y-0.5 pl-4 last:mb-0" {...props} />
                ),
                strong: ({ node: _node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
                a: ({ node: _node, ...props }) => (
                    <a
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 underline hover:text-blue-700"
                        {...props}
                    />
                ),
                code: ({ node: _node, children, ...props }) => {
                    const token = String(children);
                    const citationIndex = token.match(/^§c(\d+)§$/)?.[1];
                    if (citationIndex !== undefined) {
                        const index = Number(citationIndex);
                        const citation = parsed.citations[index];
                        if (citation) {
                            const reference = citationOffset + index + 1;
                            const location = citation.sheet
                                ? `${citation.sheet}!${citation.cell ?? ""}`
                                : `Page ${citation.page ?? 1}`;
                            return (
                                <button
                                    type="button"
                                    data-page={citation.page}
                                    data-sheet={citation.sheet}
                                    data-cell={citation.cell}
                                    data-quote={citation.quote}
                                    aria-label={`Open citation ${reference}: ${location}`}
                                    title={`${location}: "${citation.quote}"`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onCitationClick(citation, reference);
                                    }}
                                    className="mx-0.5 inline-flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full bg-gray-200 align-super text-[9px] font-medium text-gray-700 hover:bg-gray-300"
                                >
                                    {reference}
                                </button>
                            );
                        }
                    }
                    const pillIndex = token.match(/^§p(\d+)§$/)?.[1];
                    if (pillIndex !== undefined) {
                        const content = parsed.pills[Number(pillIndex)];
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
                            className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]"
                            {...props}
                        >
                            {children}
                        </code>
                    );
                },
            }}
        >
            {parsed.processed}
        </ReactMarkdown>
    );
}
