import { createElement, type ComponentProps, type ElementType, type RefObject } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssistantEvent, Citation } from "../../shared/types";
import { RESPONSE_GLASS_ANNOTATION, withoutMarkdownNode } from "./messageStyles";
import { citationTooltip } from "./CitationSources";
import { internalCaseHref } from "./citationUtils";
export function GfmMarkdown(props: ComponentProps<typeof ReactMarkdown>) {
    return <ReactMarkdown {...props} remarkPlugins={[remarkGfm]} />;
}
function styled<T extends ElementType>(tag: T, className: string) {
    return (props: ComponentProps<T> & { node?: unknown }) =>
        createElement(tag, { className, ...withoutMarkdownNode(props) });
}
export function MarkdownContent({
    text,
    inlineCitationTargets,
    caseCitations,
    caseOpinions,
    onCitationClick,
    citationTitle,
    onCaseClick,
    divRef,
}: {
    text: string;
    inlineCitationTargets: Citation[];
    caseCitations: Map<
        string,
        Extract<AssistantEvent, { type: "case_citation" }>
    >;
    caseOpinions: Map<
        number,
        Extract<AssistantEvent, { type: "case_opinions" }>["case"]
    >;
    onCitationClick?: (c: Citation) => void;
    citationTitle?: (c: Citation) => string;
    onCaseClick?: (
        c: Extract<AssistantEvent, { type: "case_citation" }>,
    ) => void;
    divRef?: RefObject<HTMLDivElement | null>;
}) {
    function findCaseCitation(href: string) {
        return caseCitations.get(internalCaseHref(href) ?? "");
    }
    return (
        <div
            ref={divRef}
            className="text-gray-900 mb-4 text-base prose prose-sm max-w-none font-serif"
        >
            <GfmMarkdown
                urlTransform={(url) =>
                    /^us-case-\d+$/.test(url) ? url : defaultUrlTransform(url)
                }
                components={{
                    table: (props) => (
                        <div className="overflow-x-auto my-4 rounded-lg">
                            <table
                                className="min-w-full divide-y divide-gray-300 overflow-hidden"
                                {...withoutMarkdownNode(props)}
                            />
                        </div>
                    ),
                    thead: styled("thead", "bg-gray-100"),
                    tbody: styled("tbody", "divide-y divide-gray-200"),
                    th: styled("th", "px-3 py-3.5 text-left text-sm font-semibold text-gray-900"),
                    td: styled("td", "whitespace-normal px-3 py-4 text-sm text-gray-900"),
                    h1: styled("h1", "mt-6 mb-4 text-3xl font-serif font-semibold"),
                    h2: styled("h2", "mt-5 mb-3 text-2xl font-serif font-semibold"),
                    h3: styled("h3", "text-xl font-semibold mt-4 mb-2"),
                    h4: styled("h4", "text-lg font-semibold mt-4 mb-2"),
                    h5: styled("h5", "text-base font-semibold mt-3 mb-2"),
                    h6: styled("h6", "text-sm font-semibold mt-3 mb-2"),
                    p: ({ node, ...props }) => {
                        const parent =
                            node && typeof node === "object" && "parent" in node
                                ? (node as { parent?: { type?: string } })
                                      .parent
                                : undefined;
                        if (parent?.type === "listItem") {
                            return (
                                <p
                                    className="inline leading-7 m-0"
                                    {...props}
                                />
                            );
                        }
                        return <p className="mb-4 leading-7" {...props} />;
                    },
                    ul: styled("ul", "list-disc list-outside mb-4 pl-6"),
                    ol: styled("ol", "list-decimal list-outside mb-4 pl-6"),
                    li: styled("li", "mb-2 leading-7"),
                    strong: styled("strong", "font-semibold"),
                    em: styled("em", "italic"),
                    code: (props) => {
                        const { children, ...codeProps } =
                            withoutMarkdownNode(props);
                        const text = String(children);
                        const citMatch = text.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const annotation = inlineCitationTargets[idx];
                            if (annotation) {
                                const tooltipText =
                                    citationTitle?.(annotation) ??
                                    citationTooltip(annotation);
                                return (
                                    <button
                                        onClick={() =>
                                            onCitationClick?.(annotation)
                                        }
                                        data-citation-ref={annotation.ref}
                                        className={`${RESPONSE_GLASS_ANNOTATION} mx-0.5 align-super`}
                                        title={tooltipText}
                                    >
                                        {annotation.ref}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code
                                className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-serif"
                                {...codeProps}
                            >
                                {children}
                            </code>
                        );
                    },
                    blockquote: styled("blockquote", "border-l-4 border-gray-300 pl-4 italic my-4"),
                    a: (props) => {
                        const { href, children, ...anchorProps } =
                            withoutMarkdownNode(props);
                        if (href) {
                            const isInternalCaseHref = !!internalCaseHref(href);
                            const citation = findCaseCitation(href);
                            if (citation && onCaseClick) {
                                return (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onCaseClick({
                                                ...citation,
                                                case:
                                                    citation.cluster_id !== null
                                                        ? caseOpinions.get(
                                                              citation.cluster_id,
                                                          )
                                                        : undefined,
                                            })
                                        }
                                        className="text-left text-blue-600 hover:text-blue-700 underline"
                                    >
                                        {children}
                                    </button>
                                );
                            }
                            if (citation) {
                                return (
                                    <a
                                        href={citation.url}
                                        className="text-blue-600 hover:text-blue-700 underline"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        {children}
                                    </a>
                                );
                            }
                            if (isInternalCaseHref) {
                                return (
                                    <span className="text-blue-600 underline">
                                        {children}
                                    </span>
                                );
                            }
                            const isBeaverAppHref = /^\/(?!\/)/.test(href);
                            return (
                                <a
                                    href={href}
                                    className="text-blue-600 hover:text-blue-700 underline"
                                    target={
                                        isBeaverAppHref ? undefined : "_blank"
                                    }
                                    rel={
                                        isBeaverAppHref
                                            ? undefined
                                            : "noopener noreferrer"
                                    }
                                    {...anchorProps}
                                >
                                    {children}
                                </a>
                            );
                        }
                        return (
                            <a
                                href={href}
                                className="text-blue-600 hover:text-blue-700 underline"
                                target="_blank"
                                rel="noopener noreferrer"
                                {...anchorProps}
                            >
                                {children}
                            </a>
                        );
                    },
                    hr: styled("hr", "my-6 border-gray-200"),
                }}
            >
                {text}
            </GfmMarkdown>
        </div>
    );
}
