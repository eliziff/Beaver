import { describe, expect, it } from "vitest";

import { findRegexMatches, findTextMatches } from "../tools/documentOps";

const TEXT = [
  "8.01 Financial Covenants.",
  "(a) The Borrower shall maintain Minimum Liquidity of $5,000,000.",
  "(b) The Total Net Leverage Ratio shall not exceed 4.50:1.00.",
  "Notices go to 100 King Street West, Toronto.",
].join("\n");

describe("findRegexMatches", () => {
  it("matches line-by-line with absolute offsets", () => {
    const result = findRegexMatches({
      text: TEXT,
      pattern: "\\$[\\d,]+",
      maxResults: 10,
      contextChars: 40,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.totalMatches).toBe(1);
    expect(result.hits[0].excerpt).toBe("$5,000,000");
    expect(TEXT.slice(result.hits[0].at, result.hits[0].at + 10)).toBe(
      "$5,000,000",
    );
  });

  it("anchors ^ and $ to lines, not the document", () => {
    const result = findRegexMatches({
      text: TEXT,
      pattern: "^\\([a-z]\\) The\\b.*\\.$",
      maxResults: 10,
      contextChars: 40,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.totalMatches).toBe(2);
    expect(result.hits.map((hit) => hit.excerpt.slice(0, 3))).toEqual([
      "(a)",
      "(b)",
    ]);
  });

  it("supports case-insensitive matching as an explicit option", () => {
    const sensitive = findRegexMatches({
      text: TEXT,
      pattern: "borrower",
      maxResults: 10,
      contextChars: 40,
    });
    const insensitive = findRegexMatches({
      text: TEXT,
      pattern: "borrower",
      maxResults: 10,
      contextChars: 40,
      caseInsensitive: true,
    });
    if ("error" in sensitive || "error" in insensitive) throw new Error("typed");
    expect(sensitive.totalMatches).toBe(0);
    expect(insensitive.totalMatches).toBe(1);
  });

  it("returns typed errors for invalid or oversized patterns", () => {
    const invalid = findRegexMatches({
      text: TEXT,
      pattern: "([unclosed",
      maxResults: 10,
      contextChars: 40,
    });
    expect("error" in invalid && invalid.error).toMatch(/invalid regex/u);
    const oversized = findRegexMatches({
      text: TEXT,
      pattern: "x".repeat(301),
      maxResults: 10,
      contextChars: 40,
    });
    expect("error" in oversized && oversized.error).toMatch(/too long/u);
  });
});

describe("findTextMatches offsets", () => {
  it("reports the original-text offset of each hit", () => {
    const { hits } = findTextMatches({
      text: TEXT,
      query: "Leverage Ratio",
      maxResults: 5,
      contextChars: 40,
    });
    expect(hits).toHaveLength(1);
    expect(TEXT.slice(hits[0].at, hits[0].at + 8)).toBe("Leverage");
  });
});
