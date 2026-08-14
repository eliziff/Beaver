import {
    useCallback,
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import type { CitationQuote } from "../types";
import {
    clearHighlights,
    getPdfJs,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";
interface Props {
    doc: { document_id: string; version_id?: string | null } | null;
    revision?: string | number | null;
    quotes?: CitationQuote[];
    quoteFocusKey?: string | number;
    rounded?: boolean;
    onUnavailable?: () => void;
}
type QuoteEntry = { page?: number; quote: string };
const SIDE_PADDING = 20;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.25;
type RenderedPage = {
    wrapper: HTMLDivElement;
    textDivs: HTMLElement[];
    hasTextLayer: boolean;
};
const clampZoom = (value: number) =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

function applyHighlights(
    pages: RenderedPage[],
    list: QuoteEntry[],
): number | null {
    for (const page of pages) clearHighlights(page.textDivs);
    let firstHit: number | null = null;
    for (const entry of list) {
        const hintedPage = entry.page ? pages[entry.page - 1] : undefined;
        let hit =
            entry.page &&
            hintedPage &&
            highlightQuote(hintedPage.textDivs, entry.quote)
                ? entry.page
                : null;
        if (hit === null) {
            console.warn(
                `Quote not found on hinted page, scanning all pages: "${entry.quote.slice(0, 60)}..."`,
            );
            for (let index = 0; index < pages.length; index++) {
                if (highlightQuote(pages[index].textDivs, entry.quote)) {
                    hit = index + 1;
                    break;
                }
            }
        }
        firstHit ??= hit;
    }
    return firstHit;
}

function scrollToHighlightOnPage(
    pages: RenderedPage[],
    scrollEl: HTMLDivElement | null,
    pageNum: number,
) {
    const page = pages[pageNum - 1];
    if (!page || !scrollEl) return;
    const highlight = page.wrapper.querySelector<HTMLElement>(
        ".pdf-text-highlight",
    );
    const rect = (highlight ?? page.wrapper).getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    const centeredOffset = highlight
        ? (rect.height - scrollEl.clientHeight) / 2
        : 0;
    scrollEl.scrollTo({
        top: Math.max(
            0,
            scrollEl.scrollTop + rect.top - containerRect.top + centeredOffset,
        ),
        behavior: "instant" as ScrollBehavior,
    });
}
export function PdfView({
    doc,
    quotes,
    quoteFocusKey,
    rounded = true,
    onUnavailable,
    revision,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const pdfDocRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(
        null,
    );
    const renderedPagesRef = useRef<RenderedPage[]>([]);
    const quoteListRef = useRef<QuoteEntry[]>([]);
    const zoomRef = useRef(1.0);
    const currentPageRef = useRef(1);
    const renderGenerationRef = useRef(0);
    const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
    const renderedWidthRef = useRef(0);
    const quoteList: QuoteEntry[] =        quotes?.map((q) => ({ page: q.page, quote: q.quote })) ?? [];    const quoteKey = quoteList
        .map((q) => `${q.page ?? ""}:${q.quote}`)
        .join("|");
    const [zoom, setZoom] = useState(1.0);
    const [currentPage, setCurrentPage] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const { result, loading, error } = useFetchSingleDoc(
        doc?.document_id ?? null,
        doc?.version_id ?? null,
        revision,
    );
    const notifyUnavailable = useEffectEvent(() => onUnavailable?.());
    useEffect(() => {
        const scrollEl = scrollContainerRef.current;
        if (!scrollEl) return;
        let frame: number | null = null;
        const updateCurrentPage = () => {
            frame = null;
            const pages = renderedPagesRef.current;
            if (!pages.length) return;
            const scrollCenter = scrollEl.scrollTop + scrollEl.clientHeight / 2;
            let closest = 0;
            let closestDist = Infinity;
            pages.forEach((p, i) => {
                const pageCenter =
                    p.wrapper.offsetTop + p.wrapper.clientHeight / 2;
                const dist = Math.abs(pageCenter - scrollCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = i;
                }
            });
            const page = closest + 1;
            if (page === currentPageRef.current) return;
            currentPageRef.current = page;
            setCurrentPage(page);
        };
        const handleScroll = () => {
            if (frame === null)
                frame = requestAnimationFrame(updateCurrentPage);
        };
        scrollEl.addEventListener("scroll", handleScroll, { passive: true });
        return () => {
            scrollEl.removeEventListener("scroll", handleScroll);
            if (frame !== null) cancelAnimationFrame(frame);
            renderGenerationRef.current += 1;
            renderTaskRef.current?.cancel();
            getPdfJs().then((lib) => lib.TextLayer.cleanup());
        };
    }, []);
    const renderPDF = useCallback(
        async (list: QuoteEntry[], scrollToPage?: number) => {
            const container = containerRef.current;
            const doc = pdfDocRef.current;
            if (!container || !doc) return;
            const generation = ++renderGenerationRef.current;
            renderTaskRef.current?.cancel();
            renderTaskRef.current = null;
            container.innerHTML = "";
            renderedPagesRef.current = [];
            const lib = await getPdfJs();
            if (generation !== renderGenerationRef.current) return;
            lib.TextLayer.cleanup();
            if (list.length && scrollContainerRef.current) {
                scrollContainerRef.current.style.opacity = "0";
            }
            const panelW = container.clientWidth;
            renderedWidthRef.current = panelW;
            const firstPage = await doc.getPage(1);
            if (generation !== renderGenerationRef.current) return;
            const naturalWidth = firstPage.getViewport({ scale: 1 }).width;
            const baseScale = Math.max(
                0.5,
                (panelW - SIDE_PADDING) / naturalWidth,
            );
            const scale = baseScale * zoomRef.current;
            for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
                const page =
                    pageNum === 1 ? firstPage : await doc.getPage(pageNum);
                if (generation !== renderGenerationRef.current) return;
                const viewport = page.getViewport({ scale });
                const wrapper = document.createElement("div");
                wrapper.style.position = "relative";
                wrapper.style.margin = "0 auto 8px";
                wrapper.style.width = "fit-content";
                wrapper.className = "shadow-md";
                wrapper.dataset.pageNumber = String(pageNum);
                wrapper.setAttribute("aria-label", `Page ${pageNum}`);
                const canvas = document.createElement("canvas");
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.style.display = "block";
                wrapper.appendChild(canvas);
                const ctx = canvas.getContext("2d");
                if (!ctx) continue;
                const task = page.render({ canvasContext: ctx, viewport });
                renderTaskRef.current = task;
                try {
                    await task.promise;
                } catch (e: unknown) {
                    if ((e as { name?: string })?.name !== "RenderingCancelledException") {
                        console.error("PDF render error", e);
                    }
                    if (generation !== renderGenerationRef.current) return;
                    continue;
                } finally {
                    if (renderTaskRef.current === task) {
                        renderTaskRef.current = null;
                    }
                }
                if (generation !== renderGenerationRef.current) return;
                const textDivs: HTMLElement[] = [];
                if (list.length) {
                    const textLayerDiv = document.createElement("div");
                    textLayerDiv.className = "pdf-text-layer";
                    textLayerDiv.style.position = "absolute";
                    textLayerDiv.style.left = "0";
                    textLayerDiv.style.top = "0";
                    textLayerDiv.style.width = `${viewport.width}px`;
                    textLayerDiv.style.height = `${viewport.height}px`;
                    textLayerDiv.style.setProperty("--scale-factor", String(scale));
                    wrapper.appendChild(textLayerDiv);
                    const textLayer = new lib.TextLayer({
                        textContentSource: page.streamTextContent(),
                        container: textLayerDiv,
                        viewport,
                    });
                    await textLayer.render();
                    if (generation !== renderGenerationRef.current) return;
                    textDivs.push(...textLayer.textDivs);
                }
                container.appendChild(wrapper);
                renderedPagesRef.current.push({
                    wrapper,
                    textDivs,
                    hasTextLayer: list.length > 0,
                });
            }
            if (generation !== renderGenerationRef.current) return;
            let targetPage = list.length
                ? applyHighlights(renderedPagesRef.current, list)
                : null;
            targetPage ??= list.find((entry) => entry.page)?.page ?? null;
            if (targetPage && targetPage >= 1) {
                scrollToHighlightOnPage(
                    renderedPagesRef.current,
                    scrollContainerRef.current,
                    targetPage,
                );
            } else if (!list.length && scrollToPage && scrollToPage > 1) {
                const pageEntry = renderedPagesRef.current[scrollToPage - 1];
                if (pageEntry)
                    pageEntry.wrapper.scrollIntoView({
                        behavior: "instant" as ScrollBehavior,
                        block: "start",
                    });
            }
            if (scrollContainerRef.current)
                scrollContainerRef.current.style.opacity = "1";
        },
        [],
    );
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver(() => {
            if (!pdfDocRef.current) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const width = containerRef.current?.clientWidth ?? 0;
                if (
                    pdfDocRef.current &&
                    width > 0 &&
                    Math.abs(width - renderedWidthRef.current) >= 1
                ) {
                    renderPDF(quoteListRef.current);
                }
            }, 150);
        });
        observer.observe(el);
        return () => {
            observer.disconnect();
            if (timer) clearTimeout(timer);
        };
    }, [renderPDF]);
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const handleWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const delta = e.deltaMode === 0 ? e.deltaY / 300 : e.deltaY * 0.1;
            const next = clampZoom(zoomRef.current * Math.exp(-delta));
            if (next === zoomRef.current) return;
            zoomRef.current = next;
            setZoom(next);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                renderPDF(quoteListRef.current, currentPageRef.current);
            }, 150);
        };
        let initialDist = 0;
        let initialZoom = 1.0;
        function getTouchDist(touches: TouchList) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.hypot(dx, dy);
        }
        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                initialDist = getTouchDist(e.touches);
                initialZoom = zoomRef.current;
            }
        };
        const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || initialDist === 0) return;
            e.preventDefault();
            const next = clampZoom(
                initialZoom * (getTouchDist(e.touches) / initialDist),
            );
            zoomRef.current = next;
            setZoom(next);
        };
        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && initialDist > 0) {
                initialDist = 0;
                renderPDF(quoteListRef.current, currentPageRef.current);
            }
        };
        el.addEventListener("wheel", handleWheel, { passive: false });
        el.addEventListener("touchstart", handleTouchStart, { passive: true });
        el.addEventListener("touchmove", handleTouchMove, { passive: false });
        el.addEventListener("touchend", handleTouchEnd, { passive: true });
        return () => {
            el.removeEventListener("wheel", handleWheel);
            el.removeEventListener("touchstart", handleTouchStart);
            el.removeEventListener("touchmove", handleTouchMove);
            el.removeEventListener("touchend", handleTouchEnd);
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    }, [renderPDF]);
    useEffect(() => {
        if (error || (result && result.type !== "pdf")) {
            notifyUnavailable();
            return;
        }
        if (!result) return;
        pdfDocRef.current = null;
        renderedPagesRef.current = [];
        quoteListRef.current = quoteList;
        zoomRef.current = 1.0;
        currentPageRef.current = 1;
        const list = quoteList;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setZoom(1.0);
            setCurrentPage(1);
            setNumPages(0);
        });
        void (async () => {
            const lib = await getPdfJs();
            if (cancelled) return;
            const pdfDoc = await lib.getDocument({
                data: new Uint8Array(result.buffer.slice(0)),
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
            }).promise;
            if (cancelled) return;
            pdfDocRef.current = pdfDoc;
            setNumPages(pdfDoc.numPages);
            await renderPDF(list);
        })().catch((cause) => {
            if (cancelled) return;
            console.error("PDF render error", cause);
            notifyUnavailable();
        });
        return () => {
            cancelled = true;
            renderGenerationRef.current += 1;
            renderTaskRef.current?.cancel();
        };
    }, [error, result, renderPDF]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!pdfDocRef.current) return;
        quoteListRef.current = quoteList;
        if (
            quoteList.length &&
            renderedPagesRef.current.some((page) => !page.hasTextLayer)
        ) {
            void renderPDF(quoteList);
            return;
        }
        const targetPage = applyHighlights(renderedPagesRef.current, quoteList);
        const page = targetPage ?? quoteList.find((entry) => entry.page)?.page;
        if (page && page >= 1) {
            scrollToHighlightOnPage(
                renderedPagesRef.current,
                scrollContainerRef.current,
                page,
            );
        }
    }, [quoteKey, quoteFocusKey]); // eslint-disable-line react-hooks/exhaustive-deps
    function handleZoom(event: ReactMouseEvent<HTMLButtonElement>) {
        const next = clampZoom(
            zoomRef.current + Number(event.currentTarget.value),
        );
        if (next === zoomRef.current) return;
        zoomRef.current = next;
        setZoom(next);
        renderPDF(quoteListRef.current, currentPageRef.current);
    }
    return (
        <div
            className={`relative flex flex-col bg-gray-100 flex-1 overflow-hidden ${rounded ? "rounded-lg" : ""}`}
        >
            <div
                ref={scrollContainerRef}
                className="flex-1 overflow-auto px-3 pt-5 pb-3"
            >
                {loading && (
                    <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                <div ref={containerRef} />
            </div>
            {numPages > 0 && (
                <>
                    <div className="absolute bottom-4 left-4 pointer-events-none">
                        <span className="flex items-center rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium tabular-nums text-gray-700 shadow-sm">
                            {currentPage}/{numPages}
                        </span>
                    </div>
                    <div className="absolute bottom-4 right-4 flex items-center gap-px rounded-full border border-gray-200 bg-white px-1 py-1 shadow-sm">
                        <button
                            onClick={handleZoom}
                            value={-ZOOM_STEP}
                            disabled={zoom <= ZOOM_MIN}
                            aria-label="Zoom out"
                            className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30"
                        >
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-xs font-medium text-gray-600 tabular-nums w-9 text-center select-none">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            onClick={handleZoom}
                            value={ZOOM_STEP}
                            disabled={zoom >= ZOOM_MAX}
                            aria-label="Zoom in"
                            className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30"
                        >
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
