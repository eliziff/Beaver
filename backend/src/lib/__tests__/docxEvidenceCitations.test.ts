import { describe, expect, it } from "vitest";

import {
  createLegalEvidenceTurnState,
  legalEvidenceReceiptEvent,
  registerLegalEvidence,
  type LegalEvidenceReceipt,
} from "../chat/legalEvidence";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
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
});
