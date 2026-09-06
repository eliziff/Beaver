import type { ColumnConfig } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { preprocessCitations } from "../assistant/message/citationUtils";
import { CitationPill, GfmMarkdown } from "../assistant/message/MarkdownContent";
import { getPillClass } from "./pillUtils";
import type { GroundedAnswer } from "@/app/lib/groundedAnswers";

export function TabularMarkdown({
    text,
    citations = [],
    value,
    column,
    onCitationClick,
    inline = false,
}: {
    text: string;
    citations?: Citation[];
    value?: GroundedAnswer["value"];
    column?: Pick<ColumnConfig, "format" | "tags">;
    onCitationClick: (citation: Citation) => void;
    inline?: boolean;
}) {
    if (!text) return null;
    if (column?.format && ["yes_no", "tag", "currency"].includes(column.format)) return <>
        {(Array.isArray(value) ? value : [text]).map((label, index) => <span key={index}
            className={`mr-1 inline-block rounded-full px-2 py-1 text-xs font-medium leading-4 ${getPillClass(label, column)}`}>{label}</span>)}
        {citations.map((citation) => <CitationPill key={citation.ref} citation={citation} onClick={onCitationClick}
            className="mx-0.5 !text-[10px] !leading-4" />)}
    </>;
    const targets: Citation[] = [];
    const processed = preprocessCitations(text, new Map(citations.map((citation) => [citation.ref, citation])), targets);
    return (
        <GfmMarkdown
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
                    const citationIndex = token.match(/^§(\d+)§$/)?.[1];
                    if (citationIndex !== undefined) {
                        const index = Number(citationIndex);
                        const citation = targets[index];
                        if (citation) {
                            return <CitationPill citation={citation} onClick={onCitationClick}
                                className="mx-0.5 !text-[10px] !leading-4" />;
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
            {processed}
        </GfmMarkdown>
    );
}
