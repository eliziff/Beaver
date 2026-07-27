"use client";

import {
    type CSSProperties,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { ExternalLink } from "lucide-react";
import { MikeIcon } from "@/app/components/chat/mike-icon";
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
    type LegalSourceViewerPayload,
} from "@/app/lib/mikeApi";

type ViewerAnchor = LegalSourceViewerPayload["structure"]["blocks"][number];

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

function stripDisplayedMarker(
    text: string,
    anchor: ViewerAnchor | null,
) {
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

function navigationAnchors(payload: LegalSourceViewerPayload) {
    const blocks = payload.structure.blocks;
    if (payload.reference.docType === "laws") {
        return blocks.filter((block) => block.kind === "section");
    }
    const pages = blocks.filter((block) => block.kind === "page");
    return pages.length
        ? pages
        : blocks.filter((block) => block.kind === "paragraph");
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
    const navigation = useMemo(
        () => (payload ? navigationAnchors(payload) : []),
        [payload],
    );
    const quoteItems: CitationQuoteHeaderItem[] = quotes.map((quote, index) => ({
        id: `a2aj-quote-${index}`,
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
                () => match.scrollIntoView({ behavior: "smooth", block: "center" }),
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
                <p className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 font-serif text-sm text-red-700">
                    {error}
                </p>
            </div>
        );
    }
    if (!payload) {
        return (
            <div className="flex h-full items-center justify-center">
                <MikeIcon spin mike size={30} />
            </div>
        );
    }

    const kindLabel =
        payload.reference.docType === "laws"
            ? "Legislation"
            : payload.reference.docType === "articles"
              ? "Journal article"
              : "Decision";
    const navLabel =
        payload.reference.docType === "laws"
            ? "Provisions"
            : navigation[0]?.kind === "page"
              ? "Pages"
              : "Paragraphs";

    return (
        <div ref={rootRef} className="flex h-full min-h-0 flex-col">
            <header className="shrink-0 border-b border-gray-200 bg-white/70 px-4 py-4 backdrop-blur-xl">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
                            {kindLabel}
                        </p>
                        <h1 className="font-serif text-xl leading-tight text-gray-950">
                            {payload.metadata.title}
                        </h1>
                        <p className="mt-1 font-serif text-sm italic text-gray-600">
                            {payload.metadata.citation}
                            {payload.metadata.alternateCitation
                                ? ` / ${payload.metadata.alternateCitation}`
                                : ""}
                        </p>
                        <p className="mt-2 text-xs text-gray-500">
                            {[
                                payload.metadata.dataset,
                                payload.metadata.date,
                                payload.metadata.language.toUpperCase(),
                            ]
                                .filter(Boolean)
                                .join(" / ")}
                        </p>
                    </div>
                    {payload.metadata.url ? (
                        <a
                            href={payload.metadata.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:bg-brand-soft"
                        >
                            Original
                            <ExternalLink className="h-3.5 w-3.5" />
                        </a>
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

            <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-white/60 px-4 py-2">
                <label
                    htmlFor={`legal-jump-${referenceId ?? "source"}`}
                    className="text-xs font-medium text-gray-600"
                >
                    Go to
                </label>
                <select
                    id={`legal-jump-${referenceId ?? "source"}`}
                    defaultValue=""
                    onChange={(event) => {
                        if (event.target.value) jumpTo(event.target.value);
                    }}
                    className="min-w-0 max-w-56 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 outline-none focus:border-brand"
                >
                    <option value="">Select {navLabel.toLowerCase()}</option>
                    {navigation.map((anchor) => (
                        <option key={anchor.label} value={anchor.label}>
                            {locatorLabel(anchor.label)}
                        </option>
                    ))}
                </select>
                <span className="ml-auto text-[11px] text-gray-400">
                    {navigation.length} {navLabel.toLowerCase()}
                </span>
            </div>

            {payload.truncated ? (
                <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                    This unusually long source is displayed through the first
                    five million characters.
                </p>
            ) : null}

            <div className="flex min-h-0 flex-1">
                {!compact && navigation.length > 0 ? (
                    <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-gray-200 bg-white/45 p-3 lg:block">
                        <h2 className="mb-2 text-xs font-semibold text-gray-700">
                            {navLabel}
                        </h2>
                        <nav aria-label={`${navLabel} in ${payload.metadata.title}`}>
                            <ol className="space-y-0.5">
                                {navigation.map((anchor) => (
                                    <li
                                        key={anchor.label}
                                        style={{
                                            paddingLeft:
                                                anchor.kind === "section"
                                                    ? `${Math.min(sectionDepth(anchor.label), 4) * 10}px`
                                                    : undefined,
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => jumpTo(anchor.label)}
                                            className="w-full truncate rounded px-2 py-1 text-left font-serif text-xs text-gray-600 hover:bg-brand-soft hover:text-brand"
                                            title={locatorLabel(anchor.label)}
                                        >
                                            {locatorLabel(anchor.label)}
                                        </button>
                                    </li>
                                ))}
                            </ol>
                        </nav>
                    </aside>
                ) : null}

                <div
                    ref={contentRef}
                    className="min-h-0 flex-1 overflow-y-auto scroll-smooth bg-[#fbfaf7] px-4 py-6 sm:px-7"
                >
                    <article
                        lang={payload.metadata.language}
                        className="mx-auto max-w-3xl font-serif text-[15px] leading-7 text-gray-900"
                    >
                        {slices.map((slice) => {
                            const page = slice.anchors.find(
                                (anchor) => anchor.kind === "page",
                            );
                            const marker =
                                slice.primary &&
                                slice.primary.kind !== "page"
                                    ? locatorLabel(slice.primary.label)
                                    : null;
                            return (
                                <section
                                    key={slice.key}
                                    className="scroll-mt-4"
                                    style={
                                        {
                                            contentVisibility: "auto",
                                            containIntrinsicSize: "auto 150px",
                                            marginLeft:
                                                payload.reference.docType ===
                                                "laws"
                                                    ? `${slice.depth * 14}px`
                                                    : undefined,
                                        } as CSSProperties
                                    }
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
                                            className="mb-4 mt-7 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400 first:mt-0"
                                        >
                                            <span className="h-px flex-1 bg-gray-200" />
                                            {locatorLabel(page.label)}
                                        </div>
                                    ) : null}
                                    {slice.text ? (
                                        <div
                                            className={`mb-4 grid gap-3 ${
                                                marker
                                                    ? "grid-cols-[auto_minmax(0,1fr)]"
                                                    : "grid-cols-1"
                                            }`}
                                        >
                                            {marker ? (
                                                <span className="min-w-8 pt-0.5 text-right font-sans text-xs font-semibold text-brand">
                                                    {marker}
                                                </span>
                                            ) : null}
                                            <p className="whitespace-pre-wrap text-justify">
                                                {stripDisplayedMarker(
                                                    slice.text,
                                                    slice.primary,
                                                )}
                                            </p>
                                        </div>
                                    ) : null}
                                </section>
                            );
                        })}
                    </article>
                </div>
            </div>
        </div>
    );
}
