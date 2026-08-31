import { describe, expect, it } from "vitest";

import {
  createLegalEvidenceTurnState,
  legalEvidenceReceiptEvent,
  registerLegalEvidence,
  type LegalEvidenceReceipt,
} from "../chat/legalEvidence";
import { createDocxAuthorityLedger,
  resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import { WRITE_TOOL } from "../chat/tools/toolSchemas";

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
  it("keeps the model-facing citation contract to short evidence ids", () => {
    const schema = WRITE_TOOL.inputSchema as {
      properties: Record<string, {
        items?: { properties?: Record<string, unknown> };
      }>;
    };

    expect(schema.properties).toHaveProperty("citations");
    expect(schema.properties).not.toHaveProperty("sources");
    expect(Object.keys(
      schema.properties.citations.items?.properties ?? {},
    )).toEqual(["id", "evidence_ids"]);
  });

  it("projects short evidence ids into one authority with narrow pinpoints", () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5"));
    registerLegalEvidence(state, receipt("e_paragraph_9", "par9"));

    const resolved = resolveDocxEvidenceCitations(state, [{
      id: "rule",
      evidence_ids: ["e_paragraph_5", "e_paragraph_9"],
    }]);

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

    expect(() => resolveDocxEvidenceCitations(state, [{
      id: "missing",
      evidence_ids: ["e_not_registered"],
    }])).toThrow("unknown evidence_id");
    expect(() => resolveDocxEvidenceCitations(state, [{
      id: "broad",
      evidence_ids: ["e_whole_document"],
    }])).toThrow("requires exact passage evidence");
  });

  it("rejects model-authored citation prose and old-shape handles", () => {
    const state = createLegalEvidenceTurnState();
    expect(() => resolveDocxEvidenceCitations(state, [{
      id: "forged",
      evidence_ids: ["e_paragraph_5"],
      citation: "Model-authored text",
      handles: ["mike-evidence:v1:forged"],
    }])).toThrow("unsupported fields");
  });

  it("records exact rendered citation markers without reparsing them later", async () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", {
      source_sha256: "a".repeat(64),
    }));
    const resolved = resolveDocxEvidenceCitations(state, [{
      id: "rule", evidence_ids: ["e_paragraph_5"],
    }]);
    const unit = { key: "body:0", kind: "body" as const, ordinal: 0,
      footnote_id: null, page_numbers: [], footnote_refs: [],
      text: "The rule applies. Example v State, 2026 SCC 1 at para 5." };
    const ledger = await createDocxAuthorityLedger(state,
      "The rule applies.[@rule]", Buffer.from("docx"), resolved, "inline", {
        citationLookupKey: () => "case:2026scc1",
        docxAuthorityTextUnits: async () => [unit],
      });

    expect(ledger).toMatchObject({
      schemaVersion: "beaver.authority-ledger.v1",
      seeds: [{ key: "case:2026scc1", evidenceIds: ["e_paragraph_5"] }],
      occurrences: [{ markerId: "rule", authorityKey: "case:2026scc1",
        unit: { id: "body:0", text: unit.text },
        text: "Example v State, 2026 SCC 1 at para 5", displayedForm: "full",
        evidenceIds: ["e_paragraph_5"] }],
    });
  });

  it("omits the ledger when rendered citation text is ambiguous", async () => {
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, receipt("e_paragraph_5", "par5", {
      source_sha256: "a".repeat(64),
    }));
    const resolved = resolveDocxEvidenceCitations(state, [{
      id: "rule", evidence_ids: ["e_paragraph_5"],
    }]);
    const citation = "Example v State, 2026 SCC 1 at para 5";
    expect(await createDocxAuthorityLedger(state, "Text.[@rule]", Buffer.from("docx"),
      resolved, "inline", {
        citationLookupKey: () => "case:2026scc1",
        docxAuthorityTextUnits: async () => [{ key: "body:0", kind: "body",
          ordinal: 0, footnote_id: null, page_numbers: [], footnote_refs: [],
          text: `${citation}. Repeated ${citation}.` }],
      })).toBeUndefined();
  });
});
