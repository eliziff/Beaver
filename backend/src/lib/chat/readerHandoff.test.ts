import { describe, expect, it } from "vitest";
import { readerHandoff } from "./readerHandoff";
import { createA2AJPassageEvidence, createLegalEvidenceTurnState, registerLegalEvidence,
  legalEvidenceReceiptEvent } from "./legalEvidence";
import { runReadSubagentRound, createReadSubagentAdmission } from "./readSubagents";
import type { ReadSubagentEvent } from "./assistantEvents";

function fixture(id: string, count = 8, textSize = 3_000) {
  const state = createLegalEvidenceTurnState(), receipts = Array.from({ length: count }, (_, index) =>
    createA2AJPassageEvidence({ citation: `${id}-${index}`, name: `${id} source ${index}`, dataset: "scc",
      language: "en", sourceText: "x".repeat(textSize), start: 0, end: textSize,
      sourceClass: "case", externalUrl: null }));
  receipts.forEach(receipt => registerLegalEvidence(state, receipt));
  state.answer = receipts.slice(0, 2).map((receipt, index) => ({ text: `Finding ${id}-${index}.`, evidence_ids: [receipt.evidence_id] }));
  const event: ReadSubagentEvent = { type: "subagent_run", id, task: `Read ${id}`, status: "completed",
    grounding: legalEvidenceReceiptEvent(state)! };
  return { state, event, receipts };
}

describe("reader handoff", () => {
  it("keeps all findings and only their unique exact support across four readers", async () => {
    const parent = createLegalEvidenceTurnState(), fixtures = Array.from({ length: 4 }, (_, i) => fixture(`r${i}`));
    fixtures.forEach(({ receipts }) => receipts.forEach(receipt => registerLegalEvidence(parent, receipt, {}, false)));
    const before = JSON.stringify(fixtures.map(({ event }) => event));
    const output = await runReadSubagentRound({
      call: { id: "round", name: "delegate_read", input: { assignments: fixtures.map(({ event }) => ({ task: event.task, scope: event.id })) } },
      admit: createReadSubagentAdmission(),
      async runReader(call) {
        const { event } = fixtures.find(({ event }) => event.id === call.input.scope)!;
        return { tool_use_id: call.id, status: "ok", content: JSON.stringify(readerHandoff(event, parent, 0, 64, 14_000)) };
      },
    });
    const value = JSON.parse(output.content), readers = value.readers;
    expect(output.status).toBe("ok");
    expect(output.content.length).toBeLessThan(64_000);
    expect(readers.flatMap((reader: { findings: unknown[] }) => reader.findings)).toHaveLength(8);
    expect(readers.flatMap((reader: { evidence: unknown[] }) => reader.evidence)).toHaveLength(8);
    expect(output.content).not.toMatch(/sha256|not_run/);
    expect(parent.evidence.size).toBe(32);
    expect(parent.presentedEvidenceIds.size).toBe(8);
    expect(legalEvidenceReceiptEvent(parent)!.evidence).toHaveLength(32);
    expect(JSON.stringify(fixtures.map(({ event }) => event))).toBe(before);
  });

  it("pages whole findings and leaves oversized support retrievable by its original handle", () => {
    const { event, receipts } = fixture("long", 2, 60_000), state = createLegalEvidenceTurnState();
    receipts.forEach(receipt => registerLegalEvidence(state, receipt, {}, false));
    event.grounding!.claims = Array.from({ length: 64 }, (_, i) => ({ ...event.grounding!.claims[0],
      text: `${i}: ${"Long finding ".repeat(80)}` }));
    const findings: string[] = []; let offset = 0;
    do {
      const page = readerHandoff(event, state, offset, 64, 14_000);
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(14_000);
      expect(page.findings.length).toBeGreaterThan(0);
      expect(page.evidence).toEqual([]);
      expect(page.omitted_evidence).toEqual([receipts[0].evidence_id]);
      findings.push(...page.findings.map(claim => claim.text));
      offset = page.next_read ? page.next_read.offset - 1 : -1;
    } while (offset >= 0);
    expect(findings).toEqual(event.grounding!.claims.map(claim => claim.text));
    expect(state.presentedEvidenceIds.size).toBe(0);
    expect(state.evidence.get(receipts[0].evidence_id)!.receipt.span_text).toHaveLength(60_000);
  });
});
