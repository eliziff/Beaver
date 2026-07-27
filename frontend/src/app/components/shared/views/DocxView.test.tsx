import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
    renderAsync: vi.fn(),
    useFetchDocxBytes: vi.fn(),
    withTrackedChanges: false,
}));

vi.mock("docx-preview", () => ({
    renderAsync: mocks.renderAsync,
}));

vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: mocks.useFetchDocxBytes,
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: {
        auth: {
            getSession: mocks.getSession,
        },
    },
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
            bytes: new ArrayBuffer(8),
            downloadUrl: null,
            loading: false,
            error: null,
        });
        mocks.renderAsync.mockImplementation(
            async (
                _bytes: ArrayBuffer,
                container: HTMLElement,
            ) => {
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

    it("uses saved Word page breaks and labels rendered pages", async () => {
        const onReady = vi.fn();
        const { container } = render(
            <DocxView documentId="doc-1" onReady={onReady} />,
        );

        await waitFor(() => expect(onReady).toHaveBeenCalledOnce());

        expect(mocks.renderAsync).toHaveBeenCalledOnce();
        expect(mocks.renderAsync.mock.calls[0][3]).toMatchObject({
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            renderFootnotes: true,
            renderEndnotes: true,
        });
        const pages = container.querySelectorAll("section.docx");
        expect(pages).toHaveLength(2);
        expect(pages[0]).toHaveAttribute("data-page-number", "1");
        expect(pages[0]).toHaveAttribute("aria-label", "Page 1");
        expect(pages[1]).toHaveAttribute("data-page-number", "2");
        expect(pages[1]).toHaveAttribute("aria-label", "Page 2");
        expect(mocks.getSession).not.toHaveBeenCalled();
    });

    it("reuses tracked-change IDs for the same document version", async () => {
        mocks.withTrackedChanges = true;
        mocks.getSession.mockResolvedValue({
            data: { session: null },
        });
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
        expect(mocks.getSession).toHaveBeenCalledOnce();
    });
});
