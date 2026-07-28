import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cancelled: 0,
    buffer: new ArrayBuffer(8),
}));

vi.mock("@/app/hooks/useFetchSingleDoc", () => ({
    useFetchSingleDoc: () => ({
        result: { type: "pdf", buffer: mocks.buffer },
        loading: false,
        error: null,
    }),
}));

vi.mock("./highlightQuote", () => {
    const pdf = {
        numPages: 3,
        getPage: async (pageNumber: number) => ({
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
        }),
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
        highlightQuote: vi.fn(async () => false),
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
    observe() {}
    disconnect() {}
}

describe("PdfView", () => {
    beforeEach(() => {
        mocks.cancelled = 0;
        mocks.buffer = new ArrayBuffer(8);
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
    });
});
