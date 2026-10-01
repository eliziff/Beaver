import { createPdfSession, type PdfSession, PDF_ZOOM_MIN as ZOOM_MIN, PDF_ZOOM_MAX as ZOOM_MAX, PDF_ZOOM_STEP as ZOOM_STEP } from '../../../../../../shared/pdf/viewer';
import "pdfjs-dist/web/pdf_viewer.css";
import "../../../../../../shared/pdf/pdfTextLayer.css";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState,
    type MouseEvent as ReactMouseEvent } from "react";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import type { CitationQuote } from "@/app/lib/citations";
import type { PdfRecognizedText } from "@/app/lib/api/documents";
import { clearHighlights, getPdfJs, highlightQuote, STANDARD_FONT_DATA_URL } from "./highlightQuote";
import { PDF_DOCUMENT_OPTIONS, openPdfDocument } from "@/app/lib/pdfJs";
import { createPdfPageCache } from "./pdfPageCache";
import { matchesQuoteText, quoteSegments } from "./quoteText";
import { type PdfAnnotationEditorPort } from "../../../../../../shared/pdf/pdfAnnotationLayer";
import { type PdfPageTextLoader } from "../../../../../../shared/pdf/pdfPageTextLayer";
import { PdfPageNavigation } from "./PdfPageNavigation";
export type PdfByteSource = (signal: AbortSignal, onError: (error: Error) => void) => Promise<
    { data: Uint8Array } | { range: import("pdfjs-dist").PDFDataRangeTransport;
        rangeChunkSize: number; disableStream: true; disableAutoFetch: true }>;

export interface PdfCanvasProps {
    pageLabels?: readonly (string | null)[];
    /** Only PDFs whose labels this product authored may use their embedded /PageLabels directly. */
    authoredPageLabels?: boolean;
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
    onTextReady?: (page: number, element: HTMLElement, focus: boolean) => void;
}


const PDF_VIEWER_ERROR = "Unable to open this PDF. The file may be invalid or unsupported.";
type Layout = PdfSession & { search(quotes: CitationQuote[]): Promise<void> };

