import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAuthHeader: vi.fn(),
    parseAsync: vi.fn(),
    renderDocument: vi.fn(),
    useFetchDocxBytes: vi.fn(),
    withTrackedChanges: false,
}));

vi.mock("docx-preview", () => ({
    parseAsync: mocks.parseAsync,
    renderDocument: mocks.renderDocument,
}));

vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: mocks.useFetchDocxBytes,
}));

vi.mock("@/app/lib/beaverApi", () => ({
    getAuthHeader: mocks.getAuthHeader,
}));

import { DocxView } from "./DocxView";

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

describe("DocxView", () => {
    beforeEach(() => {
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
        mocks.parseAsync.mockImplementation(async () => ({}));
        mocks.renderDocument.mockImplementation(
            async (_doc: unknown, container: HTMLElement) => {
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
                        page.appendChild(document.createElement("ins"));
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
        const { container } = render(
            <DocxView documentId="doc-1" onReady={onReady} />,
        );

        await waitFor(() => expect(onReady).toHaveBeenCalledOnce());

        expect(mocks.renderDocument).toHaveBeenCalledOnce();
        expect(mocks.renderDocument.mock.calls[0][3]).toMatchObject({
            ignoreLastRenderedPageBreak: false,
            renderChanges: true,
        });
        const pages = container.querySelectorAll("section.docx");
        expect(pages).toHaveLength(2);
        // Page boundaries come from Word; page *numbers* do not, so none are
        // fabricated onto the DOM.
        for (const page of pages) {
            expect(page).not.toHaveAttribute("data-page-number");
            expect(page).not.toHaveAttribute("aria-label");
        }
        expect(mocks.getAuthHeader).not.toHaveBeenCalled();
    });

    it("reuses tracked-change IDs for the same document version", async () => {
        mocks.withTrackedChanges = true;
        mocks.getAuthHeader.mockResolvedValue({});
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                ids: [{ kind: "ins", w_id: "17" }],
            }),
        }));
        vi.stubGlobal("fetch", fetchMock);

        const firstReady = vi.fn();
        const first = render(
            <DocxView
                documentId="tracked-doc"
                versionId="version-1"
                refetchKey={4}
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
                onReady={secondReady}
            />,
        );
        await waitFor(() => expect(secondReady).toHaveBeenCalledOnce());

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(mocks.getAuthHeader).toHaveBeenCalledOnce();
        // The same bytes are parsed once and re-rendered from cache.
        expect(mocks.parseAsync).toHaveBeenCalledOnce();
        expect(mocks.renderDocument).toHaveBeenCalledTimes(2);
    });
});
