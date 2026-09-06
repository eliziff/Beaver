import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    parseAsync: vi.fn(), renderDocument: vi.fn(), useDocumentFile: vi.fn(),
}));
vi.mock("docx-preview", () => ({ parseAsync: mocks.parseAsync, renderDocument: mocks.renderDocument }));
vi.mock("@/app/hooks/useDocumentFile", () => ({ useDocumentFile: mocks.useDocumentFile }));

import { DocxView } from "./DocxView";

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mocks.useDocumentFile.mockReturnValue({ result: { type: "docx", buffer: new ArrayBuffer(8) },
        loading: false, error: null });
    mocks.parseAsync.mockResolvedValue({});
    mocks.renderDocument.mockImplementation(async (_doc, container: HTMLElement) => {
        container.innerHTML = '<section class="docx">First passage</section><section class="docx">Second passage</section>';
    });
});

afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
});

it("exposes ready Word content without warning controls or invented page locators", async () => {
    const ready = vi.fn();
    const { container } = render(<DocxView documentId="word" onReady={ready} warning="A warning" />);
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    const block = screen.getByText("First passage").closest("[data-legal-block]");
    expect(block).toHaveAttribute("data-locator-kind", "document");
    expect(block).toHaveAttribute("data-locator-value", "document");
    expect(block).toHaveTextContent("Second passage");
    expect(block).toBeVisible();
    expect(container.querySelectorAll("[data-legal-block]")).toHaveLength(1);
    expect(container.querySelector('[data-locator-kind="page"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss warning" }).closest("[data-legal-block]")).toBeNull();
});

it("does not expose pending Word content until it is ready to capture", async () => {
    let finish!: () => void;
    mocks.renderDocument.mockImplementationOnce(async (_doc, container: HTMLElement) => {
        container.innerHTML = '<section class="docx">Pending passage</section>';
        await new Promise<void>((resolve) => { finish = resolve; });
    });
    const { container } = render(<DocxView documentId="word" />);
    await screen.findByText("Pending passage");
    expect(container.querySelector("[data-legal-block]")).toBeNull();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByText("Pending passage").closest("[data-legal-block]"))
        .toHaveAttribute("data-locator-kind", "document"));
});

it("does not expose an unreadable Word document as evidence", () => {
    mocks.useDocumentFile.mockReturnValue({ result: null, loading: false, error: "Unavailable" });
    const { container } = render(<DocxView documentId="word" />);
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(container.querySelector("[data-legal-block]")).toBeNull();
});
