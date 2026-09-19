import { it } from "vitest";
import assert from "node:assert/strict";
import { answerJevRow, createJevRouter, jevCandidates, jevConfig, parseJevRoutes, JEV_MODEL, JEV_LIMITS } from "./jev";
import type { JevConfig, JevRoute } from "./jev";
import type { LegalEvidenceReceipt } from "../chat/legalEvidence";
import type { TabularColumn } from "../tabularStore";

const config: JevConfig = { apiKey: "fixture-only", model: JEV_MODEL, answerMin: .95, supportMin: .95, evidenceMin: .5, timeoutMs: 1000 };
const evidence = ["Alpha must protect Beta's confidential information.", "Beta must protect Alpha's confidential information.",
  "Disclosure to legal advisers is permitted only if they owe confidentiality obligations.",
  "Signed January 1, 2026; effective January 15, 2026."].map((span_text, i) => ({ evidence_id: `e_${i}`, scope: "passage", span_text } as LegalEvidenceReceipt));
const columns: TabularColumn[] = [
  { index: 7, name: "Direction", format: "tag", tags: ["Mutual", "Unilateral"], prompt: "Classify the confidentiality obligations as Mutual or Unilateral." },
  { index: 12, name: "Unrestricted disclosure", format: "yes_no", prompt: "May information be disclosed to legal advisers without confidentiality obligations?" },
  { index: 22, name: "Effective date", format: "date", prompt: "What is the explicitly stated effective date?" },
];
const routes: JevRoute[] = [{ index: 7, kind: "choice" }, { index: 12, kind: "choice" }, { index: 22, kind: "date" }];
const fixtureFetch = (mutate?: (body: any, request: any) => void, requests: any[] = []): typeof fetch => async (_url, init) => {
  const request = JSON.parse(String(init!.body)); requests.push(request);
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, raw]) => {
    const question = raw as any;
    if (question.type === "choice") {
      const selected = id === "a0" ? "v0" : "v1", options = Object.keys(question.criteria);
      return [id, { type: "choice", choice: selected, confidence: .99,
        probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? .99 : .01 / (options.length - 1)])) }];
    }
    return [id, { type: "noul", noul: id.startsWith("s") || ["e0_0", "e0_1", "e1_2", "e2_3"].includes(id) ? .99 : .01 }];
  }));
  const body = { model: JEV_MODEL, answers, usage: { input_tokens: 100, output_tokens: 10 } };
  mutate?.(body, request); return new Response(JSON.stringify(body));
};
const run = (fetchImpl = fixtureFetch(), overrides: Partial<Parameters<typeof answerJevRow>[0]> = {}) =>
  answerJevRow({ columns, routes, evidence, scopeComplete: true, config, fetchImpl, ...overrides });

