import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CitationQuotesHeader } from "@/app/components/assistant/CitationQuotesHeader";
import { GfmMarkdown } from "@/app/components/assistant/message/MarkdownContent";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";
import {
  clearDocxQuoteHighlights,
  highlightDocxQuotes,
} from "@/app/components/shared/views/highlightDocxQuote";
import {
  getDirectLegalSourceDocument,
  getLegalSourceDocument,
  type LegalDocumentType,
  type LegalSourceViewerPayload,
} from "@/app/lib/beaverApi";
import { safeAssistantUrl } from "@/app/lib/assistantSession";
import { formatLongDate } from "@/app/lib/utils";

type Anchor = LegalSourceViewerPayload["slices"][number]["anchors"][number];
type Metadata = LegalSourceViewerPayload["metadata"];
const EMPTY_QUOTES: { quote: string }[] = [];

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
  initialLocator?: string | null;
  quotes?: { quote: string }[];
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
  initialLocator?: string | null;
};

export function legalSourceKindLabel(docType?: LegalDocumentType) {
  if (docType === "laws") return "Legislation";
  if (docType === "articles") return "Journal article";
  return "Decision";
}

function legalSourceAnchorId(label: string) {
  return `legal-${label.replace(/[^a-z0-9_.-]+/giu, "-")}`;
}

export function legalSourceLocatorFromUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    return decodeURIComponent(new URL(value).hash.slice(1))
      .match(/^((?:par|sec)\d[^:]*)/iu)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function normalizeLegalSourceLocator(value: string | null | undefined) {
  const locator = value?.trim();
  if (!locator) return null;
  const paragraph = locator.match(/^para(?:graph)?s?\.?\s*(\d+)/iu)?.[1];
  return paragraph ? `par${paragraph}` : locator.match(/^par\d+/iu)?.[0] ?? locator;
}

function locatorLabel(label: string) {
  if (label.startsWith("page")) return `Page ${label.slice(4)}`;
  if (label.startsWith("par")) return `[${label.slice(3)}]`;
  if (label.startsWith("fn")) return `Footnote ${label.slice(2)}`;
  return label.startsWith("sec") ? label.slice(3) : label;
}

export function legalSourceViewerActions(metadata: Metadata) {
  return ([
    ["source", "Site", metadata.url],
    ["pdf", "PDF", metadata.pdfUrl],
  ] as const).flatMap(([kind, label, value]) => {
    const href = safeAssistantUrl(value, { relative: false });
    return href ? [{ kind, label, href }] : [];
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripMarker(text: string, anchor: Anchor | null) {
  if (anchor?.kind === "paragraph") {
    const label = escapeRegExp(anchor.label.slice(3));
    return text.replace(new RegExp(`^\\s*(?:\\[\\s*${label}\\s*\\]|${label}\\.)\\s*`, "u"), "");
  }
  if (anchor?.kind === "section") {
    const label = anchor.label.slice(3);
    const stripped = text.replace(new RegExp(`^\\s*${escapeRegExp(label).replace(/\\\(/gu, "\\s*\\(")}\\s*`, "iu"), "");
    if (stripped !== text) return stripped;
    const child = label.match(/(\([^)]+\))$/u)?.[1];
    return child
      ? text.replace(new RegExp(`^\\s*${escapeRegExp(child)}\\s*`, "iu"), "")
      : text;
  }
  return text;
}

const HEADING_CLASSES = {
  2: "mb-4 mt-10 border-b border-gray-300 pb-2 text-[1.5rem] font-semibold leading-tight text-gray-950 first:mt-0",
  3: "mb-3 mt-8 border-b-2 border-brand pb-1 text-[1.25rem] font-semibold leading-snug text-gray-950 first:mt-0",
  4: "mb-3 mt-7 border-l-4 border-brand pl-3 text-[1.1rem] font-semibold leading-snug text-gray-950 first:mt-0",
  5: "mb-2 mt-6 text-sm font-semibold uppercase leading-snug tracking-[0.08em] text-gray-800 first:mt-0",
} as const;

function LegalMarkdown({ children }: { children: string }) {
  return (
    <GfmMarkdown
      skipHtml
      components={{
        h1: ({ children }) => <h2 className={HEADING_CLASSES[2]}>{children}</h2>,
        h2: ({ children }) => <h2 className={HEADING_CLASSES[2]}>{children}</h2>,
        h3: ({ children }) => <h3 className={HEADING_CLASSES[3]}>{children}</h3>,
        h4: ({ children }) => <h4 className={HEADING_CLASSES[4]}>{children}</h4>,
        h5: ({ children }) => <h5 className={HEADING_CLASSES[5]}>{children}</h5>,
        h6: ({ children }) => <h5 className={HEADING_CLASSES[5]}>{children}</h5>,
        p: ({ children }) => (
          <p className="mb-4 whitespace-pre-wrap [hyphens:none] [overflow-wrap:normal] [word-break:normal]">
            {children}
          </p>
        ),
        ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
        ol: ({ children, start }) => <ol start={start} className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
        li: ({ children }) => <li className="pl-1.5">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="mb-5 ml-1 border-l-4 border-gray-300 py-0.5 pl-5 text-gray-700">
            {children}
          </blockquote>
        ),
        code: ({ children }) => (
          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.88em]">
            {children}
          </code>
        ),
        a: ({ href, children }) => {
          const link = href?.startsWith("#")
            ? href
            : safeAssistantUrl(href, { relative: false });
          if (!link) return <>{children}</>;
          const external = !link.startsWith("#");
          return (
            <a
              href={link}
              target={external ? "_blank" : undefined}
              rel={external ? "noopener noreferrer" : undefined}
              className="text-brand underline decoration-brand/35 underline-offset-2 hover:decoration-brand"
            >
              {children}
            </a>
          );
        },
      }}
    >
      {children}
    </GfmMarkdown>
  );
}

