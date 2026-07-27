"use client";

import {
    Fragment,
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { ExternalLink } from "lucide-react";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
} from "@/app/components/shared/views/highlightDocxQuote";
import {
    CitationQuotesHeader,
    type CitationQuoteHeaderItem,
} from "@/app/components/assistant/CitationQuotesHeader";
import {
    getDirectLegalSourceDocument,
    getLegalSourceDocument,
    type LegalDocumentType,
    type LegalSourceInlineToken,
    type LegalSourcePresentationBlock,
    type LegalSourceViewerPayload,
} from "@/app/lib/beaverApi";

type ViewerAnchor = LegalSourceViewerPayload["structure"]["blocks"][number];
type ViewerMetadata = LegalSourceViewerPayload["metadata"];

export type LegalSourceViewerSlice = {
    key: string;
    text: string;
    anchors: ViewerAnchor[];
    primary: ViewerAnchor | null;
    depth: number;
};

export type LegalSourceViewerProps = {
    referenceId?: string;
    provider?: "a2aj" | "journal";
    citation?: string;
    sourceId?: string | null;
    docType?: LegalDocumentType | "auto";
    language?: "en" | "fr";
    dataset?: string | null;
    quotes?: { quote: string }[];
    citationRef?: number;
    compact?: boolean;
};

export type LegalSourceTab = {
    kind: "legal";
    id: `legal:${string}`;
    citation: string;
    name: string | null;
    dataset: string | null;
    provider?: "a2aj" | "journal";
    sourceId?: string | null;
    docType: LegalDocumentType | "auto";
    language: "en" | "fr";
    citationRef?: number;
    quotes?: { quote: string }[];
};

export function legalSourceAnchorId(label: string) {
    return `legal-${label.replace(/[^a-z0-9_.-]+/giu, "-")}`;
}

function locatorLabel(label: string) {
    if (label.startsWith("page")) return `Page ${label.slice(4)}`;
    if (label.startsWith("par")) return `[${label.slice(3)}]`;
    if (label.startsWith("fn")) return `Footnote ${label.slice(2)}`;
    if (label.startsWith("sec")) return label.slice(3);
    return label;
}

function sectionDepth(label: string) {
    const locator = label.replace(/^sec/u, "");
    return Math.min(
        5,
        (locator.match(/\(/gu)?.length ?? 0) +
            Math.max(0, locator.split(/[.-]/u).length - 1),
    );
}

function primaryAnchor(
    anchors: ViewerAnchor[],
    docType: LegalDocumentType,
) {
    const wanted = docType === "laws" ? "section" : "paragraph";
    return (
        anchors
            .filter((anchor) => anchor.kind === wanted)
            .sort((left, right) => right.label.length - left.label.length)[0] ??
        anchors.find((anchor) => anchor.kind === "page") ??
        null
    );
}

function fallbackStarts(text: string) {
    const starts = [0];
    for (const match of text.matchAll(/\n[ \t]*\n+/gu)) {
        starts.push(match.index + match[0].length);
    }
    return starts;
}

export function buildLegalSourceViewerSlices(
    payload: LegalSourceViewerPayload,
): LegalSourceViewerSlice[] {
    const text = payload.text;
    const relevantKind =
        payload.reference.docType === "laws" ? "section" : "paragraph";
    const usable = payload.structure.blocks.filter(
        (block) =>
            block.start >= 0 &&
            block.start < text.length &&
            (block.kind === relevantKind || block.kind === "page"),
    );
    const anchorsByStart = new Map<number, ViewerAnchor[]>();
    for (const block of usable) {
        anchorsByStart.set(block.start, [
            ...(anchorsByStart.get(block.start) ?? []),
            block,
        ]);
    }
    const starts = [
        ...new Set(
            usable.length
                ? [0, ...anchorsByStart.keys()]
                : fallbackStarts(text),
        ),
    ].sort((left, right) => left - right);
    if (starts.at(-1) !== text.length) starts.push(text.length);
    return starts.slice(0, -1).flatMap((start, index) => {
        const end = starts[index + 1];
        const anchors = anchorsByStart.get(start) ?? [];
        const content = text.slice(start, end).trim();
        if (!content && !anchors.length) return [];
        const primary = primaryAnchor(anchors, payload.reference.docType);
        return [
            {
                key: `${start}:${end}`,
                text: content,
                anchors,
                primary,
                depth:
                    primary?.kind === "section"
                        ? sectionDepth(primary.label)
                        : 0,
            },
        ];
    });
}

function stripDisplayedMarker(text: string, anchor: ViewerAnchor | null) {
    if (!anchor || !text) return text;
    if (anchor.kind === "paragraph") {
        const number = anchor.label.slice(3);
        return text.replace(
            new RegExp(`^\\s*(?:\\[\\s*${number}\\s*\\]|${number}\\.)\\s*`, "u"),
            "",
        );
    }
    if (anchor.kind !== "section") return text;
    const locator = anchor.label.slice(3);
    const escaped = locator
        .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
        .replace(/\\\(/gu, "\\s*\\(");
    const full = text.replace(new RegExp(`^\\s*${escaped}\\s*`, "iu"), "");
    if (full !== text) return full;
    const child = locator.match(/(\([^)]+\))$/u)?.[1];
    return child
        ? text.replace(
              new RegExp(
                  `^\\s*${child.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*`,
                  "iu",
              ),
              "",
          )
        : text;
}

function safeExternalHref(value: string | null | undefined) {
    if (!value) return null;
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
            ? value
            : null;
    } catch {
        return null;
    }
}

