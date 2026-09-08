import "./pdfTextLayer.css";
import {
    useCallback,
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import type { CitationQuote } from "@/app/lib/citations";
import {
    clearHighlights,
    getPdfJs,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";
import "../loading.css";
import { createPdfPageCache, pageAt } from "./pdfPageCache";
import { matchesQuoteText, quoteSegments } from "./quoteText";
import { attachPdfAnnotationLayer, focusPdfAnnotation, type PdfAnnotationEditorPort } from "./pdfAnnotationLayer";

export type PdfByteSource = (signal: AbortSignal, onError: (error: Error) => void) => Promise<
    { data: Uint8Array } | { range: import("pdfjs-dist").PDFDataRangeTransport;
        rangeChunkSize: number; disableStream: true; disableAutoFetch: true }>;

export interface PdfCanvasProps {
    source?: PdfByteSource;
    annotationEditor?: PdfAnnotationEditorPort;
    bytes?: Uint8Array;
    loading?: boolean;
    error?: string | null;
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
    textLayer?: Promise<void>;
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

export function PdfCanvas({
    annotationEditor,
    bytes,
    source,
    loading = false,
    error,
    quotes,
    quoteFocusKey,
    rounded = true,
    ariaLabel = "PDF document",
    onUnavailable,
}: PdfCanvasProps) {
    const editorRef = useRef(annotationEditor);
    editorRef.current = annotationEditor;
    const [layoutRevision, setLayoutRevision] = useState(0);
    const [pageInput, setPageInput] = useState("1");
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
    const pageCacheRef = useRef<ReturnType<typeof createPdfPageCache> | null>(null);
    const quoteGenerationRef = useRef(0);
    const navigationRef = useRef(0);
    const searchRef = useRef<((quotes: QuoteEntry[]) => Promise<void>) | null>(null);
    const preparePageRef = useRef<((number: number) => Promise<boolean>) | null>(null);
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
            searchRef.current = null;
            preparePageRef.current = null;
            quoteGenerationRef.current += 1;
            container.innerHTML = "";
            pagesRef.current = [];
            const lib = await getPdfJs();
            if (generation !== generationRef.current) return;
            const panelWidth = container.clientWidth;
            widthRef.current = panelWidth;
            const cache = pageCacheRef.current!;
            const count = pdf.numPages;
            const target = list.find(({ page }) => Number.isSafeInteger(page) && page! > 0 && page! <= pdf.numPages)?.page
                ?? scrollToPage ?? 1;
            // Only the first page (fit scale) and requested page gate the first paint.
            const [first] = await Promise.all([cache.get(1), cache.get(target)]);
            if (generation !== generationRef.current) return;
            const scale = Math.max(0.1, (panelWidth - SIDE_PADDING) /
                first.getViewport({ scale: 1 }).width) * zoomRef.current;
            const estimate = first.getViewport({ scale });
            const fragment = document.createDocumentFragment();
            let top = 0;
            const pages: RenderedPage[] = Array.from({ length: pdf.numPages }, (_, index) => {
                const known = cache.peek(index + 1);
                const viewport = known?.getViewport({ scale }) ?? estimate;
                const wrapper = document.createElement("div");
                wrapper.className = "shadow-md";
                Object.assign(wrapper.style, {
                    position: "relative", margin: "0 auto 8px", background: "white",
                    width: `${viewport.width}px`, height: `${viewport.height}px`,
                    // Do not display/draw annotations against estimated geometry.
                    visibility: known ? "visible" : "hidden",
                });
                wrapper.dataset.pageNumber = String(index + 1);
                wrapper.dataset.geometryReady = String(!!known);
                wrapper.dataset.legalBlock = "";
                wrapper.dataset.locatorKind = "page";
                wrapper.dataset.locatorValue = String(index + 1);
                wrapper.setAttribute("aria-label", `Page ${index + 1}`);
                fragment.appendChild(wrapper);
                const entry: RenderedPage = {
                    wrapper, textDivs: [], hasTextLayer: false, top, height: viewport.height,
                };
                top += viewport.height + 8;
                return entry;
            });
            container.style.overflowAnchor = "none";
            container.appendChild(fragment);
            pagesRef.current = pages;
            setLayoutRevision(value => value + 1);

            const updateGeometry = () => {
                if (generation !== generationRef.current) return;
                const scroll = scrollRef.current;
                const offset = (scroll?.scrollTop ?? 0) - container.offsetTop;
                let anchor = pageAt(pages, offset);
                // An unresolved page at the top is only an estimate. Prefer an
                // already readable page in view, including a citation below it.
                if (pages[anchor].wrapper.dataset.geometryReady !== "true") {
                    const end = offset + (scroll?.clientHeight || 800);
                    for (let index = anchor + 1; index < pages.length && pages[index].top < end; index++) {
                        if (pages[index].wrapper.dataset.geometryReady === "true") { anchor = index; break; }
                    }
                }
                const fraction = (offset - pages[anchor].top) / pages[anchor].height;
                let top = 0;
                for (const [index, entry] of pages.entries()) {
                    const known = cache.peek(index + 1);
                    if (known && entry.wrapper.dataset.geometryReady !== "true") {
                        const viewport = known.getViewport({ scale });
                        entry.height = viewport.height;
                        Object.assign(entry.wrapper.style, { width: `${viewport.width}px`,
                            height: `${viewport.height}px`, visibility: "visible" });
                        entry.wrapper.dataset.geometryReady = "true";
                    }
                    entry.top = top;
                    top += entry.height + 8;
                }
                // Preserve the exact visible point while distant mixed-size pages resolve.
                if (scroll && offset >= 0) scroll.scrollTop = container.offsetTop +
                    pages[anchor].top + fraction * pages[anchor].height;
            };
            preparePageRef.current = async (number) => {
                try { await cache.get(number); }
                catch (cause) { fail(cause); return false; }
                if (generation !== generationRef.current) return false;
                updateGeometry(); return true;
            };
            scrollToHighlight(pages, scrollRef.current, target);

            function ensureTextLayer(index: number): Promise<void> {
                if (generation !== generationRef.current) return Promise.resolve();
                return pages[index].textLayer ??= renderTextLayer(index);
            }
            async function renderTextLayer(index: number) {
                let element: HTMLDivElement | undefined;
                try {
                    const page = await cache.get(index + 1);
                    if (generation !== generationRef.current) return;
                    updateGeometry();
                    const viewport = page.getViewport({ scale });
                    element = document.createElement("div");
                    element.className = "pdf-text-layer";
                    element.dataset.legalText = String(index + 1);
                    Object.assign(element.style, { position: "absolute", left: "0", top: "0",
                        width: `${viewport.width}px`, height: `${viewport.height}px`,
                        userSelect: "text", pointerEvents: "auto", zIndex: "1" });
                    element.style.setProperty("--scale-factor", String(scale));
                    pages[index].wrapper.appendChild(element);
                    const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(),
                        container: element, viewport });
                    await layer.render();
                    if (generation !== generationRef.current) return;
                    const lines = new Map<string, HTMLDivElement>();
                    for (const div of layer.textDivs) {
                        const top = div.style.top;
                        let line = lines.get(top);
                        if (!line) { line = document.createElement("div"); line.style.display = "contents";
                            line.dataset.legalText = String(index + 1); lines.set(top, line); element.appendChild(line); }
                        line.appendChild(div);
                    }
                    pages[index].textDivs = layer.textDivs;
                    pages[index].hasTextLayer = true;
                } catch (cause) {
                    element?.remove();
                    if (generation === generationRef.current) console.warn("PDF text selection unavailable", cause);
                }
            }

            let geometryStarted = false;
            async function finishGeometry() {
                if (geometryStarted) return;
                geometryStarted = true;
                // Keep the old exact mixed-page layout, but off the first-paint path.
                for (let start = 1; start <= count; start += 16) {
                    if (generation !== generationRef.current) return;
                    await Promise.allSettled(Array.from({ length: Math.min(16, count - start + 1) },
                        (_, index) => cache.get(start + index)));
                    updateGeometry();
                }
            }

            const rendered = new Map<number, HTMLCanvasElement>();
            const failed = new Set<number>();
            const loadingPages = new Set<number>();
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
                        const { margin } = range();
                        const candidates: number[] = [];
                        for (let index = pageAt(pages, start - margin);
                            index < pages.length && pages[index].top <= end + margin; index++) {
                            if (!rendered.has(index) && !failed.has(index) && !loadingPages.has(index)) candidates.push(index);
                        }
                        const distance = (index: number) => Math.max(start - pages[index].top - pages[index].height,
                            pages[index].top - end, 0);
                        const index = candidates.sort((a, b) => distance(a) - distance(b))[0];
                        if (index === undefined) break;
                        const page = cache.peek(index + 1);
                        if (!page) {
                            // A slow nearby page must not hold the renderer when the user
                            // scrolls or jumps elsewhere. Share its load, not its wait.
                            loadingPages.add(index);
                            void cache.get(index + 1).then(() => {
                                loadingPages.delete(index);
                                if (generation !== generationRef.current) return;
                                updateGeometry(); scheduleRef.current?.();
                            }, (cause: unknown) => {
                                loadingPages.delete(index);
                                if (generation !== generationRef.current) return;
                                failed.add(index);
                                pages[index].wrapper.style.visibility = "visible";
                                const message = document.createElement("p");
                                message.setAttribute("role", "alert");
                                message.textContent = `Unable to render page ${index + 1}.`;
                                pages[index].wrapper.appendChild(message);
                                console.warn("PDF page unavailable", cause);
                                setPreparing(false);
                            });
                            continue;
                        }
                        active = index;
                        updateGeometry();
                        if (!nearby(index)) { active = -1; continue; }
                        const viewport = page.getViewport({ scale });
                        const canvas = document.createElement("canvas");
                        const outputScale = Math.min(window.devicePixelRatio || 1,
                            Math.sqrt(MAX_PDF_IMAGE_PIXELS / (viewport.width * viewport.height)));
                        canvas.width = Math.ceil(viewport.width * outputScale);
                        canvas.height = Math.ceil(viewport.height * outputScale);
                        Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
                        const context = canvas.getContext("2d");
                        if (!context) { failed.add(index); continue; }
                        const task = page.render({ canvasContext: context, viewport,
                            transform: [outputScale, 0, 0, outputScale, 0, 0] });
                        taskRef.current = task;
                        try {
                            await task.promise;
                            if (generation !== generationRef.current) {
                                canvas.width = canvas.height = 0; return;
                            }
                            if (!nearby(index, 2)) { canvas.width = canvas.height = 0; continue; }
                            pages[index].wrapper.prepend(canvas);
                            rendered.set(index, canvas);
                            setPreparing(false);
                            void finishGeometry().catch(fail);
                            // Painting is useful before text extraction completes. Selection and
                            // quote search share a single layer, including in ordinary readers.
                            void ensureTextLayer(index);
                        } catch (cause) {
                            canvas.width = canvas.height = 0;
                            if ((cause as { name?: string })?.name !== "RenderingCancelledException") {
                                console.error("PDF render error", cause);
                                failed.add(index);
                                const message = document.createElement("p");
                                message.setAttribute("role", "alert");
                                message.textContent = `Unable to render page ${index + 1}.`;
                                pages[index].wrapper.appendChild(message);
                                setPreparing(false);
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

            searchRef.current = async (entries) => {
                navigationRef.current += 1;
                const quoteGeneration = ++quoteGenerationRef.current;
                const current = () => generation === generationRef.current && quoteGeneration === quoteGenerationRef.current;
                pages.forEach(({ textDivs }) => clearHighlights(textDivs));
                const found = new Map<number, string[]>();
                let focused = false;
                for (const entry of entries) {
                    const hint = Number.isSafeInteger(entry.page) && entry.page! > 0 && entry.page! <= pages.length ? entry.page! - 1 : undefined;
                    if (!quoteSegments(entry.quote).length) continue;
                    const order = [...new Set([...(hint === undefined ? [] : [hint]), ...pages.map((_, index) => index)])];
                    for (const index of order) {
                        if (!current()) return;
                        let text: string;
                        try { text = await cache.normalizedText(index + 1); }
                        catch { continue; } // An unreadable text layer must not hide a readable scan.
                        if (!current()) return;
                        if (!matchesQuoteText(text, entry.quote)) continue;
                        await ensureTextLayer(index);
                        if (!current()) return;
                        const quotes = [...found.get(index) ?? [], entry.quote];
                        if (!highlightQuote(pages[index].textDivs, quotes.join(" … "))) continue;
                        found.set(index, quotes);
                        if (!focused) {
                            focused = true;
                            scrollToHighlight(pages, scrollRef.current, index + 1);
                            scheduleRef.current?.();
                        }
                        break;
                    }
                }
                if (!focused && current()) {
                    const page = entries.find(entry => Number.isSafeInteger(entry.page) && entry.page! > 0 && entry.page! <= pages.length)?.page;
                    if (page && await preparePageRef.current?.(page) && current()) {
                        scrollToHighlight(pages, scrollRef.current, page); scheduleRef.current?.();
                    }
                }
            };
            void searchRef.current(quotesRef.current).catch(fail);
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
            let closest = pageAt(pagesRef.current, center);
            const distance = (index: number) => Math.abs(pagesRef.current[index].top + pagesRef.current[index].height / 2 - center);
            for (const index of [closest - 1, closest + 1])
                if (index >= 0 && index < pagesRef.current.length && distance(index) < distance(closest)) closest = index;
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
        if (error) {
            notifyUnavailable();
            return;
        }
        if (!bytes && !source) return;
        const controller = new AbortController();
        pagesRef.current = [];
        quotesRef.current = quoteList;
        zoomRef.current = 1;
        pageRef.current = 1;
        let cancelled = false;
        let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
        queueMicrotask(() => {
            if (cancelled) return;
            setPreparing(true);
            setZoom(1);
            setCurrentPage(1);
            setNumPages(0);
            setViewerError(null);
        });
        const unavailable = (cause: unknown) => {
            if (cancelled || controller.signal.aborted) return;
            console.error("PDF render error", cause);
            controller.abort();
            generationRef.current += 1;
            taskRef.current?.cancel(); scheduleRef.current = null;
            pdfRef.current = null; pageCacheRef.current = null; pagesRef.current = [];
            searchRef.current = null; preparePageRef.current = null;
            quoteGenerationRef.current += 1; navigationRef.current += 1;
            containerRef.current?.replaceChildren();
            setNumPages(0); setPreparing(false); setViewerError(PDF_VIEWER_ERROR);
            if (loadingTask) void loadingTask.destroy().catch(() => undefined);
            notifyUnavailable();
        };
        void (async () => {
            const [lib, input] = await Promise.all([getPdfJs(), source
                ? source(controller.signal, unavailable) : Promise.resolve({ data: bytes!.slice() })]);
            if (cancelled || controller.signal.aborted) return;
            loadingTask = lib.getDocument({
                ...input,
                isEvalSupported: false,
                maxImageSize: MAX_PDF_IMAGE_PIXELS,
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
            });
            const pdf = await loadingTask.promise;
            if (cancelled || controller.signal.aborted) return void pdf.destroy().catch(() => undefined);
            if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 ||
                pdf.numPages > MAX_PDF_PAGES) {
                await pdf.destroy();
                throw new Error("PDF page count exceeds the viewer limit");
            }
            pageCacheRef.current = createPdfPageCache(pdf);
            pdfRef.current = pdf;
            setNumPages(pdf.numPages);
            await renderPdf(quotesRef.current);
        })().catch(unavailable);
        return () => {
            cancelled = true; controller.abort();
            generationRef.current += 1;
            taskRef.current?.cancel();
            scheduleRef.current = null;
            pageCacheRef.current = null;
            searchRef.current = null;
            preparePageRef.current = null;
            quoteGenerationRef.current += 1;
            pagesRef.current = [];
            containerRef.current?.replaceChildren();
            const pdf = pdfRef.current;
            pdfRef.current = null;
            if (loadingTask) void loadingTask.destroy().catch(() => undefined);
            else void pdf?.destroy().catch(() => undefined);
        };
    }, [bytes, source, error, renderPdf]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        quotesRef.current = quoteList;
        if (!pdfRef.current) return;
        if (searchRef.current) void searchRef.current(quoteList).catch(cause => {
            console.warn("PDF quote lookup unavailable", cause);
        });
        else void renderPdf(quoteList);
    }, [quoteFocusKey, quoteKey]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => setPageInput(String(currentPage)), [currentPage]);
    useEffect(() => {
        const scroll = scrollRef.current;
        if (!annotationEditor || !scroll) return;
        return attachPdfAnnotationLayer(scroll, pagesRef.current.map(page => page.wrapper), annotationEditor);
    }, [annotationEditor?.marks, annotationEditor?.tool, annotationEditor?.selectedId, annotationEditor?.disabled, layoutRevision]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const scroll = scrollRef.current, focus = editorRef.current?.focus;
        const mark = editorRef.current?.marks.find(mark => mark.id === focus?.id);
        if (scroll && mark) {
            const request = ++navigationRef.current;
            quoteGenerationRef.current += 1;
            void preparePageRef.current?.(mark.fragments[0].pageNumber).then((ready) => {
                if (!ready || navigationRef.current !== request) return;
                focusPdfAnnotation(scroll, pagesRef.current.map(page => page.wrapper), mark);
                scheduleRef.current?.();
            });
        }
    }, [annotationEditor?.focus?.request, layoutRevision]);

    function jumpToPage() {
        const number = Number(pageInput);
        if (!Number.isSafeInteger(number) || number < 1 || number > numPages) {
            setPageInput(String(currentPage)); return;
        }
        const request = ++navigationRef.current;
        quoteGenerationRef.current += 1;
        void preparePageRef.current?.(number).then((ready) => {
            if (!ready || navigationRef.current !== request) return;
            scrollToHighlight(pagesRef.current, scrollRef.current, number);
            scheduleRef.current?.();
        });
    }

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
            {((loading) || (preparing && !error && !viewerError)) && (
                <div role="status" className="beaver-loading-indicator pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    <span className="sr-only">Loading PDF…</span>
                </div>
            )}
            <div ref={scrollRef} tabIndex={annotationEditor ? 0 : undefined} style={{ scrollbarGutter: "stable", isolation: "isolate" }} className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-5">
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
                            {annotationEditor ? <label className="flex items-center gap-1 pointer-events-auto">
                                <span className="sr-only">PDF page</span>
                                <input aria-label="PDF page" value={pageInput} inputMode="numeric"
                                    className="w-12 bg-transparent text-center outline-none focus:ring-2 focus:ring-red-600"
                                    onChange={event => setPageInput(event.target.value)}
                                    onKeyDown={event => { if (event.key === "Enter") {
                                        event.preventDefault(); jumpToPage();
                                    } }} onBlur={jumpToPage} /> / {numPages}
                            </label> : <>{currentPage}/{numPages}</>}
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
