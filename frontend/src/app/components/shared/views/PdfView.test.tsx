import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cancelled: 0,
    rendered: [] as number[],
    textPages: [] as number[],
    textDelay: 0,
    textError: null as Error | null,
    renderDelay: 20,
    clientWidth: 620,
    buffer: new ArrayBuffer(8),
    documentError: null as Error | null,
    hookCalls: 0,
    numPages: 3,
    pageRequests: [] as number[],
    pdfDataLength: 0,
    pdfOptions: null as Record<string, unknown> | null,
    resize: null as ResizeObserverCallback | null,
    standardFontDataUrl: "",
}));

let fileResult: { type: "pdf"; buffer: ArrayBuffer };
vi.mock("@/app/hooks/useDocumentFile", () => ({
    useDocumentFile: () => {
        mocks.hookCalls += 1;
        return {
            result: fileResult,
            loading: false,
            error: null,
        };
    },
}));

vi.mock("./highlightQuote", () => {
    const pdf = {
        get numPages() { return mocks.numPages; },
        destroy: vi.fn(),
        getPage: async (pageNumber: number) => {
            mocks.pageRequests.push(pageNumber);
            return {
                getViewport: ({ scale }: { scale: number }) => ({
                    width: 600 * scale,
                    height: (pageNumber % 2 ? 800 : 1000) * scale,
                }),
                render: () => {
                    mocks.rendered.push(pageNumber);
                    let reject!: (error: unknown) => void;
                    let timer: ReturnType<typeof setTimeout>;
                    const promise = new Promise<void>((resolve, rejectPromise) => {
                        reject = rejectPromise;
                        timer = setTimeout(resolve, mocks.renderDelay);
                    });
                    return {
                        promise,
                        cancel: () => {
                            clearTimeout(timer);
                            mocks.cancelled += 1;
                            reject({ name: "RenderingCancelledException" });
                        },
                    };
                },
                streamTextContent: () => ({ pageNumber }),
            };
        },
    };
    class TextLayer {
        textDivs: HTMLElement[] = [];
        private container: HTMLElement;
        private pageNumber: number;
        constructor({
            container,
            textContentSource,
        }: {
            container: HTMLElement;
            textContentSource: { pageNumber: number };
        }) {
            this.container = container;
            this.pageNumber = textContentSource.pageNumber;
        }
        async render() {
            mocks.textPages.push(this.pageNumber);
            if (mocks.textDelay) await new Promise((resolve) => setTimeout(resolve, mocks.textDelay));
            if (mocks.textError) throw mocks.textError;
            const span = document.createElement("span");
            span.textContent = `Page ${this.pageNumber} text`;
            this.container.appendChild(span);
            this.textDivs = [span];
        }
        static cleanup() {}
    }
    return {
        clearHighlights: vi.fn(),
        highlightQuote: vi.fn(() => false),
        STANDARD_FONT_DATA_URL: `${location.origin}/pdfjs-standard-fonts/`,
        getPdfJs: vi.fn(async () => ({
            TextLayer,
            getDocument: (options: {
                data: Uint8Array;
                isEvalSupported: boolean;
                maxImageSize: number;
                standardFontDataUrl: string;
            }) => {
                const { data, standardFontDataUrl } = options;
                mocks.pdfOptions = options;
                mocks.pdfDataLength = data.byteLength;
                mocks.standardFontDataUrl = standardFontDataUrl;
                structuredClone(data.buffer, { transfer: [data.buffer] });
                return {
                    destroy: vi.fn(),
                    promise: mocks.documentError
                        ? Promise.reject(mocks.documentError)
                        : Promise.resolve(pdf),
                };
            },
        })),
    };
});

import { PdfView } from "./PdfView";

class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
        mocks.resize = callback;
    }
    observe() {}
    disconnect() {}
}