function displayDate(value: string | null) {
    return value?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0] ?? value;
}

export function legalSourceViewerActions(metadata: ViewerMetadata) {
    const actions: Array<{
        kind: "source" | "pdf";
        label: string;
        href: string;
    }> = [];
    const source = safeExternalHref(metadata.url);
    const pdf = safeExternalHref(metadata.pdfUrl);
    if (source) {
        actions.push({
            kind: "source",
            label: "View original source",
            href: source,
        });
    }
    if (pdf) {
        actions.push({
            kind: "pdf",
            label: "View authoritative PDF",
            href: pdf,
        });
    }
    return actions;
}

function removeLeadingCharacters(
    tokens: LegalSourceInlineToken[],
    count: number,
) {
    if (count <= 0) return tokens;
    let remaining = count;
    return tokens.flatMap((token) => {
        if (remaining >= token.text.length) {
            remaining -= token.text.length;
            return [];
        }
        if (remaining > 0) {
            const result = { ...token, text: token.text.slice(remaining) };
            remaining = 0;
            return [result];
        }
        return [token];
    });
}

function stripInlineMarker(
    tokens: LegalSourceInlineToken[],
    anchor: ViewerAnchor | null,
) {
    if (!anchor) return tokens;
    const text = tokens.map((token) => token.text).join("");
    const displayed = stripDisplayedMarker(text, anchor);
    return removeLeadingCharacters(tokens, text.length - displayed.length);
}

function stripProvisionMarker(
    tokens: LegalSourceInlineToken[],
    label: string,
) {
    const text = tokens.map((token) => token.text).join("");
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const displayed = text.replace(
        new RegExp(`^\\s*${escaped}\\s*`, "iu"),
        "",
    );
    return removeLeadingCharacters(tokens, text.length - displayed.length);
}

export function LegalInlineText({
    tokens,
}: {
    tokens: LegalSourceInlineToken[];
}) {
    return (
        <>
            {tokens.map((token, index) => {
                const key = `${index}:${token.kind}`;
                if (token.kind === "em") {
                    return <em key={key}>{token.text}</em>;
                }
                if (token.kind === "strong") {
                    return <strong key={key}>{token.text}</strong>;
                }
                if (token.kind === "code") {
                    return (
                        <code
                            key={key}
                            className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.88em]"
                        >
                            {token.text}
                        </code>
                    );
                }
                if (token.kind === "sup") {
                    return <sup key={key}>{token.text}</sup>;
                }
                if (token.kind === "sub") {
                    return <sub key={key}>{token.text}</sub>;
                }
                if (token.kind === "link") {
                    const href =
                        token.href.startsWith("#")
                            ? token.href
                            : safeExternalHref(token.href);
                    return href ? (
                        <a
                            key={key}
                            href={href}
                            target={href.startsWith("#") ? undefined : "_blank"}
                            rel={
                                href.startsWith("#")
                                    ? undefined
                                    : "noopener noreferrer"
                            }
                            className="text-brand underline decoration-brand/35 underline-offset-2 hover:decoration-brand"
                        >
                            {token.text}
                        </a>
                    ) : (
                        <Fragment key={key}>{token.text}</Fragment>
                    );
                }
                return <Fragment key={key}>{token.text}</Fragment>;
            })}
        </>
    );
}

