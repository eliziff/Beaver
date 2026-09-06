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
import type { CitationQuote } from "@/app/lib/citations";
import {
    clearHighlights,
    getPdfJs,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";

interface Props {
    doc: { document_id: string; version_id?: string | null } | null;
    bytes?: Uint8Array;
    revision?: string | number | null;
    quotes?: CitationQuote[];
    quoteFocusKey?: string | number;
    rounded?: boolean;
    ariaLabel?: string;
    onUnavailable?: () => void;
}

type QuoteEntry = { page?: number; quote: string };
type RenderedPage = {
    wrapper: HTMLDivElement;
    textDivs: HTMLElement[];
    hasTextLayer: boolean;
    top: number;
    height: number;
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
    bytes,
    revision,
    quotes,
    quoteFocusKey,
    rounded = true,
    ariaLabel = "PDF document",
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
    const scheduleRef = useRef<(() => void) | null>(null);
    const geometryRef = useRef<Promise<import("pdfjs-dist").PDFPageProxy[]> | null>(null);
    const quoteList: QuoteEntry[] = quotes?.map(({ page, quote }) => ({
        page,
        quote,
    })) ?? [];
    const quoteKey = quoteList
        .map(({ page, quote }) => `${page ?? ""}:${quote}`)
        .join("|");
    const [preparing, setPreparing] = useState(true);
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
        const fail = (cause: unknown) => {
            if (generation !== generationRef.current) return;
            console.error("PDF render error", cause);
            setPreparing(false);
            setViewerError(PDF_VIEWER_ERROR);
        };
        try {
            setPreparing(true);
            taskRef.current?.cancel();
            taskRef.current = null;
            scheduleRef.current = null;
            container.innerHTML = "";
            pagesRef.current = [];
            const lib = await getPdfJs();
            if (generation !== generationRef.current) return;
            const panelWidth = container.clientWidth;
            widthRef.current = panelWidth;
            // Page metadata is cheap; rasterizing every page is not. Resolve exact
            // geometry once, including mixed page sizes and rotation, before layout.
            geometryRef.current ??= (async () => {
                const pages: import("pdfjs-dist").PDFPageProxy[] = [];
                for (let start = 1; start <= pdf.numPages; start += 16) {
                    pages.push(...await Promise.all(Array.from(
                        { length: Math.min(16, pdf.numPages - start + 1) },
                        (_, index) => pdf.getPage(start + index),
                    )));
                    if (generation !== generationRef.current && pdf !== pdfRef.current) break;
                }
                return pages;
            })();
            const pdfPages = await geometryRef.current;
            if (generation !== generationRef.current) return;
            const scale = Math.max(0.1, (panelWidth - SIDE_PADDING) /
                pdfPages[0].getViewport({ scale: 1 }).width) * zoomRef.current;
            const fragment = document.createDocumentFragment();
            let top = 0;
            const pages = pdfPages.map((page, index) => {
                const viewport = page.getViewport({ scale });
                const wrapper = document.createElement("div");
                wrapper.className = "shadow-md";
                Object.assign(wrapper.style, {
                    position: "relative", margin: "0 auto 8px", background: "white",
                    width: `${viewport.width}px`, height: `${viewport.height}px`,
                });
                wrapper.dataset.pageNumber = String(index + 1);
                wrapper.setAttribute("aria-label", `Page ${index + 1}`);
                fragment.appendChild(wrapper);
                const entry: RenderedPage = {
                    wrapper, textDivs: [], hasTextLayer: false, top, height: viewport.height,
                };
                top += viewport.height + 8;
                return entry;
            });
            container.appendChild(fragment);
            pagesRef.current = pages;
            setPreparing(false);
            const target = list.find(({ page }) => page)?.page ?? scrollToPage;
            if (target) scrollToHighlight(pages, scrollRef.current, target);

            const rendered = new Map<number, HTMLCanvasElement>();
            const failed = new Set<number>();
            let running = false;
            let active = -1;
            const range = () => {
                const element = scrollRef.current;
                const start = (element?.scrollTop ?? 0) - container.offsetTop;
                const height = element?.clientHeight || 800;
                return { start, end: start + height, margin: height };
            };
            const nearby = (index: number, padding = 1) => {
                const { start, end, margin } = range();
                return pages[index].top + pages[index].height >= start - margin * padding &&
                    pages[index].top <= end + margin * padding;
            };
            const paint = async () => {
                if (running || generation !== generationRef.current) return;
                running = true;
                try {
                    while (generation === generationRef.current) {
                        const { start, end } = range();
                        const index = pages.map((_, index) => index)
                            .filter((index) => nearby(index) && !rendered.has(index) && !failed.has(index))
                            .sort((a, b) => {
                                const distance = (index: number) => Math.max(
                                    start - pages[index].top - pages[index].height,
                                    pages[index].top - end, 0,
                                );
                                return distance(a) - distance(b);
                            })[0];
                        if (index === undefined) break;
                        active = index;
                        const page = pdfPages[index];
                        const viewport = page.getViewport({ scale });
                        const canvas = document.createElement("canvas");
                        canvas.width = Math.ceil(viewport.width);
                        canvas.height = Math.ceil(viewport.height);
                        Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
                        const context = canvas.getContext("2d");
                        if (!context) { failed.add(index); continue; }
                        const task = page.render({ canvasContext: context, viewport });
                        taskRef.current = task;
                        try {
                            await task.promise;
                            if (generation !== generationRef.current) return;
                            pages[index].wrapper.prepend(canvas);
                            rendered.set(index, canvas);
                        } catch (cause) {
                            canvas.width = canvas.height = 0;
                            if ((cause as { name?: string })?.name !== "RenderingCancelledException") {
                                console.error("PDF render error", cause);
                                failed.add(index);
                                const message = document.createElement("p");
                                message.setAttribute("role", "alert");
                                message.textContent = `Unable to render page ${index + 1}.`;
                                pages[index].wrapper.appendChild(message);
                            }
                        } finally {
                            if (taskRef.current === task) taskRef.current = null;
                            active = -1;
                        }
                    }
                } finally { running = false; }
            };
            scheduleRef.current = () => {
                // Keep a second viewport as a back-scroll buffer; release distant
                // bitmap allocations without changing any page's layout box.
                for (const [index, canvas] of rendered) {
                    if (nearby(index, 2)) continue;
                    canvas.remove();
                    canvas.width = canvas.height = 0;
                    rendered.delete(index);
                }
                if (active >= 0 && !nearby(active)) taskRef.current?.cancel();
                void paint().catch(fail);
            };
            scheduleRef.current();

            // Quote search needs text, never offscreen canvases. Hinted pages are
            // searched first so a deep citation can become readable immediately.
            if (list.length) {
                const order = [...new Set([
                    ...list.flatMap(({ page }) => page && pages[page - 1] ? [page - 1] : []),
                    ...pages.map((_, index) => index),
                ])];
                let focused = false;
                for (const index of order) {
                    if (generation !== generationRef.current) return;
                    const viewport = pdfPages[index].getViewport({ scale });
                    const textLayerElement = document.createElement("div");
                    textLayerElement.className = "pdf-text-layer";
                    Object.assign(textLayerElement.style, {
                        position: "absolute", left: "0", top: "0",
                        width: `${viewport.width}px`, height: `${viewport.height}px`,
                    });
                    textLayerElement.style.setProperty("--scale-factor", String(scale));
                    pages[index].wrapper.appendChild(textLayerElement);
                    const textLayer = new lib.TextLayer({
                        textContentSource: pdfPages[index].streamTextContent(),
                        container: textLayerElement, viewport,
                    });
                    await textLayer.render();
                    if (generation !== generationRef.current) return;
                    pages[index].textDivs = textLayer.textDivs;
                    pages[index].hasTextLayer = true;
                    let hit = false;
                    for (const entry of list) hit = highlightQuote(textLayer.textDivs, entry.quote) || hit;
                    if (hit && !focused) {
                        focused = true;
                        scrollToHighlight(pages, scrollRef.current, index + 1);
                        scheduleRef.current?.();
                    }
                }
                applyHighlights(pages, list);
            }
        } catch (cause) { fail(cause); }
    }, []);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        let frame: number | null = null;
        const updatePage = () => {
            frame = null;
            scheduleRef.current?.();
            if (!pagesRef.current.length) return;
            const center = element.scrollTop - (containerRef.current?.offsetTop ?? 0) + element.clientHeight / 2;
            let closest = 0;
            let distance = Infinity;
            pagesRef.current.forEach(({ top, height }, index) => {
                const next = Math.abs(
                    top + height / 2 - center,
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
            scheduleRef.current = null;
        };
    }, []);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
            if (!pdfRef.current) return;
            const width = containerRef.current?.clientWidth ?? 0;
            if (width > 0 && Math.abs(width - widthRef.current) >= 1)
                void renderPdf(quotesRef.current, pageRef.current);
        });
        observer?.observe(element);
        return () => observer?.disconnect();
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
        if (!bytes && (error || (result && result.type !== "pdf"))) {
            notifyUnavailable();
            return;
        }
        if (!bytes && !result) return;
        pagesRef.current = [];
        quotesRef.current = quoteList;
        zoomRef.current = 1;
        pageRef.current = 1;
        let cancelled = false;
        let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
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
            loadingTask = lib.getDocument({
                data: bytes?.slice() ?? new Uint8Array(result!.buffer).slice(),
                isEvalSupported: false,
                maxImageSize: MAX_PDF_IMAGE_PIXELS,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
            });
            const pdf = await loadingTask.promise;
            if (cancelled) return void pdf.destroy();
            if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 ||
                pdf.numPages > MAX_PDF_PAGES) {
                await pdf.destroy();
                throw new Error("PDF page count exceeds the viewer limit");
            }
            geometryRef.current = null;
            pdfRef.current = pdf;
            setNumPages(pdf.numPages);
            await renderPdf(quoteList);
        })().catch((cause) => {
            if (cancelled) return;
            console.error("PDF render error", cause);
            setNumPages(0);
            setPreparing(false);
            setViewerError(PDF_VIEWER_ERROR);
            notifyUnavailable();
        });
        return () => {
            cancelled = true;
            generationRef.current += 1;
            taskRef.current?.cancel();
            scheduleRef.current = null;
            geometryRef.current = null;
            pagesRef.current = [];
            containerRef.current?.replaceChildren();
            const pdf = pdfRef.current;
            pdfRef.current = null;
            if (loadingTask) void loadingTask.destroy();
            else void pdf?.destroy();
        };
    }, [bytes, error, result, renderPdf]); // eslint-disable-line react-hooks/exhaustive-deps

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
            aria-label={ariaLabel}
        >
            {((!bytes && loading) || (preparing && !error && !viewerError)) && (
                <div role="status" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    <span className="sr-only">Loading PDF…</span>
                </div>
            )}
            <div ref={scrollRef} style={{ scrollbarGutter: "stable" }} className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-5">
                {((!bytes && error) || viewerError) && (
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
