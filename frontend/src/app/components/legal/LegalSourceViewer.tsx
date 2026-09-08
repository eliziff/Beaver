import { ReaderExpandButton } from "../shared/ReaderExpandButton";
import { useReaderExpansion } from "../shared/useReaderExpansion";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PanelsTopLeft } from "lucide-react";
import { CitationQuotesHeader } from "@/app/components/assistant/CitationQuotesHeader";
import { GfmMarkdown } from "@/app/components/assistant/message/MarkdownContent";
import { ThinkingSpinner } from "@/app/components/chat/thinking-spinner";
import {
  highlightDocxQuotes,
} from "@/app/components/shared/views/highlightDocxQuote";
import {
  getDirectLegalSourceDocument,
  getLegalSourceDocument,
  type LegalDocumentType,
  type LegalSourceViewerPayload,
} from "@/app/lib/api/legalSources";
import { researchSourceKey } from "@/app/lib/researchFiles";
import type {
  ResearchFile,
  PassageLocator,
  ResearchSourceReference,
} from "@/app/lib/researchFiles";
import { normalizeQuoteText, strippedToOriginal } from "@/app/components/shared/views/quoteText";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { errorMessage, formatLongDate } from "@/app/lib/utils";
import { ResearchLabelEditor, ResearchLabelPicker,
  type ResearchLabelTarget } from "./ResearchLabelPicker";
import { SourcesWorkspace, useSourcesWorkspace, type HighlightCapture } from "./SourcesWorkspace";
import { RESEARCH_PASSAGE_REFERENCE_DRAG } from "./researchMemo";

type Anchor = LegalSourceViewerPayload["slices"][number]["anchors"][number];
type Metadata = LegalSourceViewerPayload["metadata"];
type ResearchLocator = PassageLocator;
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
  researchFileId?: string | null;
  researchSourceId?: string | null;
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
  researchFileId?: string | null;
  researchSourceId?: string | null;
  projectId?: string;
  onOpenResearch?: (intent?: "source-drop") => void;
};