function HeadingBlock({
    block,
    tokens,
}: {
    block: Extract<LegalSourcePresentationBlock, { kind: "heading" }>;
    tokens: LegalSourceInlineToken[];
}) {
    const content = <LegalInlineText tokens={tokens} />;
    if (block.level === 2) {
        return (
            <h2 className="mb-4 mt-10 border-b border-gray-300 pb-2 text-[1.5rem] font-semibold leading-tight text-gray-950 first:mt-0">
                {content}
            </h2>
        );
    }
    if (block.level === 3) {
        return (
            <h3 className="mb-3 mt-8 border-b-2 border-brand pb-1 text-[1.25rem] font-semibold leading-snug text-gray-950 first:mt-0">
                {content}
            </h3>
        );
    }
    if (block.level === 4) {
        return (
            <h4 className="mb-3 mt-7 border-l-4 border-brand pl-3 text-[1.1rem] font-semibold leading-snug text-gray-950 first:mt-0">
                {content}
            </h4>
        );
    }
    return (
        <h5 className="mb-2 mt-6 text-sm font-semibold uppercase leading-snug tracking-[0.08em] text-gray-800 first:mt-0">
            {content}
        </h5>
    );
}

export function LegalPresentedBlocks({
    blocks,
    anchor,
}: {
    blocks: LegalSourcePresentationBlock[];
    anchor: ViewerAnchor | null;
}) {
    const nodes: ReactNode[] = [];
    let index = 0;
    const inline = (
        block: LegalSourcePresentationBlock,
        blockIndex: number,
    ) => {
        const anchored =
            blockIndex === 0
                ? stripInlineMarker(block.inline, anchor)
                : block.inline;
        return block.kind === "provision"
            ? stripProvisionMarker(anchored, block.label)
            : anchored;
    };

    while (index < blocks.length) {
        const block = blocks[index];
        if (block.kind === "list-item") {
            const items: Array<{
                block: typeof block;
                tokens: LegalSourceInlineToken[];
            }> = [];
            const ordered = block.ordered;
            const depth = block.depth;
            while (index < blocks.length) {
                const item = blocks[index];
                if (
                    item.kind !== "list-item" ||
                    item.ordered !== ordered ||
                    item.depth !== depth
                ) {
                    break;
                }
                items.push({ block: item, tokens: inline(item, index) });
                index += 1;
            }
            const children = items.map((item, itemIndex) => (
                <li key={`${item.block.marker}:${itemIndex}`} className="pl-1.5">
                    <LegalInlineText tokens={item.tokens} />
                </li>
            ));
            const listClass = `mb-4 space-y-1 pl-6 ${
                ordered ? "list-decimal" : "list-disc"
            }`;
            const style = {
                marginInlineStart: `${Math.min(depth, 4) * 0.75}rem`,
            };
            const firstNumber = Number.parseInt(block.marker, 10);
            nodes.push(
                ordered ? (
                    <ol
                        key={`list:${index - items.length}`}
                        className={listClass}
                        style={style}
                        start={
                            Number.isFinite(firstNumber)
                                ? firstNumber
                                : undefined
                        }
                    >
                        {children}
                    </ol>
                ) : (
                    <ul
                        key={`list:${index - items.length}`}
                        className={listClass}
                        style={style}
                    >
                        {children}
                    </ul>
                ),
            );
            continue;
        }

        const tokens = inline(block, index);
        const key = `${index}:${block.kind}`;
        if (block.kind === "heading") {
            nodes.push(<HeadingBlock key={key} block={block} tokens={tokens} />);
        } else if (block.kind === "blockquote") {
            nodes.push(
                <blockquote
                    key={key}
                    className="mb-5 ml-1 border-l-4 border-gray-300 py-0.5 pl-5 text-gray-700"
                >
                    <LegalInlineText tokens={tokens} />
                </blockquote>,
            );
        } else if (block.kind === "provision" && !anchor) {
            nodes.push(
                <p
                    key={key}
                    className="mb-4 grid grid-cols-[minmax(2.4rem,auto)_minmax(0,1fr)] gap-x-3"
                    style={{
                        marginInlineStart: `${Math.min(block.depth, 4) * 0.75}rem`,
                    }}
                >
                    <span className="font-semibold text-gray-700">
                        {block.label}
                    </span>
                    <span>
                        <LegalInlineText tokens={tokens} />
                    </span>
                </p>,
            );
        } else {
            nodes.push(
                <p
                    key={key}
                    className="mb-4 whitespace-pre-wrap [hyphens:none] [overflow-wrap:normal] [word-break:normal]"
                >
                    <LegalInlineText tokens={tokens} />
                </p>,
            );
        }
        index += 1;
    }
    return <>{nodes}</>;
}

