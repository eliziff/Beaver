import {
    useCallback,
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useDocumentFile } from "@/app/hooks/useDocumentFile";
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
type RenderedPage = {
    wrapper: HTMLDivElement;
    textDivs: HTMLElement[];
    hasTextLayer: boolean;
};

const SIDE_PADDING = 20;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
const MAX_PDF_IMAGE_PIXELS = 40_000_000;
const MAX_PDF_PAGES = 2_000;
const PDF_VIEWER_ERROR =
    "Unable to open this PDF. The file may be invalid or unsupported.";
const clampZoom = (value: number) =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

function applyHighlights(pages: RenderedPage[], quotes: QuoteEntry[]) {
    pages.forEach(({ textDivs }) => clearHighlights(textDivs));
    let firstHit: number | null = null;
    for (const entry of quotes) {
        const hinted = entry.page ? pages[entry.page - 1] : undefined;
        let hit = entry.page && hinted &&
            highlightQuote(hinted.textDivs, entry.quote)
            ? entry.page
            : null;
        if (hit === null) {
            for (let index = 0; index < pages.length; index += 1) {
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

function scrollToHighlight(
    pages: RenderedPage[],
    scrollElement: HTMLDivElement | null,
    pageNumber: number,
) {
    const page = pages[pageNumber - 1];
    if (!page || !scrollElement) return;
    const highlight = page.wrapper.querySelector<HTMLElement>(
        ".pdf-text-highlight",
    );
    const rect = (highlight ?? page.wrapper).getBoundingClientRect();
    const containerRect = scrollElement.getBoundingClientRect();
    scrollElement.scrollTo({
        top: Math.max(
            0,
            scrollElement.scrollTop + rect.top - containerRect.top +
                (highlight ? (rect.height - scrollElement.clientHeight) / 2 : 0),
        ),
        behavior: "instant" as ScrollBehavior,
    });
}

export function PdfView({
    doc,
    revision,
    quotes,
    quoteFocusKey,
    rounded = true,
    onUnavailable,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const pdfRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
    const pagesRef = useRef<RenderedPage[]>([]);
    const quotesRef = useRef<QuoteEntry[]>([]);
    const zoomRef = useRef(1);
    const pageRef = useRef(1);
    const generationRef = useRef(0);
    const taskRef = useRef<{ cancel: () => void } | null>(null);
    const widthRef = useRef(0);
    const quoteList: QuoteEntry[] = quotes?.map(({ page, quote }) => ({
        page,
        quote,
    })) ?? [];
    const quoteKey = quoteList
        .map(({ page, quote }) => `${page ?? ""}:${quote}`)
        .join("|");
    const [zoom, setZoom] = useState(1);
    const [currentPage, setCurrentPage] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [viewerError, setViewerError] = useState<string | null>(null);
    const { result, loading, error } = useDocumentFile(
        doc?.document_id ?? null,
        doc?.version_id ?? null,
        revision,
    );
    const notifyUnavailable = useEffectEvent(() => onUnavailable?.());

    const renderPdf = useCallback(async (
        list: QuoteEntry[],
        scrollToPage?: number,
    ) => {
        const container = containerRef.current;
        const pdf = pdfRef.current;
        if (!container || !pdf) return;
        const generation = ++generationRef.current;
        taskRef.current?.cancel();
        taskRef.current = null;
        container.innerHTML = "";
        pagesRef.current = [];
        const lib = await getPdfJs();
        if (generation !== generationRef.current) return;
        lib.TextLayer.cleanup();
        if (list.length && scrollRef.current)
            scrollRef.current.style.opacity = "0";
        const panelWidth = container.clientWidth;
        widthRef.current = panelWidth;
        const firstPage = await pdf.getPage(1);
        if (generation !== generationRef.current) return;
        const naturalWidth = firstPage.getViewport({ scale: 1 }).width;
        const scale = Math.max(
            0.5,
            (panelWidth - SIDE_PADDING) / naturalWidth,
        ) * zoomRef.current;
        let firstRenderError: unknown = null;

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = pageNumber === 1
                ? firstPage
                : await pdf.getPage(pageNumber);
            if (generation !== generationRef.current) return;
            const viewport = page.getViewport({ scale });
            const wrapper = document.createElement("div");
            wrapper.className = "shadow-md";
            wrapper.style.position = "relative";
            wrapper.style.margin = "0 auto 8px";
            wrapper.style.width = "fit-content";
            wrapper.dataset.pageNumber = String(pageNumber);
            wrapper.setAttribute("aria-label", `Page ${pageNumber}`);
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.display = "block";
            wrapper.appendChild(canvas);
            const context = canvas.getContext("2d");
            if (!context) continue;
            const task = page.render({ canvasContext: context, viewport });
            taskRef.current = task;
            try {
                await task.promise;
            } catch (cause) {
                if ((cause as { name?: string })?.name !==
                    "RenderingCancelledException") {
                    console.error("PDF render error", cause);
                    firstRenderError ??= cause;
                }
                if (generation !== generationRef.current) return;
                continue;
            } finally {
                if (taskRef.current === task) taskRef.current = null;
            }
            if (generation !== generationRef.current) return;
            const textDivs: HTMLElement[] = [];
            if (list.length) {
                const textLayerElement = document.createElement("div");
                textLayerElement.className = "pdf-text-layer";
                Object.assign(textLayerElement.style, {
                    position: "absolute",
                    left: "0",
                    top: "0",
                    width: `${viewport.width}px`,
                    height: `${viewport.height}px`,
                });
                textLayerElement.style.setProperty(
                    "--scale-factor",
                    String(scale),
                );
                wrapper.appendChild(textLayerElement);
                const textLayer = new lib.TextLayer({
                    textContentSource: page.streamTextContent(),
                    container: textLayerElement,
                    viewport,
                });
                await textLayer.render();
                if (generation !== generationRef.current) return;
                textDivs.push(...textLayer.textDivs);
            }
            container.appendChild(wrapper);
            pagesRef.current.push({
                wrapper,
                textDivs,
                hasTextLayer: !!list.length,
            });
        }
        if (generation !== generationRef.current) return;
        if (!pagesRef.current.length && firstRenderError) {
            setNumPages(0);
            setViewerError(PDF_VIEWER_ERROR);
            if (scrollRef.current) scrollRef.current.style.opacity = "1";
            return;
        }
        const target = list.length
            ? applyHighlights(pagesRef.current, list) ??
                list.find(({ page }) => page)?.page
            : null;
        if (target) scrollToHighlight(pagesRef.current, scrollRef.current, target);
        else if (scrollToPage && scrollToPage > 1)
            pagesRef.current[scrollToPage - 1]?.wrapper.scrollIntoView({
                behavior: "instant" as ScrollBehavior,
                block: "start",
            });
        if (scrollRef.current) scrollRef.current.style.opacity = "1";
    }, []);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        let frame: number | null = null;
        const updatePage = () => {
            frame = null;
            if (!pagesRef.current.length) return;
            const center = element.scrollTop + element.clientHeight / 2;
            let closest = 0;
            let distance = Infinity;
            pagesRef.current.forEach(({ wrapper }, index) => {
                const next = Math.abs(
                    wrapper.offsetTop + wrapper.clientHeight / 2 - center,
                );
                if (next < distance) {
                    distance = next;
                    closest = index;
                }
            });
            const page = closest + 1;
            if (page === pageRef.current) return;
            pageRef.current = page;
            setCurrentPage(page);
        };
        const onScroll = () => {
            if (frame === null) frame = requestAnimationFrame(updatePage);
        };
        element.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            element.removeEventListener("scroll", onScroll);
            if (frame !== null) cancelAnimationFrame(frame);
            generationRef.current += 1;
            taskRef.current?.cancel();
            void getPdfJs().then((lib) => lib.TextLayer.cleanup());
        };
    }, []);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
            if (!pdfRef.current) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const width = containerRef.current?.clientWidth ?? 0;
                if (width > 0 && Math.abs(width - widthRef.current) >= 1)
                    void renderPdf(quotesRef.current);
            }, 150);
        });
        observer?.observe(element);
        return () => {
            observer?.disconnect();
            if (timer) clearTimeout(timer);
        };
    }, [renderPdf]);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            const delta = event.deltaMode === 0
                ? event.deltaY / 300
                : event.deltaY * 0.1;
            const next = clampZoom(zoomRef.current * Math.exp(-delta));
            if (next === zoomRef.current) return;
            zoomRef.current = next;
            setZoom(next);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                void renderPdf(quotesRef.current, pageRef.current);
            }, 150);
        };
        let initialDistance = 0;
        let initialZoom = 1;
        const touchDistance = (touches: TouchList) => Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY,
        );
        const onTouchStart = (event: TouchEvent) => {
            if (event.touches.length !== 2) return;
            initialDistance = touchDistance(event.touches);
            initialZoom = zoomRef.current;
        };
        const onTouchMove = (event: TouchEvent) => {
            if (event.touches.length !== 2 || !initialDistance) return;
            event.preventDefault();
            const next = clampZoom(
                initialZoom * touchDistance(event.touches) / initialDistance,
            );
            zoomRef.current = next;
            setZoom(next);
        };
        const onTouchEnd = (event: TouchEvent) => {
            if (event.touches.length >= 2 || !initialDistance) return;
            initialDistance = 0;
            void renderPdf(quotesRef.current, pageRef.current);
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        element.addEventListener("touchstart", onTouchStart, { passive: true });
        element.addEventListener("touchmove", onTouchMove, { passive: false });
        element.addEventListener("touchend", onTouchEnd, { passive: true });
        return () => {
            element.removeEventListener("wheel", onWheel);
            element.removeEventListener("touchstart", onTouchStart);
            element.removeEventListener("touchmove", onTouchMove);
            element.removeEventListener("touchend", onTouchEnd);
            if (timer) clearTimeout(timer);
        };
    }, [renderPdf]);

    useEffect(() => {
        if (error || (result && result.type !== "pdf")) {
            notifyUnavailable();
            return;
        }
        if (!result) return;
        pagesRef.current = [];
        quotesRef.current = quoteList;
        zoomRef.current = 1;
        pageRef.current = 1;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setZoom(1);
            setCurrentPage(1);
            setNumPages(0);
            setViewerError(null);
        });
        void (async () => {
            const lib = await getPdfJs();
            if (cancelled) return;
            const pdf = await lib.getDocument({
                data: new Uint8Array(result.buffer),
                isEvalSupported: false,
                maxImageSize: MAX_PDF_IMAGE_PIXELS,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
            }).promise;
            if (cancelled) return void pdf.destroy();
            if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 ||
                pdf.numPages > MAX_PDF_PAGES) {
                await pdf.destroy();
                throw new Error("PDF page count exceeds the viewer limit");
            }
            pdfRef.current = pdf;
            setNumPages(pdf.numPages);
            await renderPdf(quoteList);
        })().catch((cause) => {
            if (cancelled) return;
            console.error("PDF render error", cause);
            setNumPages(0);
            setViewerError(PDF_VIEWER_ERROR);
            notifyUnavailable();
        });
        return () => {
            cancelled = true;
            generationRef.current += 1;
            taskRef.current?.cancel();
            const pdf = pdfRef.current;
            pdfRef.current = null;
            void pdf?.destroy();
        };
    }, [error, result, renderPdf]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!pdfRef.current) return;
        quotesRef.current = quoteList;
        if (quoteList.length && pagesRef.current.some(({ hasTextLayer }) =>
            !hasTextLayer)) {
            void renderPdf(quoteList);
            return;
        }
        const page = applyHighlights(pagesRef.current, quoteList) ??
            quoteList.find((entry) => entry.page)?.page;
        if (page) scrollToHighlight(pagesRef.current, scrollRef.current, page);
    }, [quoteFocusKey, quoteKey]); // eslint-disable-line react-hooks/exhaustive-deps

    function changeZoom(event: ReactMouseEvent<HTMLButtonElement>) {
        const next = clampZoom(
            zoomRef.current + Number(event.currentTarget.value),
        );
        if (next === zoomRef.current) return;
        zoomRef.current = next;
        setZoom(next);
        void renderPdf(quotesRef.current, pageRef.current);
    }

    return (
        <section
            className={`relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gray-100 ${rounded ? "rounded-lg" : ""}`}
            aria-label="PDF document"
        >
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-5">
                {loading && (
                    <div role="status" className="flex h-full items-center justify-center">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                        <span className="sr-only">Loading PDF…</span>
                    </div>
                )}
                {(error || viewerError) && (
                    <div role="alert" className="flex h-full items-center justify-center">
                        <p className="max-w-sm px-6 text-center text-sm text-red-600">
                            {error || viewerError}
                        </p>
                    </div>
                )}
                <div ref={containerRef} />
            </div>
            {numPages > 0 && (
                <>
                    <div className="pointer-events-none absolute bottom-4 left-4">
                        <span className="flex items-center rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium tabular-nums text-gray-700 shadow-sm">
                            {currentPage}/{numPages}
                        </span>
                    </div>
                    <div className="absolute bottom-4 right-4 flex items-center gap-px rounded-full border border-gray-200 bg-white p-1 shadow-sm">
                        <button
                            type="button"
                            onClick={changeZoom}
                            value={-ZOOM_STEP}
                            disabled={zoom <= ZOOM_MIN}
                            aria-label="Zoom out"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 disabled:opacity-30"
                        >
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-9 select-none text-center text-xs font-medium tabular-nums text-gray-600">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            type="button"
                            onClick={changeZoom}
                            value={ZOOM_STEP}
                            disabled={zoom >= ZOOM_MAX}
                            aria-label="Zoom in"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 disabled:opacity-30"
                        >
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}
