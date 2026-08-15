import type { DraftingStyleSettings } from "./beaverApi";

export const DEFAULT_DRAFTING_STYLE: DraftingStyleSettings = {
    version: 1,
    documents: {
        memo: { citationPlacement: "footnotes", citationHyperlinks: true, numberHeadings: false },
        factum: { citationPlacement: "inline", citationHyperlinks: true, numberHeadings: true },
        letter: { citationPlacement: "footnotes", citationHyperlinks: true, numberHeadings: false },
        other: { citationPlacement: "inline", citationHyperlinks: true, numberHeadings: "auto" },
    },
    memoHeader: { to: "File", from: "AI Assistant" },
};
