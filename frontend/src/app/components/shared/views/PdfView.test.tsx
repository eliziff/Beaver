import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cancelled: 0,
    buffer: new ArrayBuffer(8),
    fetchCalls: 0,
    pageRequests: [] as number[],
    resize: null as ResizeObserverCallback | null,
}));

vi.mock("@/app/hooks/useFetchSingleDoc", () => {
    const result = {
        type: "pdf" as const,
        get buffer() {
            return mocks.buffer;
        },
    };
    return {
        useFetchSingleDoc: () => {
            mocks.fetchCalls += 1;
            return { result, loading: false, error: null };
        },
    };
});

vi.mock("./highlightQuote", () => {
    const pdf = {
        numPages: 3,
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
                    const promise = new Promise<void>(
                        (resolve, rejectPromise) => {
                            reject = rejectPromise;
                            timer = setTimeout(resolve, 20);
                        },
                    );
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
        STANDARD_FONT_DATA_URL: "",
        getPdfJs: vi.fn(async () => ({
            TextLayer,
            getDocument: ({ data }: { data: Uint8Array }) => {
                structuredClone(data.buffer, { transfer: [data.buffer] });
                return { promise: Promise.resolve(pdf) };
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
        mocks.fetchCalls = 0;
        mocks.pageRequests = [];
        mocks.resize = null;
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
            {} as CanvasRenderingContext2D,
        );
        vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
            620,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("cancels an obsolete render and keeps every page once in order", async () => {
        const { container } = render(
            <PdfView doc={{ document_id: "doc-1", version_id: "version-1" }} />,
        );

        await screen.findByRole("button", { name: "Zoom in" });
        fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

        await waitFor(() =>
            expect(
                container.querySelectorAll("[data-page-number]"),
            ).toHaveLength(3),
        );
        expect(
            Array.from(
                container.querySelectorAll<HTMLElement>("[data-page-number]"),
            ).map((page) => page.dataset.pageNumber),
        ).toEqual(["1", "2", "3"]);
        expect(mocks.buffer.byteLength).toBe(8);
        expect(mocks.cancelled).toBeGreaterThan(0);
        expect(container.querySelector(".pdf-text-layer")).toBeNull();
    });

    it("checks the active page once per frame and cancels pending work", async () => {
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
        await waitFor(() =>
            expect(
                container.querySelectorAll("[data-page-number]"),
            ).toHaveLength(3),
        );
        expect(mocks.pageRequests).toEqual([1, 2, 3]);
        expect(container.querySelectorAll(".pdf-text-layer")).toHaveLength(3);
        const renders = mocks.fetchCalls;
        act(() =>
            mocks.resize!(
                [{ contentRect: { width: 800 } } as ResizeObserverEntry],
                {} as ResizeObserver,
            ),
        );
        expect(mocks.fetchCalls).toBe(renders);
        const scroller = container.querySelector(".overflow-auto")!;
        Object.defineProperty(scroller, "clientHeight", { value: 600 });
        container
            .querySelectorAll<HTMLElement>("[data-page-number]")
            .forEach((page, index) => {
                Object.defineProperty(page, "offsetTop", {
                    value: index * 1000,
                });
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