export function PdfCanvas({source, bytes, loading = false, error, quotes = [], quoteFocusKey,
    rounded = true, ariaLabel = "PDF document", onUnavailable, annotationEditor,
    recognizedText, loadRecognizedText, pageLabels, authoredPageLabels = false, onTextReady}: PdfCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null), scrollRef = useRef<HTMLDivElement>(null);
    const layoutRef = useRef<Layout | null>(null);
    const previewRef = useRef<HTMLDivElement | null>(null);
    const clearPreview = useCallback(() => {
        previewRef.current?.querySelectorAll('canvas').forEach(canvas => { canvas.width = canvas.height = 0; });
        previewRef.current?.remove(); previewRef.current = null;
    }, []);
    const editorRef = useRef(annotationEditor), quotesRef = useRef(quotes);
    const recognizedPages = useMemo(() => new Map(recognizedText?.pages.map(page => [page.pageNumber, page])), [recognizedText]);
    const recognizedRef = useRef(recognizedPages), textLoaderRef = useRef(loadRecognizedText);
    const navigationRef = useRef(0), quoteGenerationRef = useRef(0);
    const focusedRequestRef = useRef<number | undefined>(undefined);
    const [layoutRevision, setLayoutRevision] = useState(0);
    const [preparing, setPreparing] = useState(true), [viewerError, setViewerError] = useState<string | null>(null);
    const [zoom, setZoom] = useState(1), [currentPage, setCurrentPage] = useState(1), [numPages, setNumPages] = useState(0);
    const [embeddedPageLabels, setEmbeddedPageLabels] = useState<readonly (string | null)[]>();
    const notifyUnavailable = useEffectEvent(() => onUnavailable?.());
    const notifyTextReady = useEffectEvent((page: number, element: HTMLElement, focus = false) => onTextReady?.(page, element, focus));
    useLayoutEffect(() => { setEmbeddedPageLabels(undefined); }, [bytes, source, authoredPageLabels]);
    useLayoutEffect(() => {
        editorRef.current = annotationEditor; quotesRef.current = quotes;
        recognizedRef.current = recognizedPages; textLoaderRef.current = loadRecognizedText;
    });

    useEffect(() => {
        if (error) { notifyUnavailable(); return; }
        if (!bytes && !source) return;
        const controller = new AbortController(), {signal} = controller;
        let viewer: PDFViewer | undefined;
        let session: PdfSession | undefined;
        let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
        const dispose = (retain = false) => {
            const scroll = scrollRef.current;
            if (retain && scroll && viewer?.pagesCount) {
                const bounds = scroll.getBoundingClientRect(), preview = document.createElement('div');
                Object.assign(preview.style, {position:'absolute',inset:'0',overflow:'hidden',pointerEvents:'none'});
                preview.dataset.pdfPreview = ''; preview.inert = true;
                for (const canvas of scroll.querySelectorAll('canvas')) {
                    const rect = canvas.getBoundingClientRect();
                    if (!canvas.width || rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
                    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
                    copy.getContext('2d')?.drawImage(canvas, 0, 0);
                    Object.assign(copy.style, {position:'absolute',left:`${rect.left-bounds.left}px`,top:`${rect.top-bounds.top}px`,
                        width:`${rect.width}px`,height:`${rect.height}px`}); preview.append(copy);
                }
                if (preview.childElementCount) { clearPreview(); scroll.parentElement!.append(preview); previewRef.current = preview; }
            }
            controller.abort(); quoteGenerationRef.current++; navigationRef.current++;
            if (layoutRef.current?.viewer === viewer) layoutRef.current = null;
            session?.destroy();
            void task?.destroy().catch(() => undefined);
        };
        const fail = (cause: unknown) => {
            if (signal.aborted) return;
            console.error("PDF render error", cause); clearPreview(); dispose();
            setPreparing(false); setNumPages(0); setViewerError(PDF_VIEWER_ERROR); notifyUnavailable();
        };
        queueMicrotask(() => {
            if (signal.aborted) return;
            setPreparing(true); setViewerError(null); setZoom(1); setCurrentPage(1);
        });
        void (async () => {
            const [lib, input] = await Promise.all([getPdfJs(), source ? source(signal, fail) : {data:bytes!}]);
            if (signal.aborted) return;
            const {PDFViewer, EventBus} = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
            if (signal.aborted) return;
            task = openPdfDocument(lib, input, {...PDF_DOCUMENT_OPTIONS,
                standardFontDataUrl:STANDARD_FONT_DATA_URL});
            const pdf = await task.promise;
            if (signal.aborted) return;
            if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 2000)
                throw new Error("PDF page count exceeds the viewer limit");
            if (authoredPageLabels) void pdf.getPageLabels().then(labels => {
                if (!signal.aborted && labels?.length === pdf.numPages) setEmbeddedPageLabels(labels);
            }).catch(() => { /* Printed labels are optional; physical navigation remains available. */ });
            const cache = createPdfPageCache(pdf), found = new Map<number, CitationQuote[]>();
            session = createPdfSession({lib:{PDFViewer,EventBus},TextLayer:lib.TextLayer,pdf,
                container:scrollRef.current!,element:containerRef.current!,signal,
                readEditor:() => editorRef.current,readText:number => recognizedRef.current.get(number),
                readTextLoader:() => textLoaderRef.current,
                onTextReady:(number,element) => {
                    highlightQuote(element,found.get(number) ?? []); notifyTextReady(number, element);
                },
                onZoom:setZoom,onPage:number => { setCurrentPage(number);  },
                onRendered:() => { clearPreview(); setPreparing(false); },onError:fail});
            viewer = session.viewer;
            const {viewer:current,pages,preparePage,ensureText} = session;
            const search = async (entries: CitationQuote[]) => {
                const request = ++quoteGenerationRef.current;
                const live = () => !signal.aborted && request === quoteGenerationRef.current;
                pages.forEach(clearHighlights); found.clear(); let focused = false;
                for (const entry of entries) {
                    const hint = Number.isSafeInteger(entry.page) && entry.page! > 0 && entry.page! <= pages.length ? entry.page : undefined;
                    if (!quoteSegments(entry.quote).length) continue;
                    for (const number of new Set([...(hint ? [hint] : []), ...pages.map((_, i) => i + 1)])) {
                        if (!live()) return;
                        let text: string;
                        try { text = await cache.normalizedText(number); } catch { continue; }
                        if (!live()) return;
                        if (!matchesQuoteText(text, entry.quote) || !await preparePage(number)) continue;
                        const matches = [...found.get(number) ?? [], entry]; found.set(number, matches);
                        await ensureText(number);
                        if (!live()) return;
                        if (!highlightQuote(pages[number - 1], matches)) continue;
                        if (!focused && !entry.color) {
                            current.scrollPageIntoView({pageNumber:number}); focused = true;
                            const mark = pages[number - 1].querySelector<HTMLElement>('.pdf-text-highlight');
                            if (mark) mark.scrollIntoView({block:'center'});
                        }
                        notifyTextReady(number, pages[number - 1], true);
                        break;
                    }
                }
                const hint = entries.find(entry => !entry.color && Number.isSafeInteger(entry.page) && entry.page! > 0 && entry.page! <= pages.length)?.page;
                if (!focused && hint && live() && await preparePage(hint) && live()) current.scrollPageIntoView({pageNumber:hint});
            };
            const layout: Layout = Object.assign(session, {search});
            layoutRef.current = layout;
            await session.ready;
            if (signal.aborted) return;
            setNumPages(pdf.numPages); setLayoutRevision(value => value + 1);
            void search(quotesRef.current).catch(fail);
        })().catch(fail);
        return () => dispose(true);
    }, [bytes, source, error, clearPreview, authoredPageLabels]);
    useEffect(() => clearPreview, [clearPreview]);

    const quoteKey = JSON.stringify(quotes);
    useEffect(() => { void layoutRef.current?.search(quotesRef.current); }, [quoteKey, quoteFocusKey]);
    useEffect(() => { layoutRef.current?.refreshText(); }, [recognizedPages, loadRecognizedText]);
    useEffect(() => { layoutRef.current?.updateAnnotations(); }, [annotationEditor, layoutRevision]);
    useEffect(() => {
        const layout = layoutRef.current, scroll = scrollRef.current, focus = annotationEditor?.focus;
        const mark = annotationEditor?.marks.find(mark => mark.id === focus?.id);
        if (!layout || !scroll || !mark || !focus || focus.request === focusedRequestRef.current) return;
        const request = ++navigationRef.current; quoteGenerationRef.current++;
        void layout.focusAnnotation(mark).then(ready => {
            if (!ready || layoutRef.current !== layout || request !== navigationRef.current) return;
            focusedRequestRef.current = focus.request;
        });
    }, [annotationEditor?.focus?.request, layoutRevision]);
    function jumpToPage(number: number) {
        const layout = layoutRef.current;
        if (loading || preparing || error || viewerError || !layout) return;
        if (!Number.isSafeInteger(number) || number < 1 || number > numPages) return;
        quoteGenerationRef.current++;
        void layout.navigate(number);
    }
    function changeZoom(event: ReactMouseEvent<HTMLButtonElement>) {
        if (loading || error || viewerError) return;
        const layout = layoutRef.current;
        if (layout) layout.setZoom(layout.zoom + Number(event.currentTarget.value));
    }
    return (
        <section
            className={`relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gray-100 ${rounded ? "rounded-lg" : ""}`}
            aria-label={ariaLabel}
        >
            {numPages === 0 && ((loading) || (preparing && !error && !viewerError)) && (
                <div role="status" className="beaver-loading-indicator pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    <span className="sr-only">Loading PDF…</span>
                </div>
            )}
            <div ref={scrollRef} tabIndex={annotationEditor ? 0 : undefined} style={{ position: "absolute", scrollbarGutter: "stable", isolation: "isolate" }} className="absolute inset-x-0 top-0 bottom-9 overflow-auto p-3 beaver-pdf-scroll">
                {(error || viewerError) && (
                    <div role="alert" className="flex h-full items-center justify-center">
                        <p className="max-w-sm px-6 text-center text-sm text-red-600">
                            {error || viewerError}</p>
                    </div>
                )}
                <div ref={containerRef} className="pdfViewer" />
            </div>
            {/* Page and zoom controls keep a strip of their own below the pages, so they never cover text. */}
            <div className="absolute inset-x-0 bottom-0 flex h-9 items-center justify-between gap-2 border-t border-gray-200 bg-white px-2">
            {numPages > 0 && (
                <>
                    <div className="min-w-0">
                        <PdfPageNavigation page={currentPage} count={numPages} labels={pageLabels ?? recognizedText?.pageLabels ?? embeddedPageLabels}
                            disabled={loading || preparing || !!error || !!viewerError} onNavigate={jumpToPage} />
                    </div>
                    <div className="flex shrink-0 items-center gap-px">
                        <button type="button" onClick={changeZoom} value={-ZOOM_STEP}
                            aria-disabled={loading || !!error || !!viewerError || zoom <= ZOOM_MIN} aria-label="Zoom out"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 aria-disabled:opacity-30">
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-10 select-none text-center text-[0.8125rem] font-medium tabular-nums text-gray-600">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button type="button" onClick={changeZoom} value={ZOOM_STEP}
                            aria-disabled={loading || !!error || !!viewerError || zoom >= ZOOM_MAX} aria-label="Zoom in"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 aria-disabled:opacity-30">
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
            </div>
        </section>
    );
}
