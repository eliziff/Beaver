import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    parseAsync: vi.fn(),
    renderDocument: vi.fn(),
    useDocumentFile: vi.fn(),
}));

vi.mock("docx-preview", () => ({
    parseAsync: mocks.parseAsync,
    renderDocument: mocks.renderDocument,
}));

vi.mock("@/app/hooks/useDocumentFile", () => ({
    useDocumentFile: mocks.useDocumentFile,
}));

import {
    DocxView,
    fitDocxPages,
    quietBrokenDocxImages,
} from "./DocxView";

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

describe("DocxView", () => {
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.stubGlobal(
            "requestAnimationFrame",
            (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());

        mocks.useDocumentFile.mockReturnValue({
            result: { type: "docx", buffer: new ArrayBuffer(8) },
            loading: false,
            error: null,
        });
        mocks.parseAsync.mockResolvedValue({});
        mocks.renderDocument.mockImplementation(async (_doc, container: HTMLElement) => {
            container.innerHTML = '<div class="docx-wrapper">'
                + '<section class="docx"></section><section class="docx"></section></div>';
        });
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it("reveals pages only after rendering and initial scroll restoration", async () => {
        let finish!: () => void;
        mocks.renderDocument.mockImplementationOnce(async (_doc, container: HTMLElement) => {
            container.innerHTML = '<section class="docx" style="width:612pt">Document text</section>';
            await new Promise<void>((resolve) => { finish = resolve; });
        });
        const onReady = vi.fn();
        const { container } = render(<DocxView documentId="doc-1" initialScrollTop={120} onReady={onReady} />);
        await waitFor(() => expect(screen.getByText("Document text")).toBeInTheDocument());
        expect(screen.getByText("Document text")).not.toBeVisible();
        expect(screen.getByRole("status", { name: "Loading document" })).toBeVisible();
        expect(onReady).not.toHaveBeenCalled();
        await act(async () => finish());
        await waitFor(() => expect(screen.getByText("Document text")).toBeVisible());
        expect(container.querySelector(".docx-view-scroll")?.scrollTop).toBe(120);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(onReady).toHaveBeenCalledOnce();
    });

    it("retains every cited passage and scrolls to the first attached highlight", async () => {
        mocks.renderDocument.mockImplementationOnce(async (_doc, container: HTMLElement) => {
            container.innerHTML = '<section class="docx"><p>First cited passage.</p><p>Second cited passage.</p></section>';
        });
        const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
            return { top: this.isConnected && this.classList.contains("docx-text-highlight") ? 600 : 0,
                height: 20, width: 800, bottom: 620, left: 0, right: 800, x: 0, y: 0, toJSON() {} };
        });
        try {
            const onReady = vi.fn();
            const { container } = render(<DocxView documentId="multi-quote" onReady={onReady}
                quotes={[{ quote: "First cited passage." }, { quote: "Second cited passage." }]} />);
            await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
            expect(Array.from(container.querySelectorAll(".docx-text-highlight"), (node) => node.textContent))
                .toEqual(["First cited passage.", "Second cited passage."]);
            expect(container.querySelector(".docx-view-scroll")?.scrollTop).toBe(610);
        } finally { rect.mockRestore(); }
    });

    it("renders saved Word page breaks without inventing page numbers", async () => {
        const onReady = vi.fn();
        const onScrollChange = vi.fn();
        const { container } = render(
            <DocxView
                documentId="doc-1"
                onReady={onReady}
                onScrollChange={onScrollChange}
            />,
        );

        await waitFor(() => expect(onReady).toHaveBeenCalledOnce());

        expect(mocks.renderDocument).toHaveBeenCalledOnce();
        expect(mocks.renderDocument.mock.calls[0][3]).toMatchObject({
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            renderEndnotes: true,
            renderChanges: true,
            experimental: false,
        });
        const pages = container.querySelectorAll("section.docx");
        expect(pages).toHaveLength(2);
        const viewport = container.querySelector<HTMLElement>(
            '[data-document-id="doc-1"]',
        )!;
        viewport.scrollTop = 240;
        fireEvent.scroll(viewport);
        expect(onScrollChange).toHaveBeenLastCalledWith(240);
        // Page boundaries come from Word; page *numbers* do not, so none are
        // fabricated onto the DOM.
        for (const page of pages) {
            expect(page).not.toHaveAttribute("data-page-number");
            expect(page).not.toHaveAttribute("aria-label");
        }
    });

    it("fits pages from their declared Word width without forcing layout", () => {
        const viewport = document.createElement("div");
        viewport.style.padding = "0 20px";
        Object.defineProperty(viewport, "clientWidth", {
            configurable: true,
            value: 500,
        });
        const container = document.createElement("div");
        container.innerHTML =
            '<div class="docx-wrapper"><section class="docx" style="width:600pt"></section></div>';
        const page = container.querySelector<HTMLElement>("section.docx")!;
        Object.defineProperties(page, {
            offsetWidth: {
                configurable: true,
                get: () => {
                    throw new Error("forced layout");
                },
            },
            scrollWidth: {
                configurable: true,
                get: () => {
                    throw new Error("forced layout");
                },
            },
        });

        fitDocxPages([page], viewport);

        expect(Number(page.style.zoom)).toBeCloseTo(0.575);
    });

    it("keeps failed vector media quiet without collapsing its layout box", () => {
        const container = document.createElement("div");
        container.innerHTML =
            '<span style="width:100px;height:40px"><img style="width:100px;height:40px"></span>';
        const image = container.querySelector("img")!;
        Object.defineProperties(image, {
            complete: { configurable: true, value: false },
            naturalWidth: { configurable: true, value: 0 },
        });

        const onUnsupported = vi.fn();
        quietBrokenDocxImages([image], onUnsupported);
        image.dispatchEvent(new Event("error"));

        expect(image).toHaveClass("docx-media-unavailable");
        expect(image.parentElement).toHaveAttribute(
            "aria-label",
            "Embedded image unavailable in this browser",
        );
        expect(image.parentElement).toHaveStyle({
            width: "100px",
            height: "40px",
        });
        expect(onUnsupported).toHaveBeenCalledOnce();
    });

});
