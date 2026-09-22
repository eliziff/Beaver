import "./pdfTextLayer.css";
import {
    useCallback,
    useEffect,
    useEffectEvent,
    useMemo,
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
import { createPdfPageTextLayer, type PdfPageTextLoader } from "./pdfPageTextLayer";
import { attachPdfTextSelection } from "./pdfTextSelection";
import type { PdfRecognizedText } from "@/app/lib/api/documents";

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
    recognizedText?: PdfRecognizedText;
    loadRecognizedText?: PdfPageTextLoader;
}

type RenderedPage = {
    wrapper: HTMLDivElement;
    top: number;
    height: number;
};

/** All commands/resources expire together on zoom, resize or source replacement. */
type PdfLayout = {
    pages: RenderedPage[];
    schedule(): void;
    refreshText(): void;
    destroy(): void;
    preparePage(number: number): Promise<boolean>;
    search(quotes: CitationQuote[]): Promise<void>;
};

const SIDE_PADDING = 20;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
const MAX_PDF_IMAGE_PIXELS = 40_000_000;
// Output-scale limits follow PDF.js PDFPageView; the budget includes the in-flight canvas.
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_RESIDENT_PIXELS = 24_000_000;
const MAX_PDF_PAGES = 2_000;
const PDF_VIEWER_ERROR =
    "Unable to open this PDF. The file may be invalid or unsupported.";
const clampZoom = (value: number) =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

