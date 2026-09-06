import type { ColumnConfig } from "@/app/lib/api/tabular";
import type { Citation } from "@/app/lib/citations";
import { preprocessCitations } from "../assistant/message/citationUtils";
import { CitationPill, GfmMarkdown } from "../assistant/message/MarkdownContent";
import { getPillClass } from "./pillUtils";
import type { GroundedAnswer } from "@/app/lib/groundedAnswers";

export const NUMERIC_FORMATS = new Set(["number", "percentage", "monetary_amount", "currency"]);
const PILL_FORMATS = new Set(["yes_no", "tag", "currency"]);
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/u;
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
function displayDate(value: GroundedAnswer["value"], text: string): string {
    const raw = typeof value === "string" ? value : text;
    const match = ISO_DATE.exec(raw.trim());
    if (!match) return text;
    const date = new Date(raw.trim());
    if (Number.isNaN(date.getTime())) return text;
    return (match[0] === match[1] ? DATE_ONLY : DATE_TIME).format(date);
}
const listItems = (value: GroundedAnswer["value"], text: string) => Array.isArray(value)
    ? value : text.split(/\r?\n/u).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, "").trim()).filter(Boolean);

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
    const format = column?.format;
    const pills = citations.map((citation) => <CitationPill key={citation.ref} citation={citation} onClick={onCitationClick}
        className="mx-0.5 !text-[10px] !leading-4" />);
    if (format && PILL_FORMATS.has(format)) return <>
        {(Array.isArray(value) ? value : [text]).map((label, index) => <span key={index}
            className={`mr-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium leading-4 ${getPillClass(label, column)}`}>{label}</span>)}
        {pills}
    </>;
    if (format && NUMERIC_FORMATS.has(format)) return <><span className="tabular-nums">{text}</span>{pills}</>;
    if (format === "date") return <><span className="tabular-nums">{displayDate(value, text)}</span>{pills}</>;
    if (format === "bulleted_list" && inline) {
        const items = listItems(value, text);
        return <ul className="inline">
            {items.slice(0, 3).map((item, index) => <li key={index}
                className="inline [&:not(:first-child)]:before:mx-1 [&:not(:first-child)]:before:text-gray-400 [&:not(:first-child)]:before:content-['·']">{item}</li>)}
            {items.length > 3 && <li className="ml-1 inline text-gray-500">+{items.length - 3}</li>}
        </ul>;
    }
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