function viewerMarkdown(
  text: string,
  anchor: Anchor | null,
  docType: LegalDocumentType,
  start: number,
) {
  let result = text;
  if (docType === "cases" && start === 0) {
    const marker = result.match(/\bDecision Content\b\s*/iu);
    if (marker?.index !== undefined) {
      result = result.slice(marker.index + marker[0].length)
        .split(/\n/gu)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n\n");
    }
  }
  return stripMarker(result, anchor);
}

function scrollTo(root: HTMLElement, target: HTMLElement, top = false) {
  const rootBox = root.getBoundingClientRect();
  const targetBox = target.getBoundingClientRect();
  root.scrollTop += targetBox.top - rootBox.top - (top ? 16 : 32);
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
  initialLocator,
}: LegalSourceViewerProps) {
  const sourceKey = [referenceId, provider, citation, sourceId, docType, language, dataset].join("\0");
  const [result, setResult] = useState<[string, LegalSourceViewerPayload | Error]>();
  const current = result?.[0] === sourceKey ? result[1] : undefined;
  const payload = current && !(current instanceof Error) ? current : null;
  const error = current instanceof Error ? current.message : null;
  const [quoteIndex, setQuoteIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const locator = normalizeLegalSourceLocator(initialLocator);

  useEffect(() => {
    let live = true;
    const request = referenceId
      ? getLegalSourceDocument(referenceId)
      : citation
        ? getDirectLegalSourceDocument({ provider, citation, sourceId, docType, language, dataset })
        : Promise.reject(new Error("Legal source reference is missing"));
    void request.then((value) => {
      if (!live) return;
      setResult([sourceKey, value]);
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : "Could not load source";
      if (live) setResult([sourceKey, new Error(message)]);
    });
    return () => { live = false; };
  }, [citation, dataset, docType, language, provider, referenceId, sourceId, sourceKey]);

  const slices = payload?.slices ?? [];
  useLayoutEffect(() => {
    if (!root.current || !payload) return;
    clearDocxQuoteHighlights(root.current);
    const match = highlightDocxQuotes(root.current, quotes.map(({ quote }) => quote))[quoteIndex];
    if (match) scrollTo(root.current, match);
  }, [payload, quoteIndex, quotes]);

  useEffect(() => {
    if (!payload || !root.current) return;
    const targetLocator = locator ?? decodeURIComponent(window.location.hash.slice(1)).replace(/^legal-/u, "");
    if (!targetLocator) return;
    const frame = requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(`#${legalSourceAnchorId(targetLocator)}`);
      if (root.current && target) scrollTo(root.current, target, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [locator, payload]);

  if (!payload) {
    return <div className="grid h-full place-items-center p-6">
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : <ThinkingSpinner label="Loading legal source" size={24} />}
    </div>;
  }

  const metadata: Metadata = payload.metadata;
  const details = [
    metadata.title !== metadata.citation ? metadata.citation : null,
    metadata.alternateCitation,
    formatLongDate(metadata.date),
  ].filter(Boolean).join(" · ");
  const actions = legalSourceViewerActions(metadata);
  const quoteItems = quotes.map((quote, index) => ({
    id: `legal-quote-${index}`,
    quote: quote.quote,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className={`shrink-0 border-b border-gray-200 bg-white ${
        compact ? "px-4 py-3" : "px-5 py-4 sm:px-8"
      }`}>
        <div className="mx-auto max-w-5xl">
          <div className="flex min-w-0 items-start gap-3">
            <h1 className={`min-w-0 flex-1 ${compact
              ? "text-base font-semibold leading-tight text-gray-950"
              : "text-xl font-semibold leading-tight text-gray-950 sm:text-2xl"}`}>
              {metadata.title}
            </h1>
            {!!actions.length && <nav aria-label="Source links" className="flex shrink-0 items-center gap-2">
              {actions.map(({ kind, label, href }) => (
                <a key={`${kind}:${href}`} href={href} target="_blank"
                  rel="noopener noreferrer" aria-label={label} title={label}
                  className={`inline-flex h-8 items-center justify-center whitespace-nowrap rounded border px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 ${kind === "pdf"
                    ? "border-red-200 bg-red-50 text-red-700 hover:border-red-400 hover:bg-red-100"
                    : "border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100"}`}>
                  {label}
                </a>
              ))}
            </nav>}
          </div>
          {details && <p className={`${compact ? "mt-1 text-xs leading-5" : "mt-2 text-sm leading-5"} truncate whitespace-nowrap text-gray-600`} title={details}>
            {details}
          </p>}
        </div>
      </header>
      {!!quoteItems.length && !compact && (
        <div className="shrink-0 py-2">
          <CitationQuotesHeader
            quotes={quoteItems}
            currentIndex={quoteIndex}
            activeQuoteId={quoteItems[quoteIndex]?.id}
            citationRef={citationRef}
            citationText={metadata.citation}
            onSelect={(_quote, index) => setQuoteIndex(index)}
            onIndexChange={setQuoteIndex}
          />
        </div>
      )}
      {payload?.truncated && <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        This unusually long source is displayed through the first five million characters.
      </p>}
      <div ref={root} className="min-h-0 flex-1 overflow-y-auto bg-[#faf9f6] px-4 py-8 sm:px-8 sm:py-10">
        <article lang={metadata.language} className="mx-auto max-w-[48rem] font-sans text-[17px] leading-[1.68] text-gray-900">
            {slices.map((slice) => {
              const page = slice.primary?.kind === "page"
                ? slice.primary
                : slice.anchors.find(({ kind }) => kind === "page");
              const marker = slice.primary?.kind !== "page" && slice.primary
                ? locatorLabel(slice.primary.label)
                : null;
              return (
                <section
                  key={`${slice.start}:${slice.end}`}
                  id={slice.primary ? legalSourceAnchorId(slice.primary.label) : undefined}
                  className={`scroll-mt-4 ${slice.text ? `mb-1 grid gap-x-4 ${marker ? "grid-cols-[2.7rem_minmax(0,1fr)]" : "grid-cols-1"}` : ""}`}
                  style={{
                    contentVisibility: locator ? "visible" : "auto",
                    containIntrinsicSize: "auto 150px",
                    marginInlineStart: payload?.reference.docType === "laws"
                      ? `${Math.min(slice.depth, 4) * 0.8}rem`
                      : undefined,
                  }}
                >
                  {slice.anchors.map((anchor) => (
                    <span key={anchor.label} id={legalSourceAnchorId(anchor.label)}
                      className="col-span-full block scroll-mt-4" aria-hidden="true" />
                  ))}
                  {page && <div role="doc-pagebreak" aria-label={locatorLabel(page.label)}
                    className="col-span-full mb-7 mt-10 border-t border-gray-300 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500 first:mt-0">
                    {locatorLabel(page.label)}
                  </div>}
                  {marker && <span className="pt-[0.23rem] text-right text-xs font-semibold text-gray-600">{marker}</span>}
                  <div className="min-w-0 [&_li>p]:mb-0">
                    <LegalMarkdown>
                      {viewerMarkdown(
                        slice.text,
                        slice.primary,
                        payload.reference.docType,
                        slice.start,
                      )}
                    </LegalMarkdown>
                  </div>
                </section>
              );
            })}
        </article>
      </div>
    </div>
  );
}
