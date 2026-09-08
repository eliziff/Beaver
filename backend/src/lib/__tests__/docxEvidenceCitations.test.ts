import { describe, expect, it } from "vitest";

import {
  createLegalEvidenceTurnState,
  legalEvidenceReceiptEvent,
  registerLegalEvidence,
  type LegalEvidenceReceipt,
} from "../chat/legalEvidence";
import { renderDocxMarkdown, type DocxCitationAppearance } from "../chat/tools/docxMarkdown";
import { createDocxAuthorityLedger,
  resolveDocxEvidenceCitations } from "../docxEvidenceCitations";

function receipt(
  evidenceId: string,
  locator: string,
  overrides: Partial<LegalEvidenceReceipt> = {},
): LegalEvidenceReceipt {
  return {
    evidence_id: evidenceId,
    provider: "tna",
    jurisdiction: "ca",
    source_class: "case",
    stable_source_id: "case:example",
    source_sha256: "sha256:source",
    scope: "passage",
    block_id: locator,
    span_sha256: `sha256:${locator}`,
    span_text: `The verified text at ${locator}.`,
    citation: "2026 SCC 1",
    name: "Example v State",
    dataset: "fixture",
    language: "en",
    version: "1",
    external_url: "https://example.test/case",
    locator: { kind: "paragraph", label: locator },
    resolver_version: "tna-span-v1",
    ...overrides,
  };
}

