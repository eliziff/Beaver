import {
    createElement,
    createContext,
    useContext,
    type ComponentProps,
    type ElementType,
    type RefObject,
    type ReactNode,
} from "react";
import { MoreActionsMenu } from "../../shared/MoreActionsMenu";
import ReactMarkdown from "react-markdown";
import type { Root, Element, Text } from "hast";
import { searchHighlightRanges } from "@/app/lib/searchHighlight";
import remend from "remend";
import remarkGfm from "remark-gfm";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { getDocumentCitationQuotes, type Citation } from "@/app/lib/citations";
import { withoutMarkdownNode } from "./messageStyles";
import {
    citationPillParts,
    citationTooltip,
} from "./CitationSources";
import { uniqueCitations } from "./citationUtils";
export const MessageSearchHighlight = createContext("");

function highlightText(query: string) {
    return () => (tree: Root) => {
        const nodes: { node: Text; parent: Root | Element; start: number }[] = [];
        let text = "";
        function collect(parent: Root | Element) {
            for (const node of parent.children) {
                if (node.type === "text") {
                    nodes.push({ node, parent, start: text.length });
                    text += node.value;
                } else if (node.type === "element") collect(node);
            }
        }
        collect(tree);
        const matches = searchHighlightRanges(text, query);
        for (const { node, parent, start } of nodes) {
            const ranges = matches.filter(([from, to]) => from < start + node.value.length && to > start);
            if (!ranges.length) continue;
            const replacement: (Text | Element)[] = [];
            let cursor = 0;
            for (const [from, to] of ranges) {
                const left = Math.max(0, from - start), right = Math.min(node.value.length, to - start);
                if (left > cursor) replacement.push({ type: "text", value: node.value.slice(cursor, left) });
                replacement.push({ type: "element", tagName: "mark", properties: {
                    className: ["bg-amber-200", "text-gray-950"], "data-search-match": true,
                }, children: [{ type: "text", value: node.value.slice(left, right) }] });
                cursor = right;
            }
            if (cursor < node.value.length) replacement.push({ type: "text", value: node.value.slice(cursor) });
            parent.children.splice(parent.children.indexOf(node), 1, ...replacement);
        }
    };
}

export function GfmMarkdown(props: ComponentProps<typeof ReactMarkdown>) {
    const { remarkPlugins, rehypePlugins, urlTransform, ...rest } = props;
    const query = useContext(MessageSearchHighlight).trim();
    return (
        <ReactMarkdown
            {...rest}
            remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
            rehypePlugins={[...(rehypePlugins ?? []), ...(query ? [highlightText(query)] : [])]}
            urlTransform={urlTransform ?? ((url) => safeAssistantUrl(url) ?? "")}
        />
    );
}
const LEGAL_CITATION_PILL =
    "not-prose inline-block min-w-0 max-w-full whitespace-normal break-words rounded-md bg-red-800 px-2 py-0.5 align-baseline font-sans text-[0.8125rem] font-medium leading-5 text-red-50 no-underline ring-1 ring-inset ring-red-600/70 [overflow-wrap:anywhere] hover:bg-red-700 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400";
const PLAIN_LINK =
    "text-red-300 underline decoration-red-500/70 underline-offset-2 hover:text-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400";

