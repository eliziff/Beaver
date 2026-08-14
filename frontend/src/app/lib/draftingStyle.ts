import type { DraftingStyleSettings } from "./beaverApi";

export const DEFAULT_DRAFTING_STYLE: DraftingStyleSettings = {
    version: 1,
    documents: {
        memo: { citationPlacement: "footnotes", numberHeadings: false },
        factum: { citationPlacement: "inline", numberHeadings: true },
        letter: { citationPlacement: "footnotes", numberHeadings: false },
        other: { citationPlacement: "inline", numberHeadings: "auto" },
    },
    memoHeader: { to: "File", from: "AI Assistant" },
};
