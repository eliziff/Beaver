import {
    Children,
    createElement,
    isValidElement,
    type ComponentProps,
    type ElementType,
    type ReactNode,
    type RefObject,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssistantEvent, Citation } from "../../shared/types";
import { RESPONSE_GLASS_ANNOTATION, withoutMarkdownNode } from "./messageStyles";
import { citationTooltip } from "./CitationSources";
import { internalCaseHref } from "./citationUtils";
export function GfmMarkdown(props: ComponentProps<typeof ReactMarkdown>) {
    const { remarkPlugins, ...rest } = props;
    return (
        <ReactMarkdown
            {...rest}
            remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
        />
    );
}
const LEGAL_CITATION =
    /(?:\b(?:19|20)\d{2}\s+[A-Z][A-Z0-9-]{1,15}\s+\d+\b|\b\d+\s+(?:U\.?S\.?C\.?|U\.?S\.?|S\.?\s*Ct\.?|F\.?\s*(?:2d|3d|4th|Supp\.?))\s+(?:\u00a7+\s*)?\d+\b|\b(?:RSC|SC|RSA|SA|RSBC|SBC|RSO|SO)\s+\d{4}\b|\u00a7\s*\d+)/iu;
const LEGAL_CITATION_LINK =
    /\[([^\]\r\n]{1,180})\]\(([^)\r\n]+)\)(\s*,?\s*(?:at\s+)?para(?:graph)?s?\.?\s*\d{1,5}(?:\s*[-\u2013\u2014]\s*\d{1,5})?)/giu;
const LEGAL_CITATION_PILL =
    "not-prose inline-flex min-w-0 max-w-full items-baseline whitespace-normal break-words rounded-full bg-red-50 px-2 py-0.5 align-baseline font-sans text-[0.8125rem] font-medium leading-5 text-red-700 no-underline ring-1 ring-inset ring-red-200 hover:bg-red-100 hover:text-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600";

function nodeText(value: ReactNode): string {
    return Children.toArray(value)
        .map((child) =>
            typeof child === "string" || typeof child === "number"
                ? String(child)
                : isValidElement<{ children?: ReactNode }>(child)
                  ? nodeText(child.props.children)
                  : "",
        )
        .join("");
}

type MarkdownNode = {
    type: string;
    value?: string;
    url?: string;
    children?: MarkdownNode[];
};

function markdownNodeText(node: MarkdownNode): string {
    return node.value ?? node.children?.map(markdownNodeText).join("") ?? "";
}

function paragraphFragment(url: string) {
    const marker = url.indexOf(":~:");
    if (marker < 0) return null;
    const base = url.slice(0, marker);
    const anchor = base.match(/#par(\d+)$/iu)?.[1];
    if (!anchor) return null;
    try {
        const host = new URL(base).hostname.toLowerCase();
        if (
            ![
                "canlii.org",
                "www.canlii.org",
                "decisions.scc-csc.ca",
                "coadecisions.ontariocourts.ca",
                "www.bccourts.ca",
                "bccourts.ca",
            ].includes(host)
        ) {
            return null;
        }
    } catch {
        return null;
    }
    return {
        anchor,
        base,
        directives: url.slice(marker + 3).split("&").filter(Boolean),
    };
}

function moveParagraphFragmentsToCitationPills() {
    return (tree: MarkdownNode) => {
        let pending: Array<ReturnType<typeof paragraphFragment>> = [];
        const visit = (node: MarkdownNode) => {
            if (node.type === "link" && node.url) {
                const label = markdownNodeText(node);
                const fragment = paragraphFragment(node.url);
                if (fragment && !LEGAL_CITATION.test(label)) {
                    pending.push(fragment);
                } else if (LEGAL_CITATION.test(label)) {
                    const locator = label.match(
                        /\bpara(?:graph)?s?\.?\s*(\d+)/iu,
                    )?.[1];
                    const matching = pending.filter(
                        (candidate) =>
                            candidate?.anchor === String(Number(locator)),
                    );
                    const bases = new Set(
                        matching.flatMap((candidate) =>
                            candidate ? [candidate.base] : [],
                        ),
                    );
                    if (bases.size === 1) {
                        const base = [...bases][0];
                        const directives = [
                            ...new Set(
                                matching.flatMap(
                                    (candidate) =>
                                        candidate?.directives ?? [],
                                ),
                            ),
                        ];
                        node.url = `${base}:~:${directives.join("&")}`;
                    }
                    pending = [];
                }
            }
            node.children?.forEach(visit);
        };
        visit(tree);
    };
}

export function normalizeLegalCitationLinks(text: string) {
    return text.replace(
        LEGAL_CITATION_LINK,
        (full, label: string, href: string, pinpoint: string) =>
            LEGAL_CITATION.test(label)
                ? `[${label}${pinpoint}](${href})`
                : full,
    );
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
    const markdown = normalizeLegalCitationLinks(text);
    return (
        <div
            ref={divRef}
            className="text-gray-900 mb-4 text-base prose prose-sm max-w-none font-serif"
        >
            <GfmMarkdown
                remarkPlugins={[moveParagraphFragmentsToCitationPills]}
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
                            const isLegalCitation =
                                isInternalCaseHref ||
                                LEGAL_CITATION.test(nodeText(children));
                            if (
                                paragraphFragment(href) &&
                                !isLegalCitation
                            ) {
                                return <>{children}</>;
                            }
                            const className = isLegalCitation
                                ? LEGAL_CITATION_PILL
                                : "text-blue-600 hover:text-blue-700 underline";
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
                                        className={`${className} text-left`}
                                    >
                                        {children}
                                    </button>
                                );
                            }
                            if (citation) {
                                return (
                                    <a
                                        href={citation.url}
                                        className={className}
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
                                    className={className}
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
                {markdown}
            </GfmMarkdown>
        </div>
    );
}
