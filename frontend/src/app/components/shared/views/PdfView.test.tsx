import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cancelled: 0,
    buffer: new ArrayBuffer(8),
    documentError: null as Error | null,
    hookCalls: 0,
    numPages: 3,
    pageRequests: [] as number[],
    pdfOptions: null as Record<string, unknown> | null,
    resize: null as ResizeObserverCallback | null,
    standardFontDataUrl: "",
}));

vi.mock("@/app/hooks/useDocumentFile", () => ({
    useDocumentFile: () => {
        mocks.hookCalls += 1;
        return {
            result: { type: "pdf" as const, buffer: mocks.buffer },
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
                    height: 800 * scale,
                }),
                render: () => {
                    let reject!: (error: unknown) => void;
                    let timer: ReturnType<typeof setTimeout>;
                    const promise = new Promise<void>((resolve, rejectPromise) => {
                        reject = rejectPromise;
                        timer = setTimeout(resolve, 20);
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
                mocks.standardFontDataUrl = standardFontDataUrl;
                structuredClone(data.buffer, { transfer: [data.buffer] });
                return {
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
        mocks.buffer = new ArrayBuffer(8);
        mocks.documentError = null;
        mocks.hookCalls = 0;
        mocks.numPages = 3;
        mocks.pageRequests = [];
        mocks.pdfOptions = null;
        mocks.resize = null;
        mocks.standardFontDataUrl = "";
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
            {} as CanvasRenderingContext2D,
        );
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(620);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("renders every page with same-origin standard fonts and cancels obsolete work", async () => {
        const { container } = render(
            <PdfView doc={{ document_id: "doc-1", version_id: "version-1" }} />,
        );
        await screen.findByRole("button", { name: "Zoom in" });
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
        expect(mocks.buffer.byteLength).toBe(8);
        expect(mocks.cancelled).toBeGreaterThan(0);
        expect(container.querySelector(".pdf-text-layer")).toBeNull();
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
