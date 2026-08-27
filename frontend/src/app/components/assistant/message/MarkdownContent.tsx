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
import type { Citation, ToolActivitySource } from "../../shared/types";
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

export function CitationPillMarkdown({
    text,
    sources = [],
    onSourceClick,
}: {
    text: string;
    sources?: ToolActivitySource[];
    onSourceClick?: (source: ToolActivitySource) => void;
}) {
    return (
        <GfmMarkdown
            components={{
                a: (props) => {
                    const { href, children, ...anchorProps } =
                        withoutMarkdownNode(props);
                    const label = nodeText(children);
                    const source = sources.find(
                        (candidate) => !!href && candidate.url === href,
                    ) ?? sources.find((candidate) =>
                        label.toLocaleLowerCase().includes(
                            candidate.citation.toLocaleLowerCase(),
                        ),
                    );
                    const className = source ? LEGAL_CITATION_PILL : PLAIN_LINK;
                    if (source && onSourceClick) {
                        return (
                            <button
                                type="button"
                                onClick={() => onSourceClick(source)}
                                className={`${className} text-left`}
                            >
                                {children}
                            </button>
                        );
                    }
                    const link = source
                        ? safeAssistantUrl(source.url, { relative: false })
                        : safeAssistantUrl(href);
                    if (!link || (!source && !link.startsWith("/"))) return <>{children}</>;
                    const internal = link.startsWith("/");
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
            {text}
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
