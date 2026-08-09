import { useEffect, useEffectEvent, useRef, useState } from "react";import { Loader2 } from "lucide-react";
import {
    parseAsync,
    renderDocument,
    type Options as DocxPreviewOptions,
} from "docx-preview";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
} from "./highlightDocxQuote";
import {
    finalizeDocxDom,
    tagDocxMarkers,
    type DocxNoteModel,
} from "./docxNotes";
import type { CitationQuote } from "../types";
import { PdfView } from "./PdfView";
interface Props {
    documentId: string;
    versionId?: string | null;
    preferPdfRendition?: boolean;
    onReady?: () => void;
    highlightEdit?: {
        key: string;
        inserted_text?: string;
        deleted_text?: string;
        ins_w_id?: string | null;
        del_w_id?: string | null;
    } | null;
    refetchKey?: string | number;
    quotes?: CitationQuote[];
    quoteFocusKey?: string | number;
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
    rounded?: boolean;
}
export const DOCX_RENDER_OPTIONS = {
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderChanges: true,
    experimental: false,
    trimXmlDeclaration: false,
} satisfies Partial<DocxPreviewOptions>;
export function fitDocxPages(
    pages: readonly HTMLElement[],
    viewport: HTMLElement,
): void {
    if (pages.length === 0) return;
    const styles = window.getComputedStyle(viewport);
    const available =
        viewport.clientWidth -
        (parseFloat(styles.paddingLeft) || 0) -
        (parseFloat(styles.paddingRight) || 0);
    if (available <= 0) return;
    const sizes = pages.map((page) => ({
        page,
        width: Number(page.dataset.docxNaturalWidth),
    }));
    for (const entry of sizes) {
        if (!Number.isFinite(entry.width) || entry.width <= 0) {
            entry.page.style.zoom = "1";
        }
    }
    for (const entry of sizes) {
        if (!Number.isFinite(entry.width) || entry.width <= 0) {
            entry.width = Math.max(
                entry.page.offsetWidth,
                entry.page.scrollWidth,
            );
            if (entry.width > 0) {
                entry.page.dataset.docxNaturalWidth = String(entry.width);
            }
        }
    }
    for (const { page, width } of sizes) {
        if (width > 0) page.style.zoom = String(Math.min(1, available / width));
    }
}
export function quietBrokenDocxImages(
    images: readonly HTMLImageElement[],
    onUnsupported?: () => void,
): void {
    for (const image of images) {
        const quiet = () => {
            image.classList.add("docx-media-unavailable");
            image.closest<HTMLElement>("span")?.setAttribute(
                "aria-label",
                "Embedded image unavailable in this browser",
            );
            onUnsupported?.();
        };
        if (image.complete && image.naturalWidth === 0) quiet();
        else image.addEventListener("error", quiet, { once: true });
    }
}
function parseDocx(bytes: ArrayBuffer): Promise<DocxNoteModel> {
    return parseAsync(bytes, DOCX_RENDER_OPTIONS).then((doc) => {
        tagDocxMarkers(doc as DocxNoteModel);
        return doc as DocxNoteModel;
    });
}
function findEditElement(
    root: HTMLElement,
    tag: "ins" | "del",
    opts: { w_id?: string | null; text?: string },
): HTMLElement | null {
    if (opts.w_id) {
        const byId = root.querySelector(
            `${tag}[data-w-id="${CSS.escape(opts.w_id)}"]`,
        ) as HTMLElement | null;
        if (byId) return byId;
    }
    const text = opts.text ?? "";
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const target = normalize(text);
    if (!target) return null;
    const candidates = Array.from(root.querySelectorAll(tag)) as HTMLElement[];
    return (
        candidates.find((el) => normalize(el.textContent ?? "") === target) ??
        candidates.find((el) =>
            normalize(el.textContent ?? "").includes(target),
        ) ??
        null
    );
}
function scrollToHighlight(
    container: HTMLElement,
    scrollEl: HTMLElement,
    edit: {
        inserted_text?: string;
        deleted_text?: string;
        ins_w_id?: string | null;
        del_w_id?: string | null;
    },
) {
    const insEl = findEditElement(container, "ins", {
        w_id: edit.ins_w_id,
        text: edit.inserted_text,
    });
    const delEl = findEditElement(container, "del", {
        w_id: edit.del_w_id,
        text: edit.deleted_text,
    });
    const anchor = insEl ?? delEl;
    if (!anchor) return;
    const scrollRect = scrollEl.getBoundingClientRect();
    const targetRect = anchor.getBoundingClientRect();
    const offset = targetRect.top - scrollRect.top + scrollEl.scrollTop - 80;
    scrollEl.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
    const flashed = [insEl, delEl].filter((el): el is HTMLElement => !!el);
    flashed.forEach((el) => el.classList.add("docx-edit-flash"));
    window.setTimeout(() => {
        flashed.forEach((el) => el.classList.remove("docx-edit-flash"));
    }, 2000);
}
export function DocxView({
    documentId,
    versionId,
    onReady,
    highlightEdit,
    refetchKey,
    quotes,
    quoteFocusKey,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
    rounded = true,
}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const pageElementsRef = useRef<HTMLElement[]>([]);
    const lastScrollTopRef = useRef(0);
    const renderKeyRef = useRef(0);
    const current = useEffectEvent(() => ({
        highlightEdit,
        initialScrollTop,
        onReady,
        onScrollChange,
        quotes,
    }));
    const unavailableRenditionsRef = useRef(new Set<string>());
    const [pdfRenditionKey, setPdfRenditionKey] = useState<string | null>(null);
    const [unsupportedMediaKey, setUnsupportedMediaKey] = useState<
        string | null
    >(null);
    const renditionKey = `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
    const showPdfRendition =
        !highlightEdit &&
        pdfRenditionKey === renditionKey &&
        !unavailableRenditionsRef.current.has(renditionKey);
    const quoteKey = (quotes ?? []).map((q) => q.quote).join("||");
    const { bytes, loading, error } = useFetchDocxBytes(
        showPdfRendition ? null : documentId,
        versionId,
        refetchKey,
    );
    const applyQuoteHighlights = (
        containerEl: HTMLElement,
        scrollEl: HTMLElement,
        list: CitationQuote[] | undefined,
    ): boolean => {
        clearDocxQuoteHighlights(containerEl);
        if (!list || list.length === 0) return false;
        let firstMatch: HTMLElement | null = null;
        for (const q of list) {
            const match = highlightDocxQuote(containerEl, q.quote);
            if (match && !firstMatch) firstMatch = match;
        }
        if (!firstMatch) return false;
        const scrollRect = scrollEl.getBoundingClientRect();
        const targetRect = firstMatch.getBoundingClientRect();
        const offset =
            targetRect.top -
            scrollRect.top +
            scrollEl.scrollTop -
            scrollEl.clientHeight / 2 +
            targetRect.height / 2;
        scrollEl.scrollTo({
            top: Math.max(0, offset),
            behavior: "instant" as ScrollBehavior,
        });
        return true;
    };
    const applyDocxScale = () => {
        const containerEl = containerRef.current;
        const scrollEl = scrollRef.current;
        if (!containerEl || !scrollEl) return;
        fitDocxPages(pageElementsRef.current, scrollEl);
    };
    useEffect(() => {
        const scrollEl = scrollRef.current;
        if (!scrollEl) return;
        let raf = 0;
        const schedule = () => {
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => applyDocxScale());
        };
        const ro = new ResizeObserver(schedule);
        ro.observe(scrollEl);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [showPdfRendition]);
    useEffect(() => {
        let cancelled = false;
        if (!bytes || !containerRef.current || !scrollRef.current) return;
        const scrollEl = scrollRef.current;
        const containerEl = containerRef.current;
        lastScrollTopRef.current = scrollEl.scrollTop;
        const thisRender = ++renderKeyRef.current;
        (async () => {
            try {
                const doc = await parseDocx(bytes);
                if (cancelled) return;
                await renderDocument(
                    doc,
                    containerEl,
                    undefined,
                    DOCX_RENDER_OPTIONS,
                );
                if (cancelled) return;
                const rendered = finalizeDocxDom(containerEl);
                pageElementsRef.current = rendered.pages;
                quietBrokenDocxImages(rendered.images, () => {
                    const { highlightEdit: currentEdit } = current();
                    if (
                        cancelled ||
                        currentEdit ||
                        unavailableRenditionsRef.current.has(renditionKey)
                    )
                        return;
                    setPdfRenditionKey(renditionKey);
                });
                applyDocxScale();
                if (cancelled) return;
                requestAnimationFrame(() => {
                    if (
                        !scrollRef.current ||
                        thisRender !== renderKeyRef.current
                    )
                        return;
                    const {
                        highlightEdit: pendingHighlight,
                        initialScrollTop: pendingInitialScroll,
                        onReady: ready,
                        quotes: pendingQuotes,
                    } = current();
                    if (pendingHighlight) {
                        scrollToHighlight(
                            containerEl,
                            scrollRef.current,
                            pendingHighlight,
                        );
                        if (pendingQuotes?.length) {
                            for (const q of pendingQuotes)
                                highlightDocxQuote(containerEl, q.quote);
                        }
                    } else if (
                        pendingQuotes &&
                        applyQuoteHighlights(
                            containerEl,
                            scrollRef.current,
                            pendingQuotes,
                        )
                    ) {
                    } else if (typeof pendingInitialScroll === "number") {
                        scrollRef.current.scrollTop = pendingInitialScroll;
                    } else {
                        scrollRef.current.scrollTop = lastScrollTopRef.current;
                    }
                    ready?.();
                });
            } catch (e) {
                console.error("docx-preview render failed", e);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [bytes, showPdfRendition]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!highlightEdit || !containerRef.current || !scrollRef.current)
            return;
        scrollToHighlight(
            containerRef.current,
            scrollRef.current,
            highlightEdit,
        );
    }, [highlightEdit?.key]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!containerRef.current || !scrollRef.current) return;
        applyQuoteHighlights(
            containerRef.current,
            scrollRef.current,
            current().quotes,
        );
    }, [quoteKey, quoteFocusKey]);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        let scheduled = false;
        const onScroll = () => {
            lastScrollTopRef.current = el.scrollTop;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                current().onScrollChange?.(el.scrollTop);
            });
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [showPdfRendition]);
    if (showPdfRendition) {
        return (
            <PdfView
                doc={{ document_id: documentId, version_id: versionId }}
                revision={refetchKey}
                quotes={quotes}
                quoteFocusKey={quoteFocusKey}
                rounded={rounded}
                onUnavailable={() => {
                    unavailableRenditionsRef.current.add(renditionKey);
                    setPdfRenditionKey(null);
                    setUnsupportedMediaKey(renditionKey);
                }}
            />
        );
    }
    const displayedWarning =
        warning ??
        (unsupportedMediaKey === renditionKey
            ? "An embedded vector image is unavailable in this browser preview."
            : null);
    return (
        <div
            className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-gray-100 ${rounded ? "rounded-lg" : ""}`}
        >
            {displayedWarning && (
                <div className="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 shadow-sm">
                    <span>{displayedWarning}</span>
                    {warning && (
                        <button
                            type="button"
                            onClick={() => onWarningDismiss?.()}
                            className="text-amber-600 hover:text-amber-900"
                            aria-label="Dismiss warning"
                        >
                            {"\u00d7"}
                        </button>
                    )}
                </div>
            )}
            <div
                ref={scrollRef}
                className="docx-view-scroll min-h-0 min-w-0 flex-1 overflow-auto px-5 pt-5 pb-3"
                data-document-id={documentId}
                data-version-id={versionId ?? ""}
            >
                {loading && !bytes && (
                    <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                <div ref={containerRef} className="docx-view-container" />
            </div>
        </div>
    );
}
