import {
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
    useFetchDocxBytes: vi.fn(),
    withBrokenImage: false,
    withTrackedChanges: false,
}));

vi.mock("docx-preview", () => ({
    parseAsync: mocks.parseAsync,
    renderDocument: mocks.renderDocument,
}));

vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: mocks.useFetchDocxBytes,
}));

vi.mock("./PdfView", () => ({
    PdfView: ({ onUnavailable }: { onUnavailable?: () => void }) => (
        <button data-testid="pdf-rendition" onClick={onUnavailable}>
            PDF rendition
        </button>
    ),
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
        mocks.withBrokenImage = false;
        mocks.withTrackedChanges = false;
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.stubGlobal(
            "requestAnimationFrame",
            (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());

        mocks.useFetchDocxBytes.mockReturnValue({
            // Fresh buffer per test so the parsed-document cache is cold.
            bytes: new ArrayBuffer(8),
            downloadUrl: null,
            loading: false,
            error: null,
        });
        mocks.parseAsync.mockImplementation(async () => {
            if (!mocks.withTrackedChanges) return {};
            return {
                documentPart: {
                    _xmlDocument: new DOMParser().parseFromString(
                        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:ins w:id="17" /></w:body></w:document>',
                        "application/xml",
                    ),
                    body: {
                        children: [{ type: "inserted", id: "17", children: [] }],
                    },
                },
            };
        });
        mocks.renderDocument.mockImplementation(
            async (doc: any, container: HTMLElement) => {
                container.innerHTML = "";
                const wrapper = document.createElement("div");
                wrapper.className = "docx-wrapper";
                for (let index = 0; index < 2; index++) {
                    const page = document.createElement("section");
                    page.className = "docx";
                    Object.defineProperty(page, "offsetWidth", {
                        configurable: true,
                        value: 816,
                    });
                    if (index === 0 && mocks.withTrackedChanges) {
                        const change = document.createElement("ins");
                        change.dataset.wId =
                            doc.documentPart.body.children[0].id;
                        page.appendChild(change);
                    }
                    if (index === 0 && mocks.withBrokenImage) {
                        const frame = document.createElement("span");
                        const image = document.createElement("img");
                        Object.defineProperties(image, {
                            complete: { configurable: true, value: true },
                            naturalWidth: { configurable: true, value: 0 },
                        });
                        frame.appendChild(image);
                        page.appendChild(frame);
                    }
                    wrapper.appendChild(page);
                }
                container.appendChild(wrapper);
            },
        );
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it("renders saved Word page breaks without inventing page numbers", async () => {
        const onReady = vi.fn();
        const onScrollChange = vi.fn();
        const { container } = render(
            <DocxView
                documentId="doc-1"
                preferPdfRendition={false}
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
        expect(viewport).toHaveClass("flex-1", "overflow-auto");
        expect(viewport.parentElement).toHaveClass(
            "flex",
            "min-h-0",
            "flex-1",
            "flex-col",
            "overflow-hidden",
        );
        Object.defineProperties(viewport, {
            clientHeight: { configurable: true, value: 320 },
            scrollHeight: { configurable: true, value: 1_500 },
        });
        expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        viewport.scrollTop = 240;
        fireEvent.scroll(viewport);
        expect(viewport.scrollTop).toBe(240);
        expect(onScrollChange).toHaveBeenLastCalledWith(240);
        // Page boundaries come from Word; page *numbers* do not, so none are
        // fabricated onto the DOM.
        for (const page of pages) {
            expect(page).not.toHaveAttribute("data-page-number");
            expect(page).not.toHaveAttribute("aria-label");
        }
    });

    it("keeps tracked-change IDs in the browser parse", async () => {
        mocks.withTrackedChanges = true;

        const firstReady = vi.fn();
        const first = render(
            <DocxView
                documentId="tracked-doc"
                versionId="version-1"
                refetchKey={4}
                preferPdfRendition={false}
                onReady={firstReady}
            />,
        );
        await waitFor(() => expect(firstReady).toHaveBeenCalledOnce());
        expect(first.container.querySelector("ins")).toHaveAttribute(
            "data-w-id",
            "17",
        );
        first.unmount();

        const secondReady = vi.fn();
        render(
            <DocxView
                documentId="tracked-doc"
                versionId="version-1"
                refetchKey={4}
                preferPdfRendition={false}
                onReady={secondReady}
            />,
        );
        await waitFor(() => expect(secondReady).toHaveBeenCalledOnce());

        expect(mocks.parseAsync).toHaveBeenCalledTimes(2);
        expect(mocks.renderDocument).toHaveBeenCalledTimes(2);
    });

    it("fits the widest page content without stretching smaller pages", () => {
        const viewport = document.createElement("div");
        viewport.style.padding = "0 20px";
        Object.defineProperty(viewport, "clientWidth", {
            configurable: true,
            value: 500,
        });
        const container = document.createElement("div");
        container.innerHTML =
            '<div class="docx-wrapper"><section class="docx"></section></div>';
        const page = container.querySelector<HTMLElement>("section.docx")!;
        Object.defineProperties(page, {
            offsetWidth: { configurable: true, value: 800 },
            scrollWidth: { configurable: true, value: 1000 },
        });

        fitDocxPages([page], viewport);

        expect(page.dataset.docxNaturalWidth).toBe("1000");
        expect(Number(page.style.zoom)).toBeCloseTo(0.46);
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

    it("keeps the Word view stable when media is unsupported", async () => {
        mocks.withBrokenImage = true;

        const { container } = render(
            <DocxView
                documentId="no-rendition-doc"
                versionId="v1"
                preferPdfRendition={false}
            />,
        );

        await waitFor(() =>
            expect(container.querySelector("section.docx")).not.toBeNull(),
        );
        expect(
            screen.queryByText(/embedded vector image/i),
        ).not.toBeInTheDocument();
        expect(screen.queryByTestId("pdf-rendition")).not.toBeInTheDocument();
    });

    it("keeps tracked-edit mode on the interactive HTML renderer", async () => {
        mocks.withBrokenImage = true;
        const onReady = vi.fn();

        const { container } = render(
            <DocxView
                documentId="tracked-vector-doc"
                highlightEdit={{ key: "edit-1" }}
                onReady={onReady}
            />,
        );

        await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
        expect(container.querySelector("section.docx")).not.toBeNull();
        expect(screen.queryByTestId("pdf-rendition")).not.toBeInTheDocument();
    });
});