function scrollToHighlight(pages: RenderedPage[], scrollElement: HTMLDivElement | null,
    pageNumber: number) {
    const page = pages[pageNumber - 1];
    if (!page || !scrollElement) return;
    const highlight = page.wrapper.querySelector<HTMLElement>(".pdf-text-highlight");
    const rect = (highlight ?? page.wrapper).getBoundingClientRect();
    const containerRect = scrollElement.getBoundingClientRect();
    scrollElement.scrollTo({
        top: Math.max(0, scrollElement.scrollTop + rect.top - containerRect.top +
            (highlight ? (rect.height - scrollElement.clientHeight) / 2 : 0)),
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
    recognizedText,
    loadRecognizedText,
    rounded = true,
    ariaLabel = "PDF document",
    onUnavailable,
}: PdfCanvasProps) {
    const recognizedPages = useMemo(() => new Map(recognizedText?.pages.map(page => [page.pageNumber, page])), [recognizedText]);
    const recognizedRef = useRef(recognizedPages); recognizedRef.current = recognizedPages;
    const textLoaderRef = useRef(loadRecognizedText); textLoaderRef.current = loadRecognizedText;
    const layoutRef = useRef<PdfLayout | null>(null);
    const editorRef = useRef(annotationEditor);
    editorRef.current = annotationEditor;
    const annotationLayerRef = useRef<ReturnType<typeof attachPdfAnnotationLayer> | null>(null);
    const [layoutRevision, setLayoutRevision] = useState(0);
    const [pageInput, setPageInput] = useState("1");
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const pdfRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
    const quotesRef = useRef<CitationQuote[]>([]);
    const zoomRef = useRef(1);
    const pageRef = useRef(1);
    const generationRef = useRef(0);
    const widthRef = useRef(0);
    const pageCacheRef = useRef<ReturnType<typeof createPdfPageCache> | null>(null);
    const quoteGenerationRef = useRef(0);
    const navigationRef = useRef(0);
    const quoteList = quotes ?? [];
    const quoteKey = JSON.stringify(quoteList);
    const [preparing, setPreparing] = useState(true);
    const [zoom, setZoom] = useState(1);
    const [currentPage, setCurrentPage] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [viewerError, setViewerError] = useState<string | null>(null);
    const notifyUnavailable = useEffectEvent(() => onUnavailable?.());

    const renderPdf = useCallback(async (list: CitationQuote[], scrollToPage?: number) => {
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
            quoteGenerationRef.current += 1;
            layoutRef.current?.destroy(); layoutRef.current = null;
            container.replaceChildren();
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
                    // Do not display/draw annotations against estimated geometry. A resolved page
                    // inherits its visibility: it must never re-show itself inside a panel — a dock
                    // tab the reader is not on — that hid the whole reader.
                    visibility: known ? "" : "hidden",
                });
                wrapper.dataset.pageNumber = String(index + 1);
                wrapper.dataset.pdfScale = String(scale);
                wrapper.dataset.geometryReady = String(!!known);
                wrapper.dataset.legalBlock = "";
                wrapper.dataset.locatorKind = "page";
                wrapper.dataset.locatorValue = String(index + 1);
                wrapper.setAttribute("aria-label", `Page ${index + 1}`);
                fragment.appendChild(wrapper);
                const entry: RenderedPage = {
                    wrapper, top, height: viewport.height,
                };
                top += viewport.height + 8;
                return entry;
            });
            container.style.overflowAnchor = "none";
            container.appendChild(fragment);
            setLayoutRevision(value => value + 1);

            let geometryVersion = cache.size;
            const updateGeometry = () => {
                if (generation !== generationRef.current || geometryVersion === cache.size) return;
                geometryVersion = cache.size;
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
                            height: `${viewport.height}px`, visibility: "" });
                        entry.wrapper.dataset.geometryReady = "true";
                    }
                    entry.top = top;
                    top += entry.height + 8;
                }
                // Preserve the exact visible point while distant mixed-size pages resolve.
                if (scroll && offset >= 0) scroll.scrollTop = container.offsetTop +
                    pages[anchor].top + fraction * pages[anchor].height;
            };
            const preparePage = async (number: number) => {
                try { await cache.get(number); }
                catch (cause) { fail(cause); return false; }
                if (generation !== generationRef.current) return false;
                updateGeometry(); return true;
            };
            scrollToHighlight(pages, scrollRef.current, target);

            const textLayers = new Map<number, ReturnType<typeof createPdfPageTextLayer>>();
            const pageQuotes = new Map<number, CitationQuote[]>();
            const releaseTextLayer = (index: number) => {
                textLayers.get(index)?.destroy(); textLayers.delete(index);
            };
            const ensureTextLayer = (index: number) => {
                if (generation !== generationRef.current) return Promise.resolve();
                let layer = textLayers.get(index);
                if (!layer) {
                    layer = createPdfPageTextLayer({wrapper:pages[index].wrapper, page:cache.get(index + 1),
                        pageNumber:index + 1, scale, TextLayer:lib.TextLayer,
                        source:recognizedRef.current.get(index + 1), loader:textLoaderRef.current,
                        onReady:() => {
                            updateGeometry();
                            const found = pageQuotes.get(index);
                            if (found) highlightQuote(pages[index].wrapper, found);
                        }});
                    textLayers.set(index, layer);
                }
                return layer.ready;
            };
            const refreshText = () => {
                for (const [index, layer] of textLayers)
                    layer.refresh(recognizedRef.current.get(index + 1), textLoaderRef.current);
            };

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
                    // Yield between metadata batches so a large PDF cannot monopolize input/rendering.
                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
            }

            const rendered = new Map<number, HTMLCanvasElement>();
            let rendering: { index: number; canvas: HTMLCanvasElement; task: import("pdfjs-dist").RenderTask } | undefined;
            const destroy = () => {
                if (rendering) { rendering.task.cancel(); rendering.canvas.width = rendering.canvas.height = 0; }
                for (const index of textLayers.keys()) releaseTextLayer(index);
                for (const canvas of rendered.values()) { canvas.width = canvas.height = 0; canvas.remove(); }
                rendered.clear();
            };
            const failed = new Set<number>();
            const loadingPages = new Set<number>();
            let running = false;
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
            const rasterPlan = () => {
                const { start, end, margin } = range();
                const indices = new Set<number>();
                for (let index = pageAt(pages, start - margin);
                    index < pages.length && pages[index].top <= end + margin; index++)
                    if (pages[index].top + pages[index].height >= start - margin) indices.add(index);
                const pixels = Math.floor(Math.min(MAX_CANVAS_PIXELS, MAX_RESIDENT_PIXELS / Math.max(1, indices.size)));
                for (const [index, canvas] of rendered) {
                    if (indices.has(index) && canvas.width * canvas.height <= pixels) continue;
                    canvas.remove(); canvas.width = canvas.height = 0; rendered.delete(index);
                    if (index !== rendering?.index) cache.peek(index + 1)?.cleanup?.();
                }
                return { indices, pixels };
            };
            const paint = async () => {
                if (running || generation !== generationRef.current) return;
                running = true;
                try {
                    while (generation === generationRef.current) {
                        const { start, end } = range(), plan = rasterPlan();
                        let index: number | undefined, nearest = Infinity;
                        for (const candidate of plan.indices) {
                            if (rendered.has(candidate) || failed.has(candidate) || loadingPages.has(candidate)) continue;
                            const distance = Math.max(start - pages[candidate].top - pages[candidate].height,
                                pages[candidate].top - end, 0);
                            if (distance < nearest) { index = candidate; nearest = distance; }
                        }
                        if (index === undefined) break;
                        const page = cache.peek(index + 1);
                        if (!page) {
                            // A slow nearby page must not hold the renderer when the user
                            // scrolls or jumps elsewhere. Share its load, not its wait.
                            loadingPages.add(index);
                            void cache.get(index + 1).then(() => {
                                loadingPages.delete(index);
                                if (generation !== generationRef.current) return;
                                updateGeometry(); schedule();
                            }, (cause: unknown) => {
                                loadingPages.delete(index);
                                if (generation !== generationRef.current) return;
                                failed.add(index);
                                pages[index].wrapper.style.visibility = "";
                                const message = document.createElement("p");
                                message.setAttribute("role", "alert");
                                message.textContent = `Unable to render page ${index + 1}.`;
                                pages[index].wrapper.appendChild(message);
                                console.warn("PDF page unavailable", cause);
                                setPreparing(false);
                            });
                            continue;
                        }
                        updateGeometry();
                        if (!nearby(index)) continue;
                        const viewport = page.getViewport({ scale });
                        const canvas = document.createElement("canvas");
                        const outputScale = Math.min(window.devicePixelRatio || 1,
                            Math.sqrt(plan.pixels / (viewport.width * viewport.height)));
                        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
                        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
                        Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
                        const context = canvas.getContext("2d");
                        if (!context) { canvas.width = canvas.height = 0; failed.add(index); continue; }
                        let task: import("pdfjs-dist").RenderTask | undefined;
                        try {
                            task = page.render({ canvasContext: context, viewport,
                                transform: [outputScale, 0, 0, outputScale, 0, 0] });
                            rendering = {index, canvas, task};
                            await task.promise;
                            if (generation !== generationRef.current) {
                                canvas.width = canvas.height = 0; return;
                            }
                            const currentPlan = rasterPlan();
                            if (!currentPlan.indices.has(index) || canvas.width * canvas.height > currentPlan.pixels) {
                                canvas.width = canvas.height = 0; continue;
                            }
                            pages[index].wrapper.prepend(canvas);
                            rendered.set(index, canvas);
                            setPreparing(false);
                            void finishGeometry().catch(fail);
                            // Painting is useful before text extraction completes. Selection and
                            // quote search share a single layer, including in ordinary readers.
                            void ensureTextLayer(index);
                        } catch (cause) {
                            canvas.width = canvas.height = 0;
                            if (generation === generationRef.current && (cause as { name?: string })?.name !== "RenderingCancelledException") {
                                console.error("PDF render error", cause);
                                failed.add(index);
                                const message = document.createElement("p");
                                message.setAttribute("role", "alert");
                                message.textContent = `Unable to render page ${index + 1}.`;
                                pages[index].wrapper.appendChild(message);
                                setPreparing(false);
                            }
                        } finally {
                            if (!rendered.has(index)) canvas.width = canvas.height = 0;
                            if (rendering?.canvas === canvas) rendering = undefined;
                        }
                    }
                } finally { running = false; }
            };
            const schedule = () => {
                // Retain only nearby bitmaps/text, plus any live selection crossing pages.
                const selection = document.getSelection();
                const selected = (index: number) => {
                    if (!selection || selection.isCollapsed) return false;
                    for (let i = 0; i < selection.rangeCount; i++)
                        if (selection.getRangeAt(i).intersectsNode(pages[index].wrapper)) return true;
                    return false;
                };
                for (const [index, canvas] of rendered) {
                    if (nearby(index, 2)) continue;
                    canvas.remove(); canvas.width = canvas.height = 0; rendered.delete(index);
                    if (index !== rendering?.index) cache.peek(index + 1)?.cleanup?.();
                }
                for (const index of textLayers.keys()) {
                    if (nearby(index, 2) || selected(index)) continue;
                    releaseTextLayer(index);
                    if (index !== rendering?.index) cache.peek(index + 1)?.cleanup?.();
                }
                if (rendering && !nearby(rendering.index)) rendering.task.cancel();
                void paint().catch(fail);
            };

            const search = async (entries: CitationQuote[]) => {
                navigationRef.current += 1;
                const quoteGeneration = ++quoteGenerationRef.current;
                const current = () => generation === generationRef.current && quoteGeneration === quoteGenerationRef.current;
                pages.forEach(({ wrapper }) => clearHighlights(wrapper));
                pageQuotes.clear();
                const found = pageQuotes;
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
                        const quotes = [...found.get(index) ?? [], entry];
                        if (!highlightQuote(pages[index].wrapper, quotes)) continue;
                        found.set(index, quotes);
                        if (!focused && !entry.color) {
                            focused = true;
                            scrollToHighlight(pages, scrollRef.current, index + 1);
                            schedule();
                        }
                        break;
                    }
                }
                if (current()) schedule();
                if (!focused && current()) {
                    const page = entries.find(entry => !entry.color && Number.isSafeInteger(entry.page) && entry.page! > 0 && entry.page! <= pages.length)?.page;
                    if (page && await preparePage(page) && current()) {
                        scrollToHighlight(pages, scrollRef.current, page); schedule();
                    }
                }
            };
            layoutRef.current = {pages, schedule, refreshText, destroy, preparePage, search};
            schedule();
            void search(quotesRef.current).catch(fail);
        } catch (cause) { fail(cause); }
    }, []);

    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        let frame: number | null = null;
        const updatePage = () => {
            frame = null;
            const layout = layoutRef.current;
            if (!layout) return;
            layout.schedule();
            const pages = layout.pages;
            const center = element.scrollTop - (containerRef.current?.offsetTop ?? 0) + element.clientHeight / 2;
            let closest = pageAt(pages, center);
            const distance = (index: number) => Math.abs(pages[index].top + pages[index].height / 2 - center);
            for (const index of [closest - 1, closest + 1])
                if (index >= 0 && index < pages.length && distance(index) < distance(closest)) closest = index;
            const page = closest + 1;
            if (page === pageRef.current) return;
            pageRef.current = page;
            setCurrentPage(page);
        };
        const onScroll = () => {
            if (frame === null) frame = requestAnimationFrame(updatePage);
        };
        element.addEventListener("scroll", onScroll, { passive: true });
        // pdf.js's text-selection rule (TextLayerBuilder): while a drag is under way the layer
        // carries "selecting" and its endOfContent block sits right after the anchor span, so
        // the browser sweeps whole lines instead of hopping between absolutely placed spans.
        const detachSelection = attachPdfTextSelection(element, () =>
            !editorRef.current?.disabled && editorRef.current?.tool !== "draw");
        const layers = () => element.querySelectorAll<HTMLElement>(".pdf-text-layer");
        const reset = (layer: HTMLElement) => {
            const end = layer.querySelector<HTMLElement>(":scope .endOfContent");
            if (end) { if (end.parentNode !== layer || end.nextSibling) layer.append(end);
                end.style.width = end.style.height = ""; }
            layer.classList.remove("selecting");
        };
        let previous: Range | null = null;
        const endSelecting = () => { layers().forEach(reset); previous = null; };
        const onSelectionChange = () => {
            const selection = document.getSelection();
            if (!selection?.rangeCount || selection.isCollapsed || !element.contains(selection.anchorNode)) { endSelecting(); return; }
            const range = selection.getRangeAt(0);
            if (previous?.startContainer.isConnected && range.compareBoundaryPoints(Range.START_TO_START, previous) === 0 &&
                range.compareBoundaryPoints(Range.END_TO_END, previous) === 0) return;
            layers().forEach((layer) => range.intersectsNode(layer) ? layer.classList.add("selecting") : reset(layer));
            const modifyStart = !!previous && (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
                range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
            let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
            if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
            const layer = (anchor as Element | null)?.parentElement?.closest<HTMLElement>(".pdf-text-layer");
            const end = layer?.querySelector<HTMLElement>(":scope .endOfContent");
            if (layer && end && anchor) {
                end.style.width = layer.style.width; end.style.height = layer.style.height;
                const before = modifyStart ? anchor : anchor.nextSibling;
                if (before !== end && (end.parentNode !== anchor.parentNode || end.nextSibling !== before))
                    anchor.parentElement!.insertBefore(end, before);
            }
            previous = range.cloneRange();
        };
        document.addEventListener("selectionchange", onSelectionChange);
        document.addEventListener("pointerup", endSelecting);
        window.addEventListener("blur", endSelecting);
        return () => {
            detachSelection(); previous = null;
            element.removeEventListener("scroll", onScroll);
            document.removeEventListener("selectionchange", onSelectionChange);
            document.removeEventListener("pointerup", endSelecting);
            window.removeEventListener("blur", endSelecting);
            if (frame !== null) cancelAnimationFrame(frame);
            generationRef.current += 1;
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
            const delta = event.deltaMode === 0 ? event.deltaY / 300 : event.deltaY * 0.1;
            const next = clampZoom(zoomRef.current * Math.exp(-delta));
            if (next === zoomRef.current) return;
            zoomRef.current = next;
            setZoom(next);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void renderPdf(quotesRef.current, pageRef.current), 150);
        };
        let initialDistance = 0;
        let initialZoom = 1;
        const touchDistance = (touches: TouchList) => Math.hypot(
            touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
        const onTouchStart = (event: TouchEvent) => {
            if (event.touches.length !== 2) return;
            initialDistance = touchDistance(event.touches);
            initialZoom = zoomRef.current;
        };
        const onTouchMove = (event: TouchEvent) => {
            if (event.touches.length !== 2 || !initialDistance) return;
            event.preventDefault();
            const next = clampZoom(initialZoom * touchDistance(event.touches) / initialDistance);
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
        if (error) { notifyUnavailable(); return; }
        if (!bytes && !source) return;
        const controller = new AbortController();
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
        /** Abandon every in-flight render and drop the DOM for this document. */
        const teardown = () => {
            generationRef.current += 1; quoteGenerationRef.current += 1;
            layoutRef.current?.destroy(); layoutRef.current = null;
            pageCacheRef.current = null;
            containerRef.current?.replaceChildren();
        };
        const unavailable = (cause: unknown) => {
            if (cancelled || controller.signal.aborted) return;
            console.error("PDF render error", cause);
            controller.abort(); teardown();
            pdfRef.current = null; navigationRef.current += 1;
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
            cancelled = true; controller.abort(); teardown();
            const pdf = pdfRef.current;
            pdfRef.current = null;
            if (loadingTask) void loadingTask.destroy().catch(() => undefined);
            else void pdf?.destroy().catch(() => undefined);
        };
    }, [bytes, source, error, renderPdf]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        quotesRef.current = quoteList;
        if (!pdfRef.current) return;
        // An initializing layout reads quotesRef when ready; do not restart its load.
        void layoutRef.current?.search(quoteList).catch(cause => {
            console.warn("PDF quote lookup unavailable", cause);
        });
    }, [quoteFocusKey, quoteKey]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { layoutRef.current?.refreshText(); }, [recognizedPages, loadRecognizedText]);

    useEffect(() => setPageInput(String(currentPage)), [currentPage]);
    useEffect(() => {
        const scroll = scrollRef.current;
        const layout = layoutRef.current;
        if (!annotationEditor || !scroll || !layout) return;
        const layer = attachPdfAnnotationLayer(scroll, layout.pages.map(page => page.wrapper), () => editorRef.current!);
        annotationLayerRef.current = layer;
        return () => { layer.destroy(); annotationLayerRef.current = null; };
    }, [!!annotationEditor, layoutRevision]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { annotationLayerRef.current?.update(); },
        [annotationEditor?.marks, annotationEditor?.tool, annotationEditor?.selectedId, annotationEditor?.disabled]);
    useEffect(() => {
        const scroll = scrollRef.current, focus = editorRef.current?.focus;
        const mark = editorRef.current?.marks.find(mark => mark.id === focus?.id);
        const layout = layoutRef.current;
        if (scroll && mark && layout) {
            const request = ++navigationRef.current;
            quoteGenerationRef.current += 1;
            void layout.preparePage(mark.fragments[0].pageNumber).then((ready) => {
                if (!ready || layoutRef.current !== layout || navigationRef.current !== request) return;
                focusPdfAnnotation(scroll, layout.pages.map(page => page.wrapper), mark);
                layout.schedule();
            });
        }
    }, [annotationEditor?.focus?.request, layoutRevision]);

    function jumpToPage() {
        const number = Number(pageInput);
        if (!Number.isSafeInteger(number) || number < 1 || number > numPages) {
            setPageInput(String(currentPage)); return;
        }
        const layout = layoutRef.current;
        if (!layout) return;
        const request = ++navigationRef.current;
        quoteGenerationRef.current += 1;
        void layout.preparePage(number).then((ready) => {
            if (!ready || layoutRef.current !== layout || navigationRef.current !== request) return;
            scrollToHighlight(layout.pages, scrollRef.current, number);
            layout.schedule();
        });
    }

    function changeZoom(event: ReactMouseEvent<HTMLButtonElement>) {
        const next = clampZoom(zoomRef.current + Number(event.currentTarget.value));
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
                            {error || viewerError}</p>
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
                        <button type="button" onClick={changeZoom} value={-ZOOM_STEP}
                            disabled={zoom <= ZOOM_MIN} aria-label="Zoom out"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 disabled:opacity-30">
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-9 select-none text-center text-xs font-medium tabular-nums text-gray-600">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button type="button" onClick={changeZoom} value={ZOOM_STEP}
                            disabled={zoom >= ZOOM_MAX} aria-label="Zoom in"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 disabled:opacity-30">
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}
