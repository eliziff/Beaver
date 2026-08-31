import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAFTING_STYLE, normalizeDraftingStyleSettings, resolveDraftingOptions,
} from "../draftingStyle";

describe("drafting style settings", () => {
  it("normalizes one versioned object and enforces document-specific options", () => {
    const settings = normalizeDraftingStyleSettings({
      version: 99,
      documents: {
        memo: { citationPlacement: "inline", citationHyperlinks: false, numberHeadings: true },
        letter: { citationPlacement: "after-paragraph" },
      },
      memoHeader: { to: "  General file  ", from: "Counsel" },
    });
    expect(settings).toMatchObject({
      version: 1,
      documents: { memo: { citationPlacement: "inline", citationHyperlinks: false,
        numberHeadings: true }, factum: DEFAULT_DRAFTING_STYLE.documents.factum,
        letter: DEFAULT_DRAFTING_STYLE.documents.letter },
      memoHeader: { to: "General file", from: "Counsel" },
    });
    expect(resolveDraftingOptions({ document_type: "memo" }, settings)).toMatchObject({
      citationPlacement: "inline", citationHyperlinks: false,
      memoHeader: { to: "General file", from: "Counsel" },
    });
    expect(() => resolveDraftingOptions({ document_type: "letter",
      citation_style: "after-paragraph" }, settings)).toThrow("factums");
  });
});
