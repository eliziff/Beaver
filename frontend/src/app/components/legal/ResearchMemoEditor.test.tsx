import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { memoExtensions } from "./ResearchMemoEditor";
import { citationMarkdown, memoCitation } from "./researchMemo";
import { citationPillParts } from "@/app/components/assistant/message/CitationSources";

describe("workspace memo Markdown", () => {
  it("uses the assistant citation presentation without exposing internal document ranges", () => {
    const citation = memoCitation("/sources/view?provider=a2aj&source_id=case-1&citation=2026+SCC+1&title=Baker+v+Canada&authority=Baker+v+Canada%2C+2026+SCC+1&doc_type=cases&locator=chars%3A0-850&locator_kind=document")!;
    expect(citationPillParts(citation)).toEqual({ styleOfCause: "Baker v Canada", rest: ", 2026 SCC 1" });
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
