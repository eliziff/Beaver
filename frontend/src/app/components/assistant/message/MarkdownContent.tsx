import {
    Children,
    createElement,
    isValidElement,
    type ComponentProps,
    type ElementType,
    type ReactNode,
    type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import remarkGfm from "remark-gfm";
import { safeAssistantUrl } from "@/app/lib/assistantSession";
import type { Citation } from "../../shared/types";
import { withoutMarkdownNode } from "./messageStyles";
import {
    citationPillParts,
    citationTooltip,
} from "./CitationSources";
export function GfmMarkdown(props: ComponentProps<typeof ReactMarkdown>) {
    const { remarkPlugins, urlTransform, ...rest } = props;
    return (
        <ReactMarkdown
            {...rest}
            remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
            urlTransform={urlTransform ?? ((url) => safeAssistantUrl(url) ?? "")}
        />
    );
}
const LEGAL_CITATION =
    /(?:\b(?:19|20)\d{2}\s+[A-Z][A-Z0-9-]{1,15}\s+\d+\b|\b\d+\s+(?:U\.?S\.?C\.?|U\.?S\.?|S\.?\s*Ct\.?|F\.?\s*(?:2d|3d|4th|Supp\.?))\s+(?:\u00a7+\s*)?\d+\b|\b(?:RSC|SC|RSA|SA|RSBC|SBC|RSO|SO)\s+\d{4}\b|\u00a7\s*\d+)/iu;
const LEGAL_CITATION_LINK =
    /\[([^\]\r\n]{1,180})\]\(([^)\r\n]+)\)(\s*,?\s*(?:at\s+)?para(?:graph)?s?\.?\s*\d{1,5}(?:\s*[-\u2013\u2014]\s*\d{1,5})?)/giu;
const LEGAL_CITATION_PILL =
    "not-prose inline-block min-w-0 max-w-full whitespace-normal break-words rounded-md bg-red-800 px-2 py-0.5 align-baseline font-sans text-[0.8125rem] font-medium leading-5 text-red-50 no-underline ring-1 ring-inset ring-red-600/70 [overflow-wrap:anywhere] hover:bg-red-700 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400";