export function LegalSourceViewer({
    referenceId,
    provider = "a2aj",
    citation,
    sourceId,
    docType = "auto",
    language = "en",
    dataset,
    quotes = [],
    citationRef,
    compact = false,
}: LegalSourceViewerProps) {
    const [payload, setPayload] = useState<LegalSourceViewerPayload | null>(
        null,
    );
    const [error, setError] = useState<string | null>(null);
    const [activeQuote, setActiveQuote] = useState(0);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setPayload(null);
            setError(null);
        });
        const request = referenceId
            ? getLegalSourceDocument(referenceId)
            : citation
              ? getDirectLegalSourceDocument({
                    provider,
                    citation,
                    sourceId,
                    docType,
                    language,
                    dataset,
                })
              : Promise.reject(new Error("Legal source reference is missing"));
        request
            .then((result) => {
                if (!cancelled) setPayload(result);
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : "Could not load legal source",
                    );
                }
            });
        return () => {
            cancelled = true;
        };
    }, [citation, dataset, docType, language, provider, referenceId, sourceId]);

    const slices = useMemo(
        () => (payload ? buildLegalSourceViewerSlices(payload) : []),
        [payload],
    );
    const presentation = useMemo(
        () =>
            new Map(
                payload?.presentation?.segments.map((segment) => [
                    `${segment.start}:${segment.end}`,
                    segment.blocks,
                ]) ?? [],
            ),
        [payload],
    );
    const quoteItems: CitationQuoteHeaderItem[] = quotes.map((quote, index) => ({
        id: `legal-quote-${index}`,
        quote: quote.quote,
    }));

    const jumpTo = useCallback((label: string) => {
        rootRef.current
            ?.querySelector<HTMLElement>(`#${legalSourceAnchorId(label)}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []);

    useEffect(() => {
        const root = contentRef.current;
        if (!root || !payload) return;
        clearDocxQuoteHighlights(root);
        const quote = quotes[activeQuote]?.quote;
        if (!quote) return;
        const match = highlightDocxQuote(root, quote);
        if (match) {
            window.setTimeout(
                () =>
                    match.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                    }),
                40,
            );
        }
    }, [activeQuote, payload, quotes]);

    useEffect(() => {
        if (!payload || !window.location.hash) return;
        const label = decodeURIComponent(window.location.hash.slice(1)).replace(
            /^legal-/u,
            "",
        );
        if (label) window.requestAnimationFrame(() => jumpTo(label));
    }, [jumpTo, payload]);

    if (error) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <p className="max-w-md rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                    {error}
                </p>
            </div>
        );
    }
    if (!payload) {
        return (
            <div className="flex h-full items-center justify-center">
                <ThinkingSpinner label="Loading legal source" size={24} />
            </div>
        );
    }

    const kindLabel =
        payload.reference.docType === "laws"
            ? "Legislation"
            : payload.reference.docType === "articles"
              ? "Journal article"
              : "Decision";
    const actions = legalSourceViewerActions(payload.metadata);
    const details = [
        payload.metadata.dataset,
        displayDate(payload.metadata.date),
        payload.metadata.language.toUpperCase(),
    ].filter(Boolean);

    return (
        <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-white">
            <header
                className={`shrink-0 border-b border-gray-200 bg-white ${
                    compact ? "px-4 py-3" : "px-5 py-4 sm:px-8"
                }`}
            >
                <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-x-5 gap-y-3">
                    <div className="min-w-0 flex-1 basis-80">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
                            {kindLabel}
                        </p>
                        <h1 className="text-xl font-semibold leading-tight text-gray-950 sm:text-2xl">
                            {payload.metadata.title}
                        </h1>
                        <p className="mt-1 text-sm italic leading-snug text-gray-600">
                            {payload.metadata.citation}
                            {payload.metadata.alternateCitation
                                ? ` / ${payload.metadata.alternateCitation}`
                                : ""}
                        </p>
                        {details.length ? (
                            <p className="mt-2 text-xs text-gray-500">
                                {details.join(" · ")}
                            </p>
                        ) : null}
                    </div>
                    {actions.length ? (
                        <nav
                            aria-label="Source links"
                            className="flex max-w-full flex-wrap items-center gap-2"
                        >
                            {actions.map((action) => (
                                <a
                                    key={`${action.kind}:${action.href}`}
                                    href={action.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`inline-flex whitespace-nowrap rounded border px-3 py-2 text-xs font-medium ${
                                        action.kind === "source"
                                            ? "border-brand bg-brand text-white hover:bg-brand/90"
                                            : "border-gray-300 bg-white text-gray-800 hover:border-brand hover:text-brand"
                                    }`}
                                >
                                    {action.label}
                                    <ExternalLink
                                        aria-hidden="true"
                                        className="ml-1.5 h-3.5 w-3.5"
                                    />
                                </a>
                            ))}
                        </nav>
                    ) : null}
                </div>
            </header>

            {quoteItems.length > 0 ? (
                <div className="shrink-0 py-2">
                    <CitationQuotesHeader
                        quotes={quoteItems}
                        currentIndex={activeQuote}
                        activeQuoteId={quoteItems[activeQuote]?.id}
                        citationRef={citationRef}
                        citationText={payload.metadata.citation}
                        onSelect={(_quote, index) => setActiveQuote(index)}
                        onIndexChange={setActiveQuote}
                    />
                </div>
            ) : null}

            {payload.truncated ? (
                <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                    This unusually long source is displayed through the first
                    five million characters.
                </p>
            ) : null}

            <div
                ref={contentRef}
                className="min-h-0 flex-1 overflow-y-auto scroll-smooth bg-[#faf9f6] px-4 py-8 sm:px-8 sm:py-10"
            >
                <article
                    lang={payload.metadata.language}
                    className="mx-auto max-w-[48rem] font-sans text-[17px] leading-[1.68] text-gray-900"
                >
                    {slices.map((slice) => {
                        const page = slice.anchors.find(
                            (anchor) => anchor.kind === "page",
                        );
                        const marker =
                            slice.primary && slice.primary.kind !== "page"
                                ? locatorLabel(slice.primary.label)
                                : null;
                        const blocks = presentation.get(slice.key);
                        return (
                            <section
                                key={slice.key}
                                className="scroll-mt-4"
                                style={{
                                    contentVisibility: "auto",
                                    containIntrinsicSize: "auto 150px",
                                    marginInlineStart:
                                        payload.reference.docType === "laws"
                                            ? `${Math.min(slice.depth, 4) * 0.8}rem`
                                            : undefined,
                                }}
                            >
                                {slice.anchors.map((anchor) => (
                                    <span
                                        key={anchor.label}
                                        id={legalSourceAnchorId(anchor.label)}
                                        className="block scroll-mt-4"
                                        aria-hidden="true"
                                    />
                                ))}
                                {page ? (
                                    <div
                                        role="doc-pagebreak"
                                        aria-label={locatorLabel(page.label)}
                                        className="mb-7 mt-10 border-t border-gray-300 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500 first:mt-0"
                                    >
                                        {locatorLabel(page.label)}
                                    </div>
                                ) : null}
                                {slice.text ? (
                                    <div
                                        className={`mb-1 grid gap-x-4 ${
                                            marker
                                                ? "grid-cols-[2.7rem_minmax(0,1fr)]"
                                                : "grid-cols-1"
                                        }`}
                                    >
                                        {marker ? (
                                            <span className="pt-[0.23rem] text-right text-xs font-semibold text-gray-600">
                                                {marker}
                                            </span>
                                        ) : null}
                                        <div className="min-w-0">
                                            {blocks ? (
                                                <LegalPresentedBlocks
                                                    blocks={blocks}
                                                    anchor={slice.primary}
                                                />
                                            ) : (
                                                <p className="mb-4 whitespace-pre-wrap [hyphens:none] [overflow-wrap:normal] [word-break:normal]">
                                                    {stripDisplayedMarker(
                                                        slice.text,
                                                        slice.primary,
                                                    )}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                ) : null}
                            </section>
                        );
                    })}
                </article>
            </div>
        </div>
    );
}