function legalSourceAnchorId(label: string) {
  return `legal-${(normalizeLegalSourceLocator(label) ?? label).replace(/[^a-z0-9_.-]+/giu, "-")}`;
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

/** One pinpoint form everywhere: "para 44", "par44" and the block label "44" name the same anchor,
 *  so a chat chip, a search result and a saved passage all land on the same place in the reader. */
export function normalizeLegalSourceLocator(value: string | null | undefined) {
  const locator = value?.trim();
  if (!locator) return null;
  return locator.match(/^(?:par(?:a(?:graph)?)?|sec(?:tion)?)s?\.?\s*(\d+)$/iu)?.[1] ?? locator;
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

const LEGAL_MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h2 className={HEADING_CLASSES[2]}>{children}</h2>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className={HEADING_CLASSES[2]}>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className={HEADING_CLASSES[3]}>{children}</h3>,
  h4: ({ children }: { children?: React.ReactNode }) => <h4 className={HEADING_CLASSES[4]}>{children}</h4>,
  h5: ({ children }: { children?: React.ReactNode }) => <h5 className={HEADING_CLASSES[5]}>{children}</h5>,
  h6: ({ children }: { children?: React.ReactNode }) => <h5 className={HEADING_CLASSES[5]}>{children}</h5>,
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-4 whitespace-pre-wrap [hyphens:none] [overflow-wrap:normal] [word-break:normal]">
      {children}
    </p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children, start }: { children?: React.ReactNode; start?: number }) => <ol start={start} className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="pl-1.5">{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="mb-5 ml-1 border-l-4 border-gray-300 py-0.5 pl-5 text-gray-700">
      {children}
    </blockquote>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.88em]">
      {children}
    </code>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
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
};
function LegalMarkdown({ children }: { children: string }) {
  return (
    <GfmMarkdown
      skipHtml
      components={LEGAL_MARKDOWN_COMPONENTS}
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

type SelectionTarget = { locator: ResearchLocator; quote: string };

function sectionForNode(node: Node, root: HTMLElement) {
  const element = node instanceof Element ? node : node.parentElement;
  const section = element?.closest<HTMLElement>("[data-legal-block]") ?? null;
  return section && root.contains(section) ? section : null;
}

export function legalPassageTargetFromSelection(
  root: HTMLElement,
  selection: Selection | null,
): SelectionTarget | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = sectionForNode(range.startContainer, root);
  const end = sectionForNode(range.endContainer, root);
  const kind = start?.dataset.locatorKind as ResearchLocator["kind"] | undefined;
  const value = start?.dataset.locatorValue;
  const endValue = end?.dataset.locatorValue;
  if (!start || !end || !kind || !value) return null;
  const quote = selection.toString().replace(/\s+/gu, " ").trim();
  if (!quote) return null;
  return {
    locator: { kind, value, ...(endValue && endValue !== value ? { endValue } : {}) },
    quote,
  };
}

type Slice = LegalSourceViewerPayload["slices"][number];

/**
 * The reader renders the slices of one served revision, so what is rendered maps back to an
 * offset in it. Rendering drops paragraph markers, markdown syntax and layout whitespace but
 * never reorders letters or digits, so their run aligns a rendered block with its canonical
 * text and any position inside it becomes an exact canonical offset.
 */
function sliceBody(node: Node, root: HTMLElement) {
  const element = node instanceof Element ? node : node.parentElement;
  const body = element?.closest<HTMLElement>("[data-legal-text]") ?? null;
  return body && root.contains(body) ? body : null;
}

function alignment(body: HTMLElement, slices: Slice[]) {
  const slice = slices[Number(body.dataset.legalText)] as Slice | undefined;
  const rendered = slice ? normalizeQuoteText(body.textContent ?? "") : "";
  if (!slice || !rendered) return null;
  const base = Math.max(0, normalizeQuoteText(slice.text).indexOf(rendered));
  return { slice, rendered, at: (index: number) => slice.start + strippedToOriginal(slice.text, base + index) };
}

/** The canonical span of a whole rendered block, marker and page rule excluded. */
export function legalBlockSpan(body: HTMLElement, slices: Slice[]) {
  const found = alignment(body, slices);
  return found && { start: found.at(0), end: found.at(found.rendered.length - 1) + 1 };
}

/** The canonical span of the current selection in the reader. */
export function legalSelectionSpan(root: HTMLElement, selection: Selection | null, slices: Slice[]) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const edge = (node: Node, offset: number, trailing: boolean) => {
    const body = sliceBody(node, root), found = body && alignment(body, slices);
    if (!body || !found) return null;
    const upto = document.createRange();
    upto.selectNodeContents(body); upto.setEnd(node, offset);
    const count = normalizeQuoteText(upto.toString()).length;
    if (trailing) return count ? found.at(count - 1) + 1 : null;
    return found.at(Math.min(count, found.rendered.length - 1));
  };
  const start = edge(range.startContainer, range.startOffset, false),
    end = edge(range.endContainer, range.endOffset, true);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

export function LegalSourceViewer(props: LegalSourceViewerProps) {
  return <SourcesWorkspace fileId={props.researchFileId} projectId={props.projectId}>
    <LegalSourceViewerContent {...props} />
  </SourcesWorkspace>;
}

function LegalSourceViewerContent({
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
  researchSourceId,
  onOpenResearch,
}: LegalSourceViewerProps) {
  const { file: researchFile, mutations: commit, loading: researchLoading, error: workspaceError,
    passages, highlight } = useSourcesWorkspace();
  const sourceKey = [referenceId, provider, citation, sourceId, docType, language, dataset].join("\0");
  const [result, setResult] = useState<[string, LegalSourceViewerPayload | Error]>();
  const current = result?.[0] === sourceKey ? result[1] : undefined;
  const payload = current && !(current instanceof Error) ? current : null;
  const error = current instanceof Error ? current.message : null;
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [localResearchError, setResearchError] = useState("");
  const researchError = localResearchError || workspaceError;
  const [labelTarget, setLabelTarget] = useState<ResearchLabelTarget | null>(null);
  const readerRoot = useRef<HTMLDivElement>(null);
  const readerExpansion = useReaderExpansion(readerRoot);
  const root = useRef<HTMLDivElement>(null), highlightMatches = useRef<Array<HTMLElement | null>>([]);
  const sourcePreparation = useRef<Promise<{ file: ResearchFile; itemId: string }> | null>(null);
  const locator = normalizeLegalSourceLocator(initialLocator);

  useEffect(() => { sourcePreparation.current = null; },
    [researchFile?.document.id, sourceKey]);

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
  const payloadReference: ResearchSourceReference | null = payload ? {
    provider: payload.reference.provider, id: payload.reference.id, kind: payload.reference.kind,
    title: payload.metadata.title, citation: payload.metadata.citation,
    alternateCitation: payload.metadata.alternateCitation, date: payload.metadata.date,
    collection: payload.reference.dataset ?? dataset ?? null,
    language: payload.reference.language, url: payload.metadata.url,
  } : null;
  const researchSource = researchFile ? researchSourceId
    ? researchFile.state.sources[researchSourceId]
    : payloadReference ? Object.values(researchFile.state.sources).find(({ reference }) =>
      researchSourceKey(reference) === researchSourceKey(payloadReference)) : undefined
    : null;
  const activeResearchSourceId = researchSource?.id;
  const passagePage = activeResearchSourceId ? passages.chains[activeResearchSourceId] : undefined;
  useEffect(() => {
    if (!activeResearchSourceId) return;
    if (!passagePage) void passages.fetchPage(activeResearchSourceId, null, false);
    else if (!passagePage.loading && !passagePage.error && passagePage.nextCursor)
      void passages.fetchPage(activeResearchSourceId, passagePage.nextCursor, true);
  }, [activeResearchSourceId, passagePage, passages.fetchPage]);
  const savedPassages = useMemo(() => passagePage?.items.flatMap((item) =>
    item.kind === "passage" ? [item.value] : []) ?? [], [passagePage?.items]);
  const researchLabels = researchFile?.state.labels;
  useEffect(() => {
    if (passagePage?.error) setResearchError(errorMessage(
      passagePage.error, "Could not load saved highlights"));
  }, [passagePage?.error]);
  useLayoutEffect(() => {
    if (!root.current || !payload) return;
    const quoteTexts = quotes.map(({ quote }) => quote);
    highlightMatches.current = highlightDocxQuotes(root.current, [...quoteTexts,
      ...savedPassages.map(({ receipt }) => ({ quote: receipt.span_text ?? "",
        locator: receipt.locator.label }))]);
    root.current.querySelectorAll<HTMLElement>("[data-qspan]").forEach((span) => {
      const item = savedPassages[Number(span.dataset.qspan) - quoteTexts.length];
      if (!item) return;
      const color = researchLabels?.[item.labelIds[0]]?.color ?? "#eab308";
      const category = researchLabels?.[item.labelIds[0]]?.name ?? "Highlight";
      span.style.setProperty("background-color", /^#[\da-f]{6}$/iu.test(color)
        ? `${color}59` : color, "important");
      span.style.setProperty("border-bottom", `3px solid ${color}`);
      span.dataset.researchEvidence = item.receipt.evidence_id;
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      span.setAttribute("aria-label", `${category} saved highlight. Edit type and note.`);
      span.title = `${category} saved highlight - activate to edit`;
      span.classList.add("cursor-pointer", "focus-visible:outline", "focus-visible:outline-2",
        "focus-visible:outline-offset-2", "focus-visible:outline-gray-900");
    });
  }, [payload, quotes, researchLabels, savedPassages]);
  useLayoutEffect(() => {
    if (!root.current || !payload) return;
    const match = quotes.length ? highlightMatches.current[quoteIndex] : null;
    if (match) scrollTo(root.current, match);
  }, [payload, quoteIndex, quotes.length, savedPassages]);

  const consumed = useRef(false), wholeBlock = useRef<HTMLElement | null>(null);
  const capture = useRef<() => HighlightCapture | null>(() => null);
  capture.current = () => {
    const reference = payloadReference, block = wholeBlock.current, revision = payload?.reference.sourceSha256;
    wholeBlock.current = null;
    if (!reference || !revision || !root.current) return null;
    const span = block ? legalBlockSpan(block, slices)
      : legalSelectionSpan(root.current, window.getSelection(), slices);
    return span ? { reference, revision, ...span } : null;
  };
  const { registerReader, arm } = highlight;
  useEffect(() => {
    registerReader(() => capture.current());
    return () => registerReader(null);
  }, [registerReader]);
  useEffect(() => {
    if (!highlight.armed) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") arm(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [highlight.armed, arm]);
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
  const sourceReference = payloadReference!;
  const needResearchFile = () => {
    onOpenResearch?.(); setResearchError("Choose or create a workspace first");
  };
  const runHighlight = () => {
    if (!researchFile) { wholeBlock.current = null; return needResearchFile(); }
    setResearchError("");
    void highlight.run().catch((reason: unknown) =>
      setResearchError(errorMessage(reason, "Could not save this highlight")));
  };
  async function prepareResearchSource(file: ResearchFile) {
    const existing = Object.values(file.state.sources).find(({ reference }) =>
      researchSourceKey(reference) === researchSourceKey(sourceReference));
    if (existing) return { file, itemId: existing.id };
    const pending = sourcePreparation.current ??= commit.act({ type: "source", reference: sourceReference }).then((next) => {
      if (!next.sourceId) throw new Error("Saved source was not returned");
      return { file: next, itemId: next.sourceId };
    });
    try { return await pending; }
    finally { if (sourcePreparation.current === pending) sourcePreparation.current = null; }
  }
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

  async function savePassage(passage: SelectionTarget, ready: { file: ResearchFile; itemId: string }) {
    {
      const next = await commit.act({
        type: "passage", sourceId: ready.itemId, quote: passage.quote });
      window.getSelection()?.removeAllRanges();
      if (!next.evidenceId) throw new Error("Saved passage was not returned");
      return { file: next, itemId: next.evidenceId,
        sourceId: next.sourceId ?? ready.itemId };
    }
  }
  function labelPassage(passage: SelectionTarget,
    saved?: (typeof savedPassages)[number], anchor?: HTMLElement | DOMRect,
    returnFocus?: HTMLElement) {
    if (!researchFile) return needResearchFile();
    setResearchError("");
    setLabelTarget({ file: researchFile, itemId: saved?.receipt.evidence_id ?? "",
      sourceId: saved?.sourceId ?? activeResearchSourceId,
      prepare: saved ? undefined : async (file) => savePassage(passage, activeResearchSourceId
        ? { file, itemId: activeResearchSourceId } : await prepareResearchSource(file)),
      kind: "evidence", labelIds: saved?.labelIds ?? [], note: saved?.note,
      title: passage.locator.value, anchor, returnFocus });
  }
  function openSavedHighlight(target: EventTarget | null) {
    const mark = target instanceof Element
      ? target.closest<HTMLElement>("[data-research-evidence]") : null;
    if (!mark || !root.current?.contains(mark)) return false;
    const saved = savedPassages.find(({ receipt }) =>
      receipt.evidence_id === mark.dataset.researchEvidence);
    const kind = saved?.receipt.locator.kind;
    if (!saved || kind !== "paragraph" && kind !== "section" &&
      kind !== "page" && kind !== "footnote" && kind !== "document") return false;
    void labelPassage({ locator: { kind, value: saved.receipt.locator.label },
      quote: saved.receipt.span_text ?? "" }, saved, mark, mark);
    return true;
  }

  return (
    <div ref={readerRoot} data-reader-view {...readerExpansion.dialogProps}
      aria-label={readerExpansion.expanded ? "Expanded source reader" : undefined}
      style={readerExpansion.style} className="flex h-full min-h-0 flex-col bg-white">
      <header className={`shrink-0 border-b border-gray-200 bg-white ${
        compact ? "px-4 py-3" : "px-5 py-4 sm:px-8"
      }`}>
        <div className="mx-auto max-w-5xl">
          <div className="flex min-w-0 items-center gap-3">
            <ResearchLabelPicker file={researchFile}
              kind="source" itemId={researchSource?.id} labelIds={researchSource?.labelIds ?? []}
              note={researchSource?.note}
              title={metadata.title}
              disabled={researchLoading} onError={setResearchError} onNeedFile={needResearchFile}
              onSourceDrag={() => onOpenResearch?.("source-drop")}
              prepare={researchSource ? undefined : prepareResearchSource} mutations={commit} sourceReference={sourceReference} />
            <h1 className={`min-w-0 flex-1 ${compact
              ? "text-base font-semibold leading-tight text-gray-950"
              : "text-xl font-semibold leading-tight text-gray-950 sm:text-2xl"}`}>
              {metadata.title}
            </h1>
            {compact && onOpenResearch && <button type="button" onClick={() => onOpenResearch()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-gray-900 px-2.5 text-xs font-medium text-white hover:bg-gray-700">
              Workspace <PanelsTopLeft className="size-3.5" aria-hidden="true" />
            </button>}
            <ReaderExpandButton expanded={readerExpansion.expanded} onChange={readerExpansion.onChange} />
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
      {researchError && <p role="alert" className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{researchError}</p>}
      {labelTarget && <ResearchLabelEditor target={labelTarget}
        onClose={() => setLabelTarget(null)} onError={setResearchError} mutations={commit} />}
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
      <div className="relative min-h-0 flex-1">
      <div ref={root} data-highlighter={highlight.armed ? "" : undefined}
        onPointerDown={() => { consumed.current = false; }}
        onPointerUp={() => { if (!highlight.armed || window.getSelection()?.isCollapsed !== false) return;
          consumed.current = true; runHighlight(); }}
        onDragStart={(event) => {
          const passage = legalPassageTargetFromSelection(event.currentTarget, window.getSelection());
          if (passage) event.dataTransfer.setData(RESEARCH_PASSAGE_REFERENCE_DRAG,
            JSON.stringify({ reference: sourceReference, ...passage }));
        }}
        onClick={(event) => {
          if (openSavedHighlight(event.target) || !highlight.armed || consumed.current) return;
          if (window.getSelection()?.isCollapsed === false) return;
          const block = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-legal-text]") : null;
          if (!block || !root.current?.contains(block)) return;
          wholeBlock.current = block; runHighlight();
        }}
        onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") &&
          openSavedHighlight(event.target)) event.preventDefault(); }}
        className={`h-full overflow-y-auto bg-[#faf9f6] px-4 py-8 sm:px-8 sm:py-10 ${
          highlight.armed ? "cursor-crosshair" : ""}`}>
        <article lang={metadata.language} className="mx-auto max-w-[48rem] font-sans text-[17px] leading-[1.68] text-gray-900">
            {slices.map((slice, sliceIndex) => {
              const page = slice.primary?.kind === "page"
                ? slice.primary
                : slice.anchors.find(({ kind }) => kind === "page");
              const marker = slice.primary?.kind !== "page" && slice.primary
                ? locatorLabel(slice.primary.label)
                : null;
              const selectionAnchor = slice.primary ?? slice.anchors.find(({ kind }) =>
                kind === "paragraph" || kind === "section" || kind === "page" || kind === "footnote");
              return (
                <section
                  key={`${slice.start}:${slice.end}`}
                  id={slice.primary ? legalSourceAnchorId(slice.primary.label) : undefined}
                  data-legal-block={selectionAnchor?.label}
                  data-locator-kind={selectionAnchor?.kind}
                  data-locator-value={selectionAnchor?.label}
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
                  <div data-legal-text={sliceIndex} className="min-w-0 [&_li>p]:mb-0">
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
    </div>
  );
}