const PLAIN_LINK =
    "text-red-300 underline decoration-red-500/70 underline-offset-2 hover:text-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400";

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
function paragraphLocator(value: string | null | undefined) {
    if (!value) return null;
    const direct = value.match(/^par(\d+)/iu)?.[1];
    const cited = value.match(/\bpara(?:graph)?s?\.?\s*(\d+)/iu)?.[1];
    return direct || cited ? `par${direct ?? cited}` : null;
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
                    const locator = paragraphLocator(label)?.slice(3);
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

function normalizeLegalCitationLinks(text: string) {
    return text.replace(
        LEGAL_CITATION_LINK,
        (full, label: string, href: string, pinpoint: string) =>
            LEGAL_CITATION.test(label)
                ? `[${label}${pinpoint}](${href})`
                : full,
    );
}

export type GroundedCitationSource = {
    citation: string;
    name?: string | null;
    url?: string | null;
    locator?: string;
    quote?: string;
};

export function CitationPillMarkdown({
    text,
    sources = [],
    onSourceClick,
}: {
    text: string;
    sources?: GroundedCitationSource[];
    onSourceClick?: (source: GroundedCitationSource) => void;
}) {
    return (
        <GfmMarkdown
            components={{
                a: (props) => {
                    const { href, children, ...anchorProps } =
                        withoutMarkdownNode(props);
                    const label = nodeText(children);
                    const locator = paragraphLocator(label);
                    const matchingSources = sources.filter(
                        (candidate) =>
                            label
                                .toLocaleLowerCase()
                                .includes(candidate.citation.toLocaleLowerCase()) ||
                            (!!href && candidate.url === href),
                    );
                    const source =
                        matchingSources.find(
                            (candidate) =>
                                locator &&
                                paragraphLocator(candidate.locator) === locator,
                        ) ?? matchingSources[0];
                    const pill = source || LEGAL_CITATION.test(label);
                    const className = pill ? LEGAL_CITATION_PILL : PLAIN_LINK;
                    if (source && onSourceClick) {
                        return (
                            <button
                                type="button"
                                onClick={() => onSourceClick({
                                    ...source,
                                    ...(locator && { locator }),
                                })}
                                className={`${className} text-left`}
                            >
                                {children}
                            </button>
                        );
                    }
                    const internal = !!href && /^\/(?!\/)/u.test(href);
                    const link = source
                        ? safeAssistantUrl(source.url, { relative: false })
                        : internal ? href : null;
                    if (!link) return <>{children}</>;
                    return (
                        <a
                            href={link}
                            className={className}
                            target={internal ? undefined : "_blank"}
                            rel={internal ? undefined : "noopener noreferrer"}
                            {...anchorProps}
                        >
                            {children}
                        </a>
                    );
                },
            }}
        >
            {normalizeLegalCitationLinks(text)}
        </GfmMarkdown>
    );
}
function styled<T extends ElementType>(tag: T, className: string) {
    return function Styled(props: ComponentProps<T> & { node?: unknown }) {
        return createElement(tag, { className, ...withoutMarkdownNode(props) });
    };
}
export function MarkdownContent({
    text,
    inlineCitationTargets,
    onCitationClick,
    citationTitle,
    divRef,
    isStreaming = false,
}: {
    text: string;
    inlineCitationTargets: Citation[];
    onCitationClick?: (c: Citation) => void;
    citationTitle?: (c: Citation) => string;
    divRef?: RefObject<HTMLDivElement | null>;
    isStreaming?: boolean;
}) {
    const markdown = normalizeLegalCitationLinks(isStreaming ? remend(text) : text);
    return (
        <div
            ref={divRef}
            className="mb-0 max-w-none text-base text-white prose prose-sm prose-invert font-serif"
        >
            <GfmMarkdown
                remarkPlugins={[moveParagraphFragmentsToCitationPills]}
                components={{
                    table: (props) => (
                        <div className="my-4 overflow-x-auto rounded-lg bg-gray-900">
                            <table
                                className="min-w-full divide-y divide-gray-700 overflow-hidden"
                                {...withoutMarkdownNode(props)}
                            />
                        </div>
                    ),
                    thead: styled("thead", "bg-gray-800"),
                    tbody: styled("tbody", "divide-y divide-gray-700"),
                    th: styled("th", "px-3 py-3.5 text-left text-sm font-semibold text-white"),
                    td: styled("td", "whitespace-normal px-3 py-4 text-sm text-gray-100"),
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
                        const citMatch = text.match(/^§(\d+)§$/u);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const annotation = inlineCitationTargets[idx];
                            if (annotation) {
                                const label = citationPillParts(annotation);
                                const tooltipText =
                                    citationTitle?.(annotation) ??
                                    citationTooltip(annotation);
                                return (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onCitationClick?.(annotation)
                                        }
                                        data-citation-ref={annotation.ref}
                                        className={`${LEGAL_CITATION_PILL} mx-0.5 text-left`}
                                        title={tooltipText}
                                    >
                                        {label.styleOfCause ? (
                                            <>
                                                <em>{label.styleOfCause}</em>
                                                {label.rest}
                                            </>
                                        ) : (
                                            label.rest
                                        )}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code
                                className="rounded bg-gray-800 px-1.5 py-0.5 font-serif text-sm text-gray-100"
                                {...codeProps}
                            >
                                {children}
                            </code>
                        );
                    },
                    blockquote: styled("blockquote", "my-4 border-l-4 border-gray-600 pl-4 italic text-gray-200"),
                    a: (props) => {
                        const { href, children, ...anchorProps } =
                            withoutMarkdownNode(props);
                        if (href) {
                            let unavailable = false;
                            try { unavailable = /(^|\.)getcaselaw\.com$/iu.test(new URL(href).hostname); }
                            catch { /* Invalid URLs continue through the existing link handling. */ }
                            if (unavailable) {
                                return <>{children}</>;
                            }
                            const isLegalCitation = LEGAL_CITATION.test(nodeText(children));
                            if (
                                paragraphFragment(href) &&
                                !isLegalCitation
                            ) {
                                return <>{children}</>;
                            }
                            const className = isLegalCitation
                                ? LEGAL_CITATION_PILL
                                : PLAIN_LINK;
                            const isBeaverAppHref = /^\/(?!\/)/.test(href);
                            if (!isBeaverAppHref) return <>{children}</>;
                            return (
                                <a
                                    href={href}
                                    className={className}
                                    {...anchorProps}
                                >
                                    {children}
                                </a>
                            );
                        }
                        return (
                            <a
                                href={href}
                                className={PLAIN_LINK}
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
