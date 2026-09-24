import { describe, expect, it } from "vitest";
import { previousEmptyScan, readQueryHistory } from "./queryHistory";
import { priorLegalEvidencePrompt, storedLegalResearchQueryReceipt } from "./legalEvidence";
import type { LegalResearchQueryReceipt } from "../researchContract";

const resource = "source://a2aj/case/2024%20SCC%201";
const sources = [{ resource, source_sha256: "a".repeat(64) }];
const query = (id = "q_one", overrides: Partial<LegalResearchQueryReceipt> = {}): LegalResearchQueryReceipt => ({
  query_id: id, call_id: "call", tool: "Read", executed_at: "2026-09-24T00:00:00Z", model: "reader-model",
  executor_version: "legal-source-pattern-v1", reader_id: "reader-1",
  input: { resource, pattern: "constructive trust", context_blocks: 0, search_scope: "judgment_text" },
  results: [], scan: { sources, total_matches: 0, headnote_matches: 1, truncated: false }, ...overrides,
});

describe("saved search history", () => {
  it("keeps negative results out of prompts and exposes filtered, paged receipts on demand", () => {
    const queries = Array.from({ length: 61 }, (_, i) => query(`q_${i}`));
    expect(priorLegalEvidencePrompt([], queries)).not.toContain("constructive trust");
    const page = readQueryHistory(queries, { pattern: "TRUST", section: resource, limit: 50 }) as { total: number; items: unknown[]; next_offset: number };
    expect(page.total).toBe(61); expect(page.items).toHaveLength(50); expect(page.next_offset).toBe(51);
    expect(page.items[0]).toMatchObject({ total_matches: 0, headnote_matches: 1, truncated: false });
    const tail = readQueryHistory(queries, { section: "reader-1", offset: page.next_offset });
    expect(tail).toMatchObject({ items: expect.any(Array), next_offset: null });
    expect(readQueryHistory(queries, { section: "other-reader" })).toMatchObject({ total: 0 });
    const full = readQueryHistory(queries, { file_path: "q_0" });
    expect(JSON.stringify(full)).not.toMatch(/source_sha256|reader-model|executor_version|call_id/);
    expect(storedLegalResearchQueryReceipt(queries[0])?.scan?.sources).toEqual(sources);
  });

  it("reuses only completed zero-match scans of the same source revision and searched scope", () => {
    const saved = query(), find = (item: LegalResearchQueryReceipt, input = saved.input, revisions = sources) =>
      previousEmptyScan([item], input, revisions);
    expect(find(saved)).toBe(saved);
    expect(find(saved, { ...saved.input, pattern: "constructive  trust", max_results: 1 })).toBe(saved);
    expect(find(saved, { ...saved.input, pattern: "trust" })).toBeUndefined();
    expect(find(saved, { ...saved.input, locator_kind: "paragraph", locator: "2" })).toBeUndefined();
    expect(find(saved, { ...saved.input, search_scope: "all_text" })).toBeUndefined();
    expect(find(saved, saved.input, [{ resource, source_sha256: "b".repeat(64) }])).toBeUndefined();
    expect(find(query("q_partial", { scan: { ...saved.scan!, truncated: true } }))).toBeUndefined();
    expect(find(query("q_positive", { scan: { ...saved.scan!, total_matches: 1 } }))).toBeUndefined();
    expect(find(query("q_error", { unavailable: ["a2aj"] }))).toBeUndefined();
    expect(find(query("q_legacy", { scan: undefined }))).toBeUndefined();
    expect(storedLegalResearchQueryReceipt(query("q_bad", { scan: { ...saved.scan!, total_matches: -1 } }))).toBeNull();
  });
});
