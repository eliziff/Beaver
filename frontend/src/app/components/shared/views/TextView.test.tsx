import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useDocumentFile: vi.fn() }));
vi.mock("@/app/hooks/useDocumentFile", () => mocks);

import { TextView } from "./TextView";

it("keeps saved-research and verified source links clickable without rendering unsafe links", () => {
    const markdown = "[Research file](/sources?research_file=set-1)\n\n" +
        "[2026 SCC 1 · par7](</sources/view?provider=a2aj&citation=2026+SCC+1&locator=par7>)\n\n" +
        "[Original](https://example.test/case)\n\n[Unsafe](javascript:alert(1))";
    mocks.useDocumentFile.mockReturnValue({ result: { type: "text",
        buffer: new TextEncoder().encode(markdown).buffer }, loading: false, error: null });

    render(<TextView documentId="memo" filename="Memo.md" />);

    expect(screen.getByRole("link", { name: "Research file" })).toHaveAttribute(
        "href", "/sources?research_file=set-1");
    expect(screen.getByRole("link", { name: "2026 SCC 1 · par7" })).toHaveAttribute(
        "href", "/sources/view?provider=a2aj&citation=2026+SCC+1&locator=par7");
    expect(screen.getByRole("link", { name: "Original" })).toHaveAttribute(
        "href", "https://example.test/case");
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
});


it.each([
    ["Memo.txt", "Verbatim evidence\nwith a second line", "PRE"],
    ["Memo.md", "# Evidence\n\nA passage", "DIV"],
])("exposes %s content as a document locator, not a fabricated page", (filename, text, tag) => {
    mocks.useDocumentFile.mockReturnValue({ result: { type: "text",
        buffer: new TextEncoder().encode(text).buffer }, loading: false, error: null });
    const { container } = render(<TextView documentId="memo" filename={filename} />);
    const block = container.querySelector("[data-legal-block]");
    expect(block?.tagName).toBe(tag);
    expect(block).toHaveAttribute("data-locator-kind", "document");
    expect(block).toHaveAttribute("data-locator-value", "document");
    expect(block).toBeVisible();
    expect(container.querySelector('[data-locator-kind="page"]')).toBeNull();
    if (tag === "PRE") expect(block?.textContent).toBe(text);
    else expect(block).toHaveTextContent("A passage");
});

it.each([
    { loading: true, error: null },
    { loading: false, error: "Unavailable" },
])("does not expose loading/error copy as document evidence: %j", (state) => {
    mocks.useDocumentFile.mockReturnValue({ ...state, result: null });
    const { container } = render(<TextView documentId="memo" filename="Memo.txt" />);
    expect(container.querySelector("[data-legal-block]")).toBeNull();
});