describe("DOCX evidence citations", () => {
  it("projects short evidence ids into one authority with narrow pinpoints", () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5"));
    registerLegalEvidence(state, receipt("e_paragraph_9", "par9"));

    const resolved = resolveDocxEvidenceCitations(state, {
      rule: ["e_paragraph_5", "e_paragraph_9"],
    });

    expect(resolved.citations.rule.sources).toHaveLength(1);
    expect(resolved.citations.rule.sources[0]).toMatchObject({
      authority: "Example v State, 2026 SCC 1",
      mainUrl: "https://example.test/case",
      pinpoints: [{ text: "para 5" }, { text: "para 9" }],
    });
    expect(resolved.bindings[0]).toMatchObject({
      evidenceIds: ["e_paragraph_5", "e_paragraph_9"],
      sourceSha256s: ["sha256:source"],
      locators: ["para 5", "para 9"],
    });
    expect(legalEvidenceReceiptEvent(state)).toMatchObject({
      status: "passed",
      claims: [],
      evidence: [
        { evidence_id: "e_paragraph_5" },
        { evidence_id: "e_paragraph_9" },
      ],
    });
  });

  it("rejects stale ids and document-level receipts", () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_whole_document", "document", {
      scope: "document",
      span_text: null,
      locator: { kind: "document", label: "document" },
    }));

    expect(() => resolveDocxEvidenceCitations(state, {
      missing: ["e_not_registered"],
    })).toThrow("unknown evidence_id");
    expect(() => resolveDocxEvidenceCitations(state, {
      broad: ["e_whole_document"],
    })).toThrow("requires exact passage evidence");
  });

  it("rejects malformed citation maps, duplicate ids and excessive evidence", () => {
    const state = createLegalEvidenceTurnState();
    for (const citations of [[], [{ id: "rule", evidence_ids: ["e_paragraph_5"] }],
      { rule: { citation: "Model-authored text", evidence_ids: ["e_paragraph_5"] } },
      { rule: ["mike-evidence:v1:forged"] }, { rule: [] },
      { rule: ["e_paragraph_5", "e_paragraph_5"] },
      { rule: ["e_paragraph_5"], " rule ": ["e_paragraph_9"] },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`rule_${i}`, ["e_paragraph_5"]])),
      { rule: Array.from({ length: 17 }, (_, i) => `e_paragraph_${i}`) },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`rule_${i}`,
        Array.from({ length: 16 }, (_, j) => `e_paragraph_${j}`)]))]) {
      expect(() => resolveDocxEvidenceCitations(state, citations)).toThrow("DOCX citation");
    }
  });

  it("records exact rendered citation markers without reparsing them later", async () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", {
      source_sha256: "a".repeat(64),
    }));
    const resolved = resolveDocxEvidenceCitations(state, { rule: ["e_paragraph_5"] });
    const appearances: DocxCitationAppearance[] = [];
    const bytes = await renderDocxMarkdown("The rule applies.[@rule]", {
      citations: resolved.citations }, [], appearances);
    const ledger = await createDocxAuthorityLedger(state, bytes, resolved, appearances);

    expect(ledger).toMatchObject({
      schemaVersion: "beaver.authority-ledger.v1",
      seeds: [{ key: "2026scc1", evidenceIds: ["e_paragraph_5"] }],
      occurrences: [{ markerId: "rule", authorityKey: "2026scc1",
        unit: { id: "body:0", text: "The rule applies. Example v State, 2026 SCC 1 at para 5" },
        text: "Example v State, 2026 SCC 1 at para 5", displayedForm: "full",
        evidenceIds: ["e_paragraph_5"] }],
    });
  });

  it("omits the ledger when rendered citation text is ambiguous", async () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", {
      source_sha256: "a".repeat(64),
    }));
    const resolved = resolveDocxEvidenceCitations(state, { rule: ["e_paragraph_5"] });
    const citation = "Example v State, 2026 SCC 1 at para 5";
    const appearances: DocxCitationAppearance[] = [];
    const bytes = await renderDocxMarkdown(`Unrelated prose: ${citation}. Claim.[@rule]`, {
      citations: resolved.citations }, [], appearances);
    expect(await createDocxAuthorityLedger(state, bytes, resolved, appearances)).toBeUndefined();
  });

  it("binds actual full, ibid, supra, grouped and authored-note appearances by note identity", async () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", { source_sha256: "a".repeat(64) }));
    registerLegalEvidence(state, receipt("e_other_para5", "par5", {
      stable_source_id: "case:other", citation: "2026 SCC 2", name: "Other v State",
      source_sha256: "b".repeat(64),
    }));
    const resolved = resolveDocxEvidenceCitations(state, { rule: ["e_paragraph_5"],
      other: ["e_other_para5"], both: ["e_paragraph_5", "e_other_para5"] });
    const appearances: DocxCitationAppearance[] = [];
    const bytes = await renderDocxMarkdown(
      "Author.[^note]\n\nFirst.[@rule]\n\nAgain.[@rule]\n\nOther.[@other]\n\nLater.[@rule]\n\nBoth.[@both]\n\n[^note]: Authored.[@rule]",
      { citations: resolved.citations, citationPlacement: "footnotes" }, [], appearances);
    const ledger = await createDocxAuthorityLedger(state, bytes, resolved, appearances);
    expect(ledger?.occurrences.map(({ unit, displayedForm }) => [unit.footnoteId, displayedForm]))
      .toEqual([[2, "full"], [3, "ibid"], [4, "full"], [5, "supra"], [6, "full"], [6, "full"], [1, "full"]]);
    for (const occurrence of ledger!.occurrences)
      expect(occurrence.unit.text.slice(occurrence.start, occurrence.end)).toBe(occurrence.text);
  });

  it.each(["inline", "after-paragraph", "none"] as const)("binds only emitted %s markers", async (citationPlacement) => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", { source_sha256: "a".repeat(64) }));
    const resolved = resolveDocxEvidenceCitations(state, { rule: ["e_paragraph_5"] });
    const appearances: DocxCitationAppearance[] = [];
    const bytes = await renderDocxMarkdown("Claim.[@rule][@rule]", {
      citations: resolved.citations, citationPlacement }, [], appearances);
    const ledger = await createDocxAuthorityLedger(state, bytes, resolved, appearances);
    expect(ledger?.occurrences).toHaveLength(citationPlacement === "none" ? 0 : citationPlacement === "inline" ? 2 : 1);
  });

  it.each(["inline", "after-paragraph", "footnotes"] as const)("binds grouped and individual %s markers without assigning unrelated prose", async (citationPlacement) => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", { source_sha256: "a".repeat(64) }));
    registerLegalEvidence(state, receipt("e_other_para9", "par9", {
      stable_source_id: "case:other", citation: "2026 SCC 2", name: "Other v State", source_sha256: "b".repeat(64),
    }));
    const resolved = resolveDocxEvidenceCitations(state, {
      rule: ["e_paragraph_5"], other: ["e_other_para9"], both: ["e_paragraph_5", "e_other_para9"],
    });
    const markdown = "First.[@rule]\n\nAgain.[@rule]\n\nAuthored.[^note]\n\nOther.[@other]\n\nLater.[@rule]\n\nBoth.[@both]\n\n[^note]: Authored note.";
    const appearances: DocxCitationAppearance[] = [];
    const bytes = await renderDocxMarkdown(markdown, { citations: resolved.citations, citationPlacement }, [], appearances);
    const ledger = await createDocxAuthorityLedger(state, bytes, resolved, appearances);
    expect(ledger?.occurrences.map(({ markerId, evidenceIds, pinpoints }) => [markerId, evidenceIds, pinpoints]))
      .toEqual([...["rule", "rule", "other", "rule"], "both", "both"].map((marker, index) =>
        [marker, [index === 2 || index === 5 ? "e_other_para9" : "e_paragraph_5"],
          [{ kind: "paragraph", text: index === 2 || index === 5 ? "para 9" : "para 5" }]]));
    for (const occurrence of ledger!.occurrences)
      expect(occurrence.unit.text.slice(occurrence.start, occurrence.end)).toBe(occurrence.text);
    if (citationPlacement === "footnotes") return;
    for (const extra of ["Example v State, 2026 SCC 1 at para 5",
      "Example v State, 2026 SCC 1 at para 5; Other v State, 2026 SCC 2 at para 9"]) {
      const ambiguous: DocxCitationAppearance[] = [];
      const document = await renderDocxMarkdown(`Unrelated: ${extra}.\n\n${markdown}`,
        { citations: resolved.citations, citationPlacement }, [], ambiguous);
      expect(await createDocxAuthorityLedger(state, document, resolved, ambiguous)).toBeUndefined();
    }
  });
});
