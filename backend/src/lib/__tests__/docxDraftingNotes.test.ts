import { describe, expect, it } from "vitest";

import { nativeNotesToMarkers } from "../docxDraftingSource";

describe("nativeNotesToMarkers", () => {
  it("converts refs and bodies to [^id] notation and unwraps the list", () => {
    const html =
      '<p>The term is five years.<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>' +
      '<ol><li id="footnote-1"><p>Subject to renewal. <a href="#footnote-ref-1">↑</a></p></li></ol>';
    const { html: out, warnings } = nativeNotesToMarkers(html);
    expect(out).toContain("five years.[^1]");
    expect(out).toContain("<p>[^1]: Subject to renewal.</p>");
    expect(out).not.toContain("<ol>");
    expect(out).not.toContain("footnote-");
    expect(warnings).toHaveLength(0);
  });

  it("flattens multi-paragraph bodies with a typed warning", () => {
    const html =
      '<p>Cap applies.<sup><a href="#footnote-2" id="footnote-ref-2">[2]</a></sup></p>' +
      '<ol><li id="footnote-2"><p>First part.</p><p>Second part. <a href="#footnote-ref-2">↑</a></p></li></ol>';
    const { html: out, warnings } = nativeNotesToMarkers(html);
    expect(out).toContain("<p>[^2]: First part. Second part.</p>");
    expect(warnings).toEqual([
      "Multi-paragraph note 2 was flattened into one native note.",
    ]);
  });

  it("leaves note-free HTML untouched", () => {
    const html = "<p>No notes here, just <strong>text</strong>.</p>";
    expect(nativeNotesToMarkers(html)).toEqual({ html, warnings: [] });
  });
});
