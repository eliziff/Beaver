import { createElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { ExternalLink } from "lucide-react";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";
import type { CaseCitationQuote } from "@/app/components/shared/types";
import { clearDocxQuoteHighlights, highlightDocxQuote } from "@/app/components/shared/views/highlightDocxQuote";
import { CitationQuotesHeader } from "@/app/components/assistant/CitationQuotesHeader";
import {
    getCourtlistenerOpinions,
    getDirectLegalSourceDocument,
    getLegalSourceDocument,
    type CaseLawOpinion,
    type LegalDocumentType,
    type LegalSourceInlineToken,
    type LegalSourcePresentationBlock,
    type LegalSourceViewerPayload,
} from "@/app/lib/beaverApi";
type ViewerAnchor = LegalSourceViewerPayload["structure"]["blocks"][number];
type ViewerMetadata = LegalSourceViewerPayload["metadata"];
const EMPTY_QUOTES: { quote: string }[] = [];
export type LegalSourceViewerProps = {
    referenceId?: string; provider?: "a2aj" | "journal";
    citation?: string; sourceId?: string | null;
    docType?: LegalDocumentType | "auto"; language?: "en" | "fr";
    dataset?: string | null; quotes?: { quote: string }[];
    citationRef?: number; compact?: boolean;
    caseTab?: CaseTab;
};
export type CaseTab = {
    kind: "case"; id: `case:${number}`; chatId: string; clusterId: number;
    citationRef?: number; caseName: string | null; citation: string | null;
    url: string | null; dateFiled: string | null; pdfUrl: string | null;
    quotes?: CaseCitationQuote[]; opinions?: CaseLawOpinion[];
};
export type LegalSourceTab = {
    kind: "legal"; id: `legal:${string}`; citation: string;
    name: string | null; dataset: string | null;
    provider?: "a2aj" | "journal"; sourceId?: string | null;
    docType: LegalDocumentType | "auto"; language: "en" | "fr"; citationRef?: number;
    quotes?: { quote: string }[];
};
const caseOpinionsCache = new Map<
    number,
    CaseLawOpinion[] | Promise<CaseLawOpinion[]>
>();
const CASE_HTML_CONFIG = {
    ALLOWED_TAGS:
        "a blockquote br code div em h1 h2 h3 h4 h5 h6 i li ol p pre small span strong sub sup table tbody td th thead tr u ul".split(
            " ",
        ),
    ALLOWED_ATTR:
        "aria-label class colspan href id rel rowspan target title".split(" "),
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    ALLOWED_URI_REGEXP: /^(?:https:\/\/www\.courtlistener\.com\/|#)/iu,
    FORBID_ATTR: ["style"],
    FORBID_TAGS: "embed form iframe math object script style svg".split(" "),
    RETURN_TRUSTED_TYPE: false,
};
function sanitizeCaseHtml(value: string) {
    const sanitized = DOMPurify.sanitize(value, CASE_HTML_CONFIG);
    if (typeof document === "undefined") return sanitized;
    const template = document.createElement("template");
    template.innerHTML = sanitized;
    template.content.querySelectorAll("a[href]").forEach((anchor) => {
        if (anchor.getAttribute("href")?.startsWith("#")) return;
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
    });
    return template.innerHTML;
}
function friendlyCaseError(message: string) {
    if (message.includes("429") || /rate limit|throttled/iu.test(message)) {
        const wait = message.match(/available in\s+(\d+)\s+seconds/iu)?.[1];
        return `CourtListener is rate limiting requests. Please try again${
            wait ? ` in about ${wait} seconds` : " shortly"
        }.`;
    }
    if (message.includes("401") || /credentials|token|auth/iu.test(message))
        return "CourtListener authentication is not configured correctly.";
    return "Could not load this case from CourtListener. Please try again shortly.";
}
const CASE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
});
function formatCaseDate(value: string | null) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? value : CASE_DATE_FORMAT.format(date);
}
function opinionTypeLabel(value: string | null) {
    if (!value) return "Opinion";
    const type = value.replace(/^\d+/u, "").replace(/_/gu, " ").trim();
    const compact = type.toLowerCase().replace(/\s+/gu, "");
    if (compact === "lead") return "Lead Opinion";
    if (/^(?:concurrentinpart|concurrenceinpart|concurinpart)$/u.test(compact)) {
        return "Concurrence in part";
    }
    if (compact === "combined") return "Combined Opinion";
    return type.replace(/\b\w/gu, (character) => character.toUpperCase());
}
function opinionTitle(
    opinion: Pick<CaseLawOpinion, "type" | "author">,
    index?: number,
) {
    const type = opinion.type
        ? opinionTypeLabel(opinion.type)
        : `Opinion ${index ?? ""}`.trim();
    return opinion.author ? `${type} by ${opinion.author}` : type;
}
function opinionRank(value: string | null) {
    const type = value?.replace(/^\d+/u, "").toLowerCase() ?? "";
    if (/lead|majority|unanimous|plurality/u.test(type)) return 0;
    if (type.includes("concurr")) return 1;
    if (type.includes("dissent")) return 2;
    return type.includes("combined") ? 4 : 3;
}
function orderOpinions(opinions: CaseLawOpinion[]) {
    return opinions
        .map((opinion, index) => ({ opinion, index }))
        .sort((a, b) => opinionRank(a.opinion.type) - opinionRank(b.opinion.type) || a.index - b.index);
}
export function legalSourceKindLabel(docType?: LegalDocumentType) {
    return docType === "laws"
        ? "Legislation"
        : docType === "articles"
          ? "Journal article"
          : "Decision";
}
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
function primaryAnchor(anchors: ViewerAnchor[], docType: LegalDocumentType) {
    const wanted = docType === "laws" ? "section" : "paragraph";
    let primary: ViewerAnchor | undefined;
    for (const anchor of anchors)
        if (anchor.kind === wanted && (!primary || anchor.label.length > primary.label.length))
            primary = anchor;
    return primary ?? anchors.find((anchor) => anchor.kind === "page") ?? null;
}
function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
export function buildLegalSourceViewerSlices(payload: LegalSourceViewerPayload) {
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
        const anchors = anchorsByStart.get(block.start);
        if (anchors) anchors.push(block);
        else anchorsByStart.set(block.start, [block]);
    }
    const starts = [
        ...new Set(
            usable.length
                ? [0, ...anchorsByStart.keys()]
                : [
                      0,
                      ...Array.from(
                          text.matchAll(/\n[ \t]*\n+/gu),
                          (match) => match.index + match[0].length,
                      ),
                  ],
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
    const escaped = escapeRegExp(locator).replace(/\\\(/gu, "\\s*\\(");
    const full = text.replace(new RegExp(`^\\s*${escaped}\\s*`, "iu"), "");
    if (full !== text) return full;
    const child = locator.match(/(\([^)]+\))$/u)?.[1];
    return child
        ? text.replace(
              new RegExp(
                  `^\\s*${escapeRegExp(child)}\\s*`,
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
        return (url.protocol === "http:" || url.protocol === "https:") &&
            !url.username &&
            !url.password
            ? value
            : null;
    } catch {
        return null;
    }
}
export function legalSourceViewerActions(metadata: ViewerMetadata) {
    return (
        [
            ["source", "View original source", metadata.url],
            ["pdf", "View authoritative PDF", metadata.pdfUrl],
        ] as const
    ).flatMap(([kind, label, value]) => {
        const href = safeExternalHref(value);
        return href ? [{ kind, label, href }] : [];
    });
}
function stripInlinePrefix(
    tokens: LegalSourceInlineToken[],
    strip: (text: string) => string,
) {
    const text = tokens.map((token) => token.text).join("");
    let remaining = text.length - strip(text).length;
    if (remaining <= 0) return tokens;
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
export function LegalInlineText({ tokens }: { tokens: LegalSourceInlineToken[] }) {
    return tokens.map((token, index) => {
        if (token.kind === "text") return token.text;
        const key = `${index}:${token.kind}`;
        if (token.kind !== "link") {
            return createElement(
                token.kind,
                {
                    key,
                    className:
                        token.kind === "code"
                            ? "rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.88em]"
                            : undefined,
                },
                token.text,
            );
        }
        const href = token.href.startsWith("#")
            ? token.href
            : safeExternalHref(token.href);
        if (!href) return token.text;
        const external = !href.startsWith("#");
        return (
            <a
                key={key}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                className="text-brand underline decoration-brand/35 underline-offset-2 hover:decoration-brand"
            >
                {token.text}
            </a>
        );
    });
}
const HEADING_CLASSES = {
    2: "mb-4 mt-10 border-b border-gray-300 pb-2 text-[1.5rem] font-semibold leading-tight text-gray-950 first:mt-0",
    3: "mb-3 mt-8 border-b-2 border-brand pb-1 text-[1.25rem] font-semibold leading-snug text-gray-950 first:mt-0",
    4: "mb-3 mt-7 border-l-4 border-brand pl-3 text-[1.1rem] font-semibold leading-snug text-gray-950 first:mt-0",
    5: "mb-2 mt-6 text-sm font-semibold uppercase leading-snug tracking-[0.08em] text-gray-800 first:mt-0",
} as const;
function LegalPresentedBlocks({ blocks, anchor }: {
    blocks: LegalSourcePresentationBlock[];
    anchor: ViewerAnchor | null;
}) {
    const nodes: ReactNode[] = [];
    let index = 0;
    const inline = (block: LegalSourcePresentationBlock, blockIndex: number) => {
        const anchored = blockIndex || !anchor
            ? block.inline
            : stripInlinePrefix(block.inline, (text) =>
                  stripDisplayedMarker(text, anchor),
              );
        return block.kind === "provision"
            ? stripInlinePrefix(anchored, (text) =>
                  text.replace(
                      new RegExp(
                          `^\\s*${escapeRegExp(block.label)}\\s*`,
                          "iu",
                      ),
                      "",
                  ),
              )
            : anchored;
    };
    while (index < blocks.length) {
        const block = blocks[index];
        if (block.kind === "list-item") {
            const ordered = block.ordered;
            const depth = block.depth;
            const start = index;
            while (index < blocks.length) {
                const item = blocks[index];
                if (item.kind !== "list-item" || item.ordered !== ordered || item.depth !== depth) break;
                index += 1;
            }
            const firstNumber = Number.parseInt(block.marker, 10);
            nodes.push(
                createElement(
                    ordered ? "ol" : "ul",
                    {
                        key: `list:${start}`,
                        className: `mb-4 space-y-1 pl-6 ${ordered ? "list-decimal" : "list-disc"}`,
                        style: { marginInlineStart: `${Math.min(depth, 4) * 0.75}rem` },
                        start: ordered && Number.isFinite(firstNumber) ? firstNumber : undefined,
                    },
                    blocks.slice(start, index).map((item, itemIndex) => (
                        <li key={`${item.kind}:${itemIndex}`} className="pl-1.5">
                            <LegalInlineText tokens={inline(item, start + itemIndex)} />
                        </li>
                    )),
                ),
            );
            continue;
        }
        const tokens = inline(block, index);
        const key = `${index}:${block.kind}`;
        if (block.kind === "provision" && !anchor) {
            nodes.push(
                <p
                    key={key}
                    className="mb-4 grid grid-cols-[minmax(2.4rem,auto)_minmax(0,1fr)] gap-x-3"
                    style={{ marginInlineStart: `${Math.min(block.depth, 4) * 0.75}rem` }}
                >
                    <span className="font-semibold text-gray-700">{block.label}</span>
                    <span><LegalInlineText tokens={tokens} /></span>
                </p>,
            );
        } else {
            const heading = block.kind === "heading";
            const quote = block.kind === "blockquote";
            nodes.push(
                createElement(
                    heading ? `h${block.level}` : quote ? "blockquote" : "p",
                    {
                        key,
                        className: heading
                            ? HEADING_CLASSES[block.level]
                            : quote
                              ? "mb-5 ml-1 border-l-4 border-gray-300 py-0.5 pl-5 text-gray-700"
                              : "mb-4 whitespace-pre-wrap [hyphens:none] [overflow-wrap:normal] [word-break:normal]",
                    },
                    <LegalInlineText tokens={tokens} />,
                ),
            );
        }
        index += 1;
    }
    return nodes;
}
export function LegalSourceViewer({
    referenceId,
    provider = "a2aj",
    citation,
    sourceId,
    docType = "auto",
    language = "en",
    dataset,
    quotes = EMPTY_QUOTES,
    citationRef,
    compact = false,
    caseTab,
}: LegalSourceViewerProps) {
    const caseClusterId = caseTab?.clusterId;
    const suppliedOpinions = caseTab?.opinions;
    const sourceKey =
        caseTab?.id ??
        [referenceId, provider, citation, sourceId, docType, language, dataset]
            .join("\0");
    const [loaded, setLoaded] = useState<
        [string, LegalSourceViewerPayload | CaseLawOpinion[] | string]
    >();
    const current = loaded?.[0] === sourceKey ? loaded[1] : undefined;
    const payload =
        current && typeof current !== "string" && !Array.isArray(current)
            ? current
            : null;
    const cachedOpinions = caseTab
        ? caseOpinionsCache.get(caseTab.clusterId)
        : undefined;
    const error = typeof current === "string" ? current : null;
    const [activeQuote, setActiveQuote] = useState(0);
    const [activeOpinionId, setActiveOpinionId] = useState<number | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (caseClusterId !== undefined && suppliedOpinions?.length) return;
        let cancelled = false;
        let request: Promise<LegalSourceViewerPayload | CaseLawOpinion[]>;
        if (caseClusterId !== undefined) {
            let caseRequest = caseOpinionsCache.get(caseClusterId);
            if (!caseRequest) {
                caseRequest = getCourtlistenerOpinions(caseClusterId);
                caseOpinionsCache.set(caseClusterId, caseRequest);
            }
            request = Promise.resolve(caseRequest);
        } else {
            request = referenceId
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
                  : Promise.reject(
                        new Error("Legal source reference is missing"),
                    );
        }
        void request
            .then((result) => {
                if (caseClusterId !== undefined && Array.isArray(result)) {
                    caseOpinionsCache.set(caseClusterId, result);
                }
                if (!cancelled) setLoaded([sourceKey, result]);
            })
            .catch((reason: unknown) => {
                if (caseClusterId !== undefined) {
                    caseOpinionsCache.delete(caseClusterId);
                }
                if (cancelled) return;
                const isCase = caseClusterId !== undefined;
                const message =
                    reason instanceof Error
                        ? reason.message
                        : isCase
                          ? "Failed to load case"
                          : "Could not load legal source";
                setLoaded([
                    sourceKey,
                    isCase ? friendlyCaseError(message) : message,
                ]);
            });
        return () => { cancelled = true; };
    }, [caseClusterId, citation, dataset, docType, language, provider, referenceId, sourceId, sourceKey, suppliedOpinions]);
    const [slices, presentation] = useMemo(
        () => [
            payload ? buildLegalSourceViewerSlices(payload) : [],
            new Map<string, LegalSourcePresentationBlock[]>(
                payload?.presentation?.segments.map((segment) => [
                    `${segment.start}:${segment.end}`,
                    segment.blocks,
                ]) ?? [],
            ),
        ] as const,
        [payload],
    );
    const displayedOpinions = caseTab
        ? suppliedOpinions?.length
            ? suppliedOpinions
            : Array.isArray(cachedOpinions)
              ? cachedOpinions
              : Array.isArray(current)
                ? current
                : undefined
        : undefined;
    const orderedOpinions = useMemo(() => orderOpinions(displayedOpinions ?? []), [displayedOpinions]);
    const activeOpinion =
        displayedOpinions?.find((opinion) => opinion.opinionId === activeOpinionId)
        ?? orderedOpinions[0]?.opinion;
    const sourceQuotes = caseTab?.quotes ?? quotes;
    const quoteItems = sourceQuotes.map((quote, index) => {
        const caseQuote = caseTab?.quotes?.[index];
        return {
            id: `legal-quote-${index}`,
            quote: quote.quote,
            eyebrow:
                caseQuote && (caseQuote.author || caseQuote.type)
                    ? opinionTitle(caseQuote)
                    : null,
        };
    });
    useEffect(() => {
        const root = contentRef.current;
        if (!root || (!payload && !activeOpinion)) return;
        clearDocxQuoteHighlights(root);
        const quote = sourceQuotes[activeQuote]?.quote;
        if (!quote) return;
        const match = highlightDocxQuote(root, quote);
        if (match) window.setTimeout(
            () => match.scrollIntoView({ behavior: "smooth", block: "center" }),
            40,
        );
    }, [activeOpinion, activeQuote, payload, sourceQuotes]);
    useEffect(() => {
        if (!payload || !window.location.hash) return;
        const label = decodeURIComponent(window.location.hash.slice(1))
            .replace(/^legal-/u, "");
        if (!label) return;
        window.requestAnimationFrame(() =>
            contentRef.current
                ?.querySelector<HTMLElement>(`#${legalSourceAnchorId(label)}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
    }, [payload]);
    if (!payload && !caseTab) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                {error ? (
                    <p className="max-w-md rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                        {error}</p>
                ) : (
                    <ThinkingSpinner label="Loading legal source" size={24} />
                )}
            </div>
        );
    }
    const metadata: ViewerMetadata = payload?.metadata ?? {
        title: caseTab?.caseName || caseTab?.citation || "Decision",
        citation: caseTab?.citation ?? "",
        alternateCitation: null,
        date: caseTab?.dateFiled ?? null,
        dataset: "CourtListener",
        url: caseTab?.url ?? null,
        pdfUrl: caseTab?.pdfUrl ?? null,
        language: "en",
    };
    const kindLabel = legalSourceKindLabel(payload?.reference.docType);
    const actions = legalSourceViewerActions(metadata);
    const details = (
        caseTab
            ? [formatCaseDate(metadata.date)]
            : [
                  metadata.dataset,
                  metadata.date?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0] ??
                      metadata.date,
                  metadata.language.toUpperCase(),
              ]
    ).filter(Boolean);
    const selectQuote = (index: number) => {
        setActiveQuote(index);
        const opinionId = caseTab?.quotes?.[index]?.opinionId;
        if (typeof opinionId === "number") setActiveOpinionId(opinionId);
    };
    const selectOpinion = (opinion: CaseLawOpinion) => {
        setActiveOpinionId(opinion.opinionId);
        const index = caseTab?.quotes?.findIndex(
            (quote) => quote.opinionId === opinion.opinionId,
        );
        if (index !== undefined && index >= 0) setActiveQuote(index);
    };
    return (
        <div className="flex h-full min-h-0 flex-col bg-white">
            <header
                className={`shrink-0 border-b border-gray-200 bg-white ${
                    compact ? "px-4 py-3" : "px-5 py-4 sm:px-8"
                }`}
            >
                <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-x-5 gap-y-3">
                    <div className="min-w-0 flex-1 basis-80">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
                            {kindLabel}</p>
                        <h1 className="text-xl font-semibold leading-tight text-gray-950 sm:text-2xl">
                            {metadata.title}</h1>
                        <p className="mt-1 text-sm italic leading-snug text-gray-600">
                            {metadata.citation}
                            {metadata.alternateCitation
                                ? ` / ${metadata.alternateCitation}`
                                : ""}
                        </p>
                        {!!details.length && <p className="mt-2 text-xs text-gray-500">{details.join(" · ")}</p>}
                    </div>
                    {!!actions.length && (
                        <nav aria-label="Source links" className="flex max-w-full flex-wrap items-center gap-2">
                            {actions.map((action) => (
                                <a
                                    key={`${action.kind}:${action.href}`}
                                    href={action.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`inline-flex h-8 items-center justify-center whitespace-nowrap rounded border px-3 text-xs font-medium ${
                                        action.kind === "source"
                                            ? "border-brand bg-brand text-white hover:bg-brand/90"
                                            : "border-gray-300 bg-white text-gray-800 hover:border-brand hover:text-brand"
                                    }`}
                                >
                                    {action.label}
                                    <ExternalLink aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
                                </a>
                            ))}
                        </nav>
                    )}
                </div>
            </header>
            {quoteItems.length > 0 && (
                <div className="shrink-0 py-2">
                    <CitationQuotesHeader
                        quotes={quoteItems}
                        currentIndex={activeQuote}
                        activeQuoteId={quoteItems[activeQuote]?.id}
                        citationRef={citationRef ?? caseTab?.citationRef}
                        citationText={metadata.citation}
                        onSelect={(_quote, index) => selectQuote(index)}
                        onIndexChange={selectQuote}
                    />
                </div>
            )}
            {caseTab && orderedOpinions.length > 1 && (
                <div className="shrink-0 border-b border-gray-200 px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                        {orderedOpinions.map(({ opinion, index }) => (
                            <button
                                key={opinion.opinionId ?? index}
                                type="button"
                                disabled={opinion.opinionId === null}
                                onClick={() => selectOpinion(opinion)}
                                className={`flex h-8 max-w-[180px] items-center rounded-md border px-3 text-[13px] ${
                                    opinion === activeOpinion
                                        ? "border-gray-400 bg-white text-gray-900"
                                        : "border-transparent bg-gray-100 text-gray-600 hover:border-gray-300 hover:bg-white"
                                } disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                                <span className="truncate">{opinionTitle(opinion, index)}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {payload?.truncated && (
                <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                    This unusually long source is displayed through the first five million characters.
                </p>
            )}
            <div
                ref={contentRef}
                className="min-h-0 flex-1 overflow-y-auto scroll-smooth bg-[#faf9f6] px-4 py-8 sm:px-8 sm:py-10"
            >
                {caseTab ? (
                    error && !displayedOpinions?.length ? (
                        <p className="mx-auto max-w-[48rem] rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                            {error}
                        </p>
                    ) : !displayedOpinions ? (
                        <div className="flex h-full items-center justify-center">
                            <ThinkingSpinner label="Loading case law" size={24} />
                        </div>
                    ) : activeOpinion ? (
                        <OpinionBlock opinion={activeOpinion} />
                    ) : (
                        <p className="mx-auto max-w-[48rem] text-sm text-gray-500">
                            No opinions were returned for this case.</p>
                    )
                ) : (
                    <article
                        lang={metadata.language}
                        className="mx-auto max-w-[48rem] font-sans text-[17px] leading-[1.68] text-gray-900"
                    >
                        {slices.map((slice) => {
                        const page = slice.anchors.find((anchor) => anchor.kind === "page");
                        const marker =
                            slice.primary && slice.primary.kind !== "page"
                                ? locatorLabel(slice.primary.label)
                                : null;
                        const blocks = presentation.get(slice.key);
                        return (
                            <section
                                key={slice.key}
                                id={slice.primary ? legalSourceAnchorId(slice.primary.label) : undefined}
                                className={`scroll-mt-4 ${slice.text ? `mb-1 grid gap-x-4 ${marker ? "grid-cols-[2.7rem_minmax(0,1fr)]" : "grid-cols-1"}` : ""}`}
                                style={{
                                    contentVisibility: "auto",
                                    containIntrinsicSize: "auto 150px",
                                    marginInlineStart: payload?.reference.docType === "laws"
                                        ? `${Math.min(slice.depth, 4) * 0.8}rem` : undefined,
                                }}
                            >
                                {slice.anchors
                                    .filter((anchor) => anchor !== slice.primary)
                                    .map((anchor) => (
                                        <span
                                            key={anchor.label} id={legalSourceAnchorId(anchor.label)}
                                            className="col-span-full block scroll-mt-4"
                                            aria-hidden="true" />
                                    ))}
                                {page && (
                                    <div
                                        role="doc-pagebreak" aria-label={locatorLabel(page.label)}
                                        className="col-span-full mb-7 mt-10 border-t border-gray-300 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500 first:mt-0"
                                    >
                                        {locatorLabel(page.label)}</div>
                                )}
                                {slice.text && (
                                    <>
                                        {marker && (
                                            <span className="pt-[0.23rem] text-right text-xs font-semibold text-gray-600">
                                                {marker}</span>
                                        )}
                                        <div className="min-w-0">
                                            <LegalPresentedBlocks
                                                blocks={blocks ?? [{
                                                    kind: "paragraph", text: slice.text,
                                                    inline: [{ kind: "text", text: slice.text }], depth: 0,
                                                }]}
                                                anchor={slice.primary}
                                            />
                                        </div>
                                    </>
                                )}
                            </section>
                        );
                        })}
                    </article>
                )}
            </div>
        </div>
    );
}
function OpinionBlock({ opinion }: { opinion: CaseLawOpinion }) {
    const html = useMemo(
        () => (opinion.html ? sanitizeCaseHtml(opinion.html) : ""),
        [opinion.html],
    );
    return (
        <article className="case-opinion-content mx-auto max-w-[48rem] font-serif text-[17px] leading-7 text-gray-900">
            <h2 className="mb-4 text-lg font-semibold">
                {opinionTitle(opinion)}
            </h2>
            {html ? (
                <div
                    className="prose prose-sm max-w-none [&_*]:font-serif [&_.case-page-number]:mx-1 [&_.case-page-number]:text-xs [&_.case-page-number]:text-gray-400 [&_a]:text-blue-600 [&_a]:underline [&_a:hover]:text-blue-700 [&_p]:my-3"
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            ) : (
                <div className="whitespace-pre-wrap">
                    {opinion.text || "No opinion text returned."}
                </div>
            )}
        </article>
    );
}