describe("PdfView", () => {
    beforeEach(() => {
        mocks.cancelled = 0;
        mocks.rendered = [];
        mocks.textPages = [];
        mocks.textDelay = 0;
        mocks.textError = null;
        mocks.renderDelay = 20;
        mocks.clientWidth = 620;
        mocks.buffer = new ArrayBuffer(8);
        fileResult = { type: "pdf", buffer: mocks.buffer };
        mocks.documentError = null;
        mocks.hookCalls = 0;
        mocks.numPages = 3;
        mocks.pageRequests = [];
        mocks.pdfDataLength = 0;
        mocks.pdfOptions = null;
        mocks.resize = null;
        mocks.standardFontDataUrl = "";
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
        vi.stubGlobal("cancelAnimationFrame", clearTimeout);
        HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
            this.scrollTop = options.top ?? 0;
        });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
            {} as CanvasRenderingContext2D,
        );
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
            .mockImplementation(() => mocks.clientWidth);
    });

    afterEach(() => {
        window.getSelection()?.removeAllRanges();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("reserves every page with locators and same-origin fonts and cancels obsolete work", async () => {
        const { container } = render(
            <PdfView doc={{ document_id: "doc-1", version_id: "version-1" }} />,
        );
        await waitFor(() => expect(mocks.rendered.length).toBeGreaterThan(0));
        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

        await waitFor(() => expect(
            container.querySelectorAll("[data-page-number]"),
        ).toHaveLength(3));
        expect(Array.from(
            container.querySelectorAll<HTMLElement>("[data-page-number]"),
            (page) => page.dataset.pageNumber,
        )).toEqual(["1", "2", "3"]);
        expect(new URL(mocks.standardFontDataUrl).origin).toBe(location.origin);
        expect(mocks.pdfOptions).toMatchObject({
            isEvalSupported: false,
            maxImageSize: 40_000_000,
        });
        expect(mocks.cancelled).toBeGreaterThan(0);
        for (const page of container.querySelectorAll<HTMLElement>("[data-page-number]")) {
            expect(page).toHaveAttribute("data-legal-block");
            expect(page).toHaveAttribute("data-locator-kind", "page");
            expect(page).toHaveAttribute("data-locator-value", page.dataset.pageNumber);
        }
        expect(await screen.findByText("Page 1 text")).toBeVisible();
    });

    it("allows an ordinary reader selection to resolve to its PDF page", async () => {
        mocks.numPages = 1;
        render(<PdfView doc={null} bytes={new Uint8Array([1])} />);
        const text = await screen.findByText("Page 1 text");
        const range = document.createRange();
        range.setStart(text.firstChild!, 0);
        range.setEnd(text.firstChild!, 6);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe("Page 1");
        expect(text.closest("[data-legal-block]")).toHaveAttribute("data-locator-value", "1");
        expect(text.parentElement).toHaveStyle({ userSelect: "text", pointerEvents: "auto" });
    });

    it("shares an in-flight text layer between painting and quote search", async () => {
        mocks.renderDelay = 0;
        mocks.textDelay = 40;
        const { container } = render(<PdfView doc={null} bytes={new Uint8Array([1])}
            quotes={[{ quote: "Page 1 text" }]} />);
        await screen.findByText("Page 3 text");
        expect(container.querySelectorAll(".pdf-text-layer")).toHaveLength(3);
        expect(screen.getAllByText("Page 1 text")).toHaveLength(1);
        expect(mocks.textPages).toEqual([1, 2, 3]);
    });

    it.each([false, true])("keeps the PDF readable when text extraction fails (quotes: %s)", async (withQuotes) => {
        mocks.numPages = 1;
        mocks.textError = new Error("Unreadable text stream");
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { container } = render(<PdfView doc={null} bytes={new Uint8Array([1])}
            quotes={withQuotes ? [{ quote: "Missing text" }] : undefined} />);
        await waitFor(() => expect(container.querySelector("canvas")).not.toBeNull());
        await waitFor(() => expect(warning).toHaveBeenCalled());
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("button", { name: "Zoom in" })).toBeVisible();
        expect(container.querySelector(".pdf-text-layer")).toBeNull();
    });

    it("reserves mixed-size geometry before painting and bounds canvases when jumping", async () => {
        mocks.numPages = 300;
        mocks.renderDelay = 60;
        const { container } = render(<PdfView doc={null} bytes={new Uint8Array([1])} />);
        await waitFor(() => expect(container.querySelectorAll("[data-page-number]")).toHaveLength(300));
        const pages = [...container.querySelectorAll<HTMLElement>("[data-page-number]")];
        const heights = pages.map((page) => page.style.height);
        expect(heights.slice(0, 2)).toEqual(["800px", "1000px"]);
        expect(container.querySelectorAll("canvas").length).toBeLessThan(4);
        await waitFor(() => expect(pages[0].querySelector("canvas")).not.toBeNull());
        await screen.findByText("Page 1 text");
        expect(pages[100].querySelector(".pdf-text-layer")).toBeNull();
        expect(mocks.textPages.length).toBeLessThan(4);
        const scroller = container.querySelector<HTMLElement>(".overflow-auto")!;
        // Page 201 starts after 100 pairs of mixed-size pages and gaps.
        scroller.scrollTop = 181600;
        fireEvent.scroll(scroller);
        await waitFor(() => expect(pages[200].querySelector("canvas")).not.toBeNull());
        expect(mocks.rendered.length).toBeLessThan(10);
        expect(container.querySelectorAll("canvas").length).toBeLessThan(6);
        expect(pages[0].querySelector("canvas")).toBeNull();
        expect(pages.map((page) => page.style.height)).toEqual(heights);
        expect(scroller.scrollTop).toBe(181600);
        scroller.scrollTop = 0;
        fireEvent.scroll(scroller);
        await waitFor(() => expect(pages[0].querySelector("canvas")).not.toBeNull());
        expect(pages[200].querySelector("canvas")).toBeNull();
        expect(pages[0].querySelectorAll(".pdf-text-layer")).toHaveLength(1);
        expect(mocks.textPages.filter((page) => page === 1)).toHaveLength(1);
        expect(mocks.textPages.length).toBeLessThan(10);
    });

    it("renders provided bytes in the full viewer without detaching the artifact", async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        render(<PdfView doc={null} bytes={bytes} ariaLabel="Built court record preview" />);

        expect(await screen.findByRole("region", { name: "Built court record preview" }))
            .toBeVisible();
        await screen.findByRole("button", { name: "Zoom in" });
        expect(mocks.pdfDataLength).toBe(4);
        expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("fits a page inside a narrow preview without horizontal clipping", async () => {
        mocks.clientWidth = 200;
        const { container } = render(<PdfView doc={null} bytes={new Uint8Array([1])} />);

        await waitFor(() => expect(container.querySelector("canvas")?.width)
            .toBeLessThanOrEqual(200));
    });

    it("refits immediately when a preview narrows", async () => {
        const { container } = render(<PdfView doc={null} bytes={new Uint8Array([1])} />);
        await waitFor(() => expect(container.querySelectorAll("[data-page-number]")).toHaveLength(3));
        const requests = mocks.pageRequests.length;
        mocks.clientWidth = 200;
        await act(async () => {
            mocks.resize!([{ contentRect: { width: 200 } } as ResizeObserverEntry],
                {} as ResizeObserver);
            await Promise.resolve();
        });
        expect(mocks.pageRequests.length).toBe(requests);
        await waitFor(() => expect(container.querySelector("canvas")?.width)
            .toBeLessThanOrEqual(200));
    });

    it("shows a visible error when the file is not a valid PDF", async () => {
        mocks.documentError = new Error("Invalid PDF structure");

        const { container } = render(
            <PdfView doc={{ document_id: "doc-1", version_id: "version-1" }} />,
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            /invalid or unsupported/i,
        );
        expect(container.querySelector("canvas")).toBeNull();
    });

    it("refuses pathological page counts before rendering", async () => {
        mocks.numPages = 2_001;
        const { container } = render(
            <PdfView doc={{ document_id: "doc-1", version_id: "version-1" }} />,
        );
        expect(await screen.findByRole("alert")).toBeVisible();
        expect(mocks.pageRequests).toEqual([]);
        expect(container.querySelector("canvas")).toBeNull();
    });

    it("builds quote text layers and checks the active page once per frame", async () => {
        let callback: FrameRequestCallback | null = null;
        const requestFrame = vi.fn((next: FrameRequestCallback) => {
            callback = next;
            return 7;
        });
        const cancelFrame = vi.fn();
        vi.stubGlobal("requestAnimationFrame", requestFrame);
        vi.stubGlobal("cancelAnimationFrame", cancelFrame);
        const { container, unmount } = render(
            <PdfView
                doc={{ document_id: "doc-1", version_id: "version-1" }}
                quotes={[{ quote: "Page 2 text" }]}
            />,
        );
        await waitFor(() => expect(
            container.querySelectorAll("[data-page-number]"),
        ).toHaveLength(3));
        expect(new Set(mocks.pageRequests)).toEqual(new Set([1, 2, 3]));
        expect(container.querySelectorAll(".pdf-text-layer")).toHaveLength(3);
        const renders = mocks.hookCalls;
        act(() => mocks.resize!(
            [{ contentRect: { width: 800 } } as ResizeObserverEntry],
            {} as ResizeObserver,
        ));
        expect(mocks.hookCalls).toBe(renders);
        const scroller = container.querySelector(".overflow-auto")!;
        Object.defineProperty(scroller, "clientHeight", { value: 600 });
        container.querySelectorAll<HTMLElement>("[data-page-number]")
            .forEach((page, index) => {
                Object.defineProperty(page, "offsetTop", { value: index * 1000 });
                Object.defineProperty(page, "clientHeight", { value: 800 });
            });
        scroller.scrollTop = 1000;
        fireEvent.scroll(scroller);
        fireEvent.scroll(scroller);
        expect(requestFrame).toHaveBeenCalledTimes(1);
        act(() => callback!(0));
        await screen.findByText("2/3");
        fireEvent.scroll(scroller);
        unmount();
        expect(cancelFrame).toHaveBeenCalledWith(7);
    });
});
