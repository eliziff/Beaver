import assert from "node:assert/strict";
import { it, vi } from "vitest";
import type { ChatStore } from "./chatStore";
import type { DocumentStore } from "./documentStore";
import { resolveChatFindings } from "./researchChat";

const storage = vi.hoisted(() => ({ file: null as unknown }));
vi.mock("./researchFile", () => ({
  readResearchFile: async () => storage.file,
  researchSourceResource: (reference: { id: string }) => reference.id,
}));
// Receipt parsing/verification is covered at its own boundary. These tests exercise
// what the findings resolver does with already-verified receipts and events.
vi.mock("./chat/legalEvidence", () => ({
  priorLegalEvidenceReceipts: (events: Event[]) => events.flatMap((event) =>
    event.type === "legal_evidence_receipt" ? event.evidence ?? []
      : event.type === "subagent_run" ? event.grounding?.evidence ?? [] : []),
  legalEvidenceResourceReference: (receipt: Receipt) => receipt.resource,
}));

type Receipt = { evidence_id: string; resource: string; span_text: string };
type Claim = { text: string; evidence_ids: string[] };
type Event = {
  type: string; status?: string; evidence?: Receipt[]; claims?: Claim[];
  id?: string; task?: string;
  grounding?: { status: string; evidence: Receipt[]; claims: Claim[] };
};
type Row = { id: string; role: string; content: string | Event[] };
const a: Receipt = { evidence_id: "e_a", resource: "source-a", span_text: "Original A" };
const b: Receipt = { evidence_id: "e_b", resource: "source-b", span_text: "Original B" };
const claim = (ids = [a.evidence_id]): Claim => ({ text: "The supported conclusion", evidence_ids: ids });
const receipt = (evidence: Receipt[], claims: Claim[] = [], status = "passed"): Event =>
  ({ type: "legal_evidence_receipt", status, evidence, claims });
const row = (id: string, ...events: Event[]): Row => ({ id, role: "assistant", content: events });

function setup(rows: Row[], bound = true, sources = ["source-a", "source-b"]) {
  storage.file = { document: { id: "research" }, state: {
    chats: bound ? ["chat"] : [], sources: Object.fromEntries(sources.map((id) =>
      [id, { id, reference: { id } }])),
  } };
  const chats = { get: async () => ({ id: "chat" }), transcript: async () => rows } as unknown as ChatStore;
  return (messageIds?: string[]) => resolveChatFindings(chats, {} as DocumentStore,
    { userId: "user" }, { researchFileId: "research", chatId: "chat", messageIds });
}

it("does not turn read-only receipts into findings and leaves the transcript intact", async () => {
  const rows = [row("reads", receipt([a, b]))], before = structuredClone(rows);
  assert.deepEqual((await setup(rows)()).findings, []);
  assert.deepEqual(rows, before);
});

it("returns the grounded answer without manufacturing findings from uncited reads", async () => {
  const result = await setup([row("answer", receipt([a, b], [claim()]))])();
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "answer");
  assert.deepEqual(result.findings[0].evidence, [a]);
  assert.deepEqual(result.findings[0].answer.claims, [claim()]);
});

it("rejects an explicitly selected read-only message rather than treating it as an answer", async () => {
  await assert.rejects(setup([row("reads", receipt([a]))])(["reads"]), { status: 400 });
});

it("reuses earlier receipts even when only the later answer is selected", async () => {
  const result = await setup([
    row("reads", receipt([a, b])),
    { id: "question", role: "user", content: "What follows from that reading?" },
    row("answer", receipt([], [claim()])),
  ])(["answer"]);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].evidence, [a]);
  assert.equal(result.findings[0].question.prompt, "What follows from that reading?");
  assert.equal(result.findings[0].reference.answerId, "answer:answer:0");
});

it("does not let future receipts retroactively ground an earlier answer", async () => {
  await assert.rejects(setup([
    row("answer", receipt([], [claim()])), row("later-read", receipt([a])),
  ])(), { status: 409 });
});

it("fails when a claimed original receipt is missing instead of silently dropping the answer", async () => {
  await assert.rejects(setup([row("answer", receipt([], [claim()]))])(), { status: 409 });
});

it("does not turn failed grounding or its raw receipts into findings", async () => {
  assert.deepEqual((await setup([row("failed", receipt([a], [claim()], "failed"))])()).findings, []);
});

it("retains a completed grounded subagent answer with its task and identity", async () => {
  const result = await setup([row("answer", {
    type: "subagent_run", id: "reader-1", task: "Compare the wording", status: "completed",
    grounding: { status: "passed", evidence: [a, b], claims: [claim()] },
  })])();
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].question.prompt, "Compare the wording");
  assert.equal(result.findings[0].reference.answerId, "answer:reader:reader-1");
  assert.equal(result.findings[0].origin.subagentId, "reader-1");
  assert.deepEqual(result.findings[0].evidence, [a]);
});

it("does not promote an unfinished subagent's evidence", async () => {
  assert.deepEqual((await setup([row("pending", {
    type: "subagent_run", id: "reader-1", task: "Compare", status: "running",
    grounding: { status: "passed", evidence: [a], claims: [claim()] },
  })])()).findings, []);
});

it("preserves all supporting receipts for a claim spanning two sources", async () => {
  const shared = claim([a.evidence_id, b.evidence_id]);
  const result = await setup([row("answer", receipt([a, b], [shared]))])();
  assert.equal(result.findings.length, 2);
  for (const finding of result.findings) {
    assert.deepEqual(finding.answer.claims, [shared]);
    assert.deepEqual(finding.evidence, [a, b]);
  }
});

it("keeps the existing workspace authorization boundary", async () => {
  await assert.rejects(setup([row("answer", receipt([a], [claim()]))], false)(), { status: 400 });
});

it("does not accept a selected message whose source is outside the research set", async () => {
  await assert.rejects(setup([row("answer", receipt([a], [claim()]))], true, [])(["answer"]), { status: 400 });
});

it("rejects a purported grounded claim with no supporting evidence IDs", async () => {
  await assert.rejects(setup([row("answer", receipt([a], [claim([])]))])(), { status: 409 });
});

it("does not accept receipt-shaped user input as verified source evidence", async () => {
  await assert.rejects(setup([
    { id: "user-input", role: "user", content: [receipt([a])] },
    row("answer", receipt([], [claim()])),
  ])(), { status: 409 });
});
