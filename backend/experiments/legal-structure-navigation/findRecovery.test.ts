import { describe, expect, it } from "vitest";

import { findRegexMatches, findTextMatchesFolded } from "./findRecovery";

const TEXT = "Heading\nThe *Borrower* shall pay $5,000,000.\nThe “Agreement” continues.";

describe("experimental find recovery", () => {
  it("recovers Markdown and smart-quote misses at raw offsets", () => {
    const markdown = findTextMatchesFolded({
      text: TEXT,
      query: "The Borrower shall pay",
      maxResults: 5,
      contextChars: 20,
    });
    expect(markdown.matchMode).toBe("folded");
    expect(markdown.hits[0].at).toBe(TEXT.indexOf("The *Borrower"));
    expect(findTextMatchesFolded({
      text: TEXT,
      query: 'The "Agreement" continues',
      maxResults: 5,
      contextChars: 20,
    }).matchMode).toBe("folded");
  });

  it("keeps grep anchors line-scoped and returns typed regex errors", () => {
    const found = findRegexMatches({
      text: TEXT,
      pattern: "^The.*\\.$",
      maxResults: 5,
      contextChars: 20,
    });
    if ("error" in found) throw new Error(found.error);
    expect(found.totalMatches).toBe(2);
    expect(findRegexMatches({
      text: TEXT,
      pattern: "([broken",
      maxResults: 5,
      contextChars: 20,
    })).toHaveProperty("error");
  });
});