const ASSISTANT_SOURCE = "/__beaver_source/";
function sourceCitations(text: string, citations: Citation[]) {
    const byRef = new Map(citations.map((citation) => [citation.ref, citation]));
    return text.replace(/(?<!\\)\[(?:\d+(?:,\s*\d+)*)\](?:\s*\[(?:\d+(?:,\s*\d+)*)\])*(?!\()/gu, (markers) => {
        const selected = (markers.match(/\d+/gu) ?? [])
            .flatMap((ref) => byRef.get(Number(ref)) ?? []);
        return selected.length ? uniqueCitations(selected).map(({ ref }) =>
            `[source ${ref}](${ASSISTANT_SOURCE}${ref})`).join("") : markers;
    });
}

export function CitationPill({
    citation,
    onClick,
    className = "",
    title,
    truncateStyleOfCause = false,
    sourceOnly = false,
    workspaceAvailable = true,
    children,
}: {
    citation: Citation;
    onClick?: (citation: Citation, action?: "workspace") => void;
    className?: string;
    title?: string;
    truncateStyleOfCause?: boolean;
    sourceOnly?: boolean;
    workspaceAvailable?: boolean;
    children?: ReactNode;
}) {
    const label = citationPillParts(citation, sourceOnly), target = getDocumentCitationQuotes(citation)[0];
    const content = label.styleOfCause ? (
        <><em className={truncateStyleOfCause ? "min-w-0 max-w-56 truncate" : undefined}>{label.styleOfCause}</em><span className={truncateStyleOfCause ? "shrink-0 whitespace-nowrap" : undefined}>{label.rest}</span></>
    ) : label.rest;
    const pillClassName = `${LEGAL_CITATION_PILL} ${truncateStyleOfCause && label.styleOfCause ? "!inline-flex !whitespace-nowrap" : ""} ${className}`;
    const href = safeAssistantUrl(citation.external_url, { relative: false }) ?? (citation.kind === "document" ? `/library?${new URLSearchParams({ document_id: citation.document_id,
        ...(citation.version_id ? { version_id: citation.version_id } : {}),
        ...(target?.sheet ? { sheet: target.sheet } : {}), ...(target?.cell ? { cell: target.cell } : {}) })}`
        : citation.kind === "tabular" ? `/tabular-reviews/${encodeURIComponent(citation.review_id)}`
        : safeAssistantUrl(citation.url, { relative: false }));
    return <span className="group/citation inline-flex max-w-full items-baseline" onClick={(event) => event.stopPropagation()}>
        <a href={href ?? undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!href || undefined}
            data-citation-ref={citation.ref} className={pillClassName} title={title ?? citationTooltip(citation)}>{children ?? content}</a>
        {onClick && <MoreActionsMenu label="Citation actions"
            triggerClassName="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 opacity-0 hover:bg-gray-100 group-hover/citation:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
            items={[{ label: "Open in reader", onSelect: () => onClick(citation) },
                ...(workspaceAvailable ? [{ label: "Open in workspace", onSelect: () => onClick(citation, "workspace") }] : [])]} />}
    </span>;
}

export function CitationPillMarkdown({
    text,
    citations = [],
    onCitationClick,
    truncateStyleOfCause = false,
}: {
    text: string;
    citations?: Citation[];
    onCitationClick?: (citation: Citation, action?: "workspace") => void;
    truncateStyleOfCause?: boolean;
}) {
    return (
        <GfmMarkdown
            components={{
                a: (props) => {
                    const { href, children, ...anchorProps } =
                        withoutMarkdownNode(props);
                    const sourceRef = href?.startsWith(ASSISTANT_SOURCE)
                        ? Number(href.slice(ASSISTANT_SOURCE.length))
                        : -1;
                    const citation = citations.find(({ ref }) => ref === sourceRef);
                    if (citation) return <CitationPill citation={citation} onClick={onCitationClick} truncateStyleOfCause={truncateStyleOfCause} />;
                    const link = safeAssistantUrl(href);
                    if (!link || !link.startsWith("/")) return <>{children}</>;
                    const internal = link.startsWith("/");
                    return (
                        <a
                            href={link}
                            className={PLAIN_LINK}
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
            {sourceCitations(text, citations)}
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
    const markdown = isStreaming ? remend(text) : text;
    return (
        <div
            ref={divRef}
            className="mb-0 max-w-none text-base text-white prose prose-sm prose-invert font-serif"
        >
            <GfmMarkdown
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
                    pre: styled("pre", "my-4 overflow-x-auto rounded-lg bg-gray-900 p-4 whitespace-pre [&_code]:bg-transparent [&_code]:p-0"),
                    code: (props) => {
                        const { children, ...codeProps } =
                            withoutMarkdownNode(props);
                        const text = String(children);
                        const citMatch = text.match(/^§(\d+)§$/u);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const annotation = inlineCitationTargets[idx];
                            if (annotation) {
                                return (
                                    <CitationPill
                                        citation={annotation}
                                        onClick={onCitationClick}
                                        className="mx-0.5"
                                        title={citationTitle?.(annotation)}
                                    />
                                );
                            }
                        }
                        return (
                            <code
                                className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-sm text-gray-100"
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
                        const link = safeAssistantUrl(href);
                        if (!link?.startsWith("/")) return <>{children}</>;
                        return (
                            <a
                                href={link}
                                className={PLAIN_LINK}
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
