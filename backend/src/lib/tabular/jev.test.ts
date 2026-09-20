import { expect, it, vi } from "vitest";
import { createLibraryEvidence } from "../chat/legalEvidence";
import { answerJevRow, jevConfig } from "./jev";

it.each([
  { choice: "v0", p: 0.90, support: 0.89, status: "accepted", value: true },
  { choice: "v1", p: 0.96, support: 0.94, status: "accepted", value: false },
  { choice: "v0", p: 0.98, support: 0.49, status: "unsupported", value: true },
  { choice: "v0", p: 0.98, support: 0.5, status: "unsupported", value: true },
  { choice: "unresolved", p: 0.90, support: 0.99, status: "uncertain", value: undefined },
  { choice: "v0", p: 0.5, support: 0.99, status: "uncertain", value: undefined },
])("uses selected answers and binary support: $choice / $p / $support => $status", async ({ choice, p, support, status, value }) => {
  const text = "The Customer must obtain consent before assigning this agreement.",
    evidence = createLibraryEvidence({ documentId: "consent", versionId: "v1", filename: "consent.txt",
      sourceText: text, spanText: text, start: 0, end: text.length }),
    config = jevConfig({ TYPESAFE_API_KEY: "test", BEAVER_JEV_TABULAR_MODE: "auto",
      BEAVER_JEV_ANSWER_MIN: "1", BEAVER_JEV_SUPPORT_MIN: "1" })!,
    fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id,
        id === "support" ? { type: "noul", noul: support } : id === "a0"
          ? { type: "choice", choice, confidence: p, probabilities: {
            v0: choice === "v0" ? p : 1 - p, v1: choice === "v1" ? p : 0,
            unresolved: choice === "unresolved" ? p : choice === "v0" ? 1 - p : 0 } }
          : { type: "noul", noul: 0.9 }]));
      return new Response(JSON.stringify({ model: config.model, answers,
        usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
    });
  const result = await answerJevRow({ columns: [{ index: 0, name: "Consent", prompt: "Is consent required?", format: "yes_no" }],
    routes: [{ index: 0, kind: "choice" }], evidence: [evidence], scopeComplete: true, config, fetchImpl });
  expect(result.decisions).toEqual([expect.objectContaining({ index: 0, status })]);
  expect(result.decisions[0].value).toBe(value);
  if (status === "accepted") expect(result.decisions[0].evidence_ids).toEqual([evidence.evidence_id]);
  expect(fetchImpl).toHaveBeenCalledTimes(status === "uncertain" ? 1 : 2);
});