it("uses semantic routing output without inventing labels, changing formats or decomposing questions", () => {
  assert.deepEqual(parseJevRoutes(JSON.stringify({ routes }), columns), routes);
  assert.deepEqual(parseJevRoutes('{"routes":[{"index":7,"kind":"date"}]}', columns), []);
  assert.deepEqual(parseJevRoutes('{"routes":[{"index":7,"kind":"choice"},{"index":7,"kind":"choice"}]}', columns), []);
  const text = [{ index: 0, name: "Direction", prompt: "Choose Mutual or Unilateral.", format: "text" }];
  assert.equal(parseJevRoutes('{"routes":[{"index":0,"kind":"choice","labels":["Mutual","Unilateral"]}]}', text).length, 1);
  assert.deepEqual(parseJevRoutes('{"routes":[{"index":0,"kind":"choice","labels":["Safe","Unsafe"]}]}', text), []);
});
it("shares routing work but invalidates edits and isolates users and models", async () => {
  let calls = 0; const route = createJevRouter(), ask = async () => { calls++; return JSON.stringify({ routes }); };
  const input = { userId: "one", model: "normal", columns, ask };
  await Promise.all([route(input), route(input), route(input)]); assert.equal(calls, 1);
  await route({ ...input, userId: "two" }); await route({ ...input, model: "different" });
  await route({ ...input, columns: [{ ...columns[0], prompt: "Identify the direction AND the parties." }] });
  assert.equal(calls, 4);
  const failed = createJevRouter(); assert.deepEqual(await failed({ ...input, ask: async () => { throw new Error("offline"); } }), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(route({ ...input, signal: controller.signal }), { name: "AbortError" });
});
it("answers real categorical and source-value cells with multiple citations, including a strong No", async () => {
  const requests: any[] = [], result = await run(fixtureFetch(undefined, requests));
  assert.equal(result.calls, 2); assert.equal(result.inputTokens, 200);
  assert.deepEqual(result.decisions.map(({ status, value, evidence_ids }) => ({ status, value, evidence_ids })), [
    { status: "accepted", value: "Mutual", evidence_ids: ["e_0", "e_1"] },
    { status: "accepted", value: false, evidence_ids: ["e_2"] },
    { status: "accepted", value: "2026-01-15", evidence_ids: ["e_3"] },
  ]);
  assert.deepEqual(requests[0].state.columns.map((c: any) => c.prompt), columns.map(c => c.prompt));
  assert.deepEqual(requests[1].state.checks[0].passages.map((p: any) => p.id), ["e_0", "e_1"]);
  assert.equal(requests[1].state.passages, undefined); // Verifier cannot repair wrong citations using the rest of the source.
});
it("falls back per cell on unsupported answers, missing evidence and ambiguous choices", async () => {
  const result = await run(fixtureFetch((body) => { if (body.answers.s1) body.answers.s1.noul = .02; }));
  assert.deepEqual(result.decisions.map(d => d.status), ["accepted", "unsupported", "accepted"]);
  const noEvidence = await run(fixtureFetch((body) => {
    for (const key of Object.keys(body.answers)) if (key.startsWith("e0_")) body.answers[key].noul = .01;
  }));
  assert.equal(noEvidence.decisions[0].status, "evidence_unresolved");
  const uncertain = await run(fixtureFetch((body) => { if (body.answers.a1) body.answers.a1 = { type: "choice", choice: "unresolved", confidence: .99,
    probabilities: { v0: .005, v1: .005, unresolved: .99 } }; }));
  assert.equal(uncertain.decisions[1].status, "uncertain");
});
it("rejects malformed, mismatched and incomplete provider results rather than publish cells", async () => {
  for (const mutate of [
    (body: any) => { body.model = "jev-latest"; },
    (body: any) => { delete body.answers[Object.keys(body.answers)[0]]; },
    (body: any) => { if (body.answers.a0) body.answers.a0.probabilities.v0 = 1.5; },
    (body: any) => { if (body.answers.a0) body.answers.a0.choice = "foreign-id"; },
    (body: any) => { if (body.answers.e0_0) body.answers.e0_0.noul = "0.99"; },
  ]) assert.equal((await run(fixtureFetch(mutate))).decisions.some(d => d.status === "accepted"), false);
  const rateLimited = await run(async () => new Response("", { status: 429 }));
  assert.equal(rateLimited.calls, 1); assert.ok(rateLimited.decisions.every(d => d.status === "http_429"));
});
it("never treats partial or oversized scopes as complete and does not truncate late evidence", async () => {
  let calls = 0; const fetchImpl: typeof fetch = async () => { calls++; throw new Error("unexpected request"); };
  assert.ok((await run(fetchImpl, { scopeComplete: false })).decisions.every(d => d.status === "incomplete_scope"));
  const large = Array.from({ length: JEV_LIMITS.passages + 1 }, (_, i) => ({ ...evidence[0], evidence_id: `e_${i}` }));
  assert.ok((await run(fetchImpl, { evidence: large })).decisions.every(d => d.status === "packet_limit"));
  assert.equal(calls, 0);
});
it("copies only supported source values, preserves occurrences, and refuses invalid or overflowing dates", () => {
  const date = { index: 0, kind: "date" as const }, column = { index: 0, name: "Date", prompt: "Stated date", format: "date" };
  const source = [{ evidence_id: "e_0", span_text: "2026-02-30; 29 February 2024; February 29, 2024; 02/03/2026" } as LegalEvidenceReceipt];
  const candidates = jevCandidates(date, column, source);
  assert.deepEqual(candidates.map(c => c.value), ["2024-02-29", "2024-02-29"]);
  assert.notEqual(candidates[0].start, candidates[1].start);
  assert.deepEqual(jevCandidates(date, column, [{ ...source[0], span_text: "2026-01-01 ".repeat(255) }]), []);
});
it("keeps cancellation distinct from provider failure and bounds a stalled request", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(fixtureFetch(), { signal: controller.signal }), { name: "AbortError" });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const result = await run(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }), { config: { ...config, timeoutMs: 10 } });
    assert.ok(result.decisions.every(d => d.status === "provider_failure"));
  } finally { clearTimeout(keepAlive); }
});
it("makes configured auto execution real, disables old modes, and never parses blank thresholds as zero", () => {
  assert.equal(jevConfig({}), null); assert.equal(jevConfig({ TYPESAFE_API_KEY: "fixture", BEAVER_JEV_TABULAR_MODE: "shadow" }), null);
  assert.equal(jevConfig({ TYPESAFE_API_KEY: "fixture", BEAVER_JEV_ANSWER_MIN: " " })?.answerMin, .95);
  assert.equal(jevConfig({ TYPESAFE_API_KEY: "fixture", BEAVER_JEV_ANSWER_MIN: "nonsense" }), null);
  assert.equal(jevConfig({ TYPESAFE_API_KEY: "fixture", TYPESAFE_JEV_MODEL: "jev-latest" }), null);
});
