import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ResearchFile } from "@/app/lib/researchFiles";
import ResearchMemoEditor, { memoExtensions } from "./ResearchMemoEditor";
import { citationMarkdown, memoCitation } from "./researchMemo";
import { citationPillParts } from "@/app/components/assistant/message/CitationSources";

describe("workspace memo Markdown", () => {
  it("formats ordinary citation text without exposing internal document ranges", () => {
    const citation = memoCitation("/sources/view?provider=a2aj&source_id=case-1&citation=2026+SCC+1&title=Baker+v+Canada&authority=Baker+v+Canada%2C+2026+SCC+1&doc_type=cases&locator=chars%3A0-850&locator_kind=document")!;
    expect(citationPillParts(citation)).toEqual({ styleOfCause: "Baker v Canada", rest: ", 2026 SCC 1" });
  });
  it("renders a citation as an ordinary text link and opens its exact internal evidence target", async () => {
    const href = "/sources/view?provider=a2aj&source_id=case-1&citation=2026+SCC+1&title=Baker+v+Canada&doc_type=cases&locator=7&locator_kind=paragraph&evidence_id=e1&external_url=https%3A%2F%2Fexample.com";
    const file = { document: { id: "research" }, state: { sources: {}, labels: {} } } as ResearchFile;
    const open = vi.fn();
    render(<MemoryRouter><ResearchMemoEditor file={file} value={`The inquiry is contextual. ${citationMarkdown("Baker v Canada at para 7", href)}`}
      onOpenCitation={open} readOnly /></MemoryRouter>);
    const link = await screen.findByRole("link", { name: "Baker v Canada at para 7" });
    expect(link).toHaveAttribute("href", href);
    expect(screen.queryByRole("button", { name: /Baker|Cite/ })).not.toBeInTheDocument();
    fireEvent.click(link); expect(open).toHaveBeenCalledWith(href);
  });
  it("round-trips formatting, tables and exact source citation links", () => {
    const href = "/sources/view?provider=a2aj&source_id=case-1&citation=2026+SCC+1&title=Baker+v+Canada&doc_type=cases&locator=7&locator_kind=paragraph&evidence_id=e1";
    const editor = new Editor({ extensions: memoExtensions, contentType: "markdown",
      content: `## Analysis\n\n**Bold**, *italic*, ++underlined++ and ${citationMarkdown("Baker v Canada, 2026 SCC 1 at para 7", href)}.\n\n| Question | Result |\n| --- | --- |\n| Duty | Yes |\n\n- One\n- Two\n\n[Ordinary link](https://example.com)` });
    try {
      expect(editor.getJSON()).toMatchObject({ type: "doc", content: expect.arrayContaining([
        expect.objectContaining({ type: "table" }),
        expect.objectContaining({ type: "paragraph", content: expect.arrayContaining([
          expect.objectContaining({ type: "memoCitation", attrs: expect.objectContaining({ href }) }),
          expect.objectContaining({ type: "text", text: "underlined", marks: [{ type: "underline" }] }),
        ]) }),
      ]) });
      const before = editor.getJSON(), markdown = editor.getMarkdown();
      editor.commands.setContent(markdown, { contentType: "markdown" });
      expect(editor.getJSON()).toEqual(before);
      expect(markdown).toContain(href);
      expect(memoCitation(href)).toMatchObject({ kind: "a2aj", citation: "2026 SCC 1",
        name: "Baker v Canada", locator_kind: "paragraph", locator: "7" });
    } finally { editor.destroy(); }
  });
});
