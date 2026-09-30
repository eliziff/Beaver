import { afterEach, expect, it, vi } from "vitest";
import { browserPromptSubmission, steerChat, streamChat } from "./chat";

afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

it("declares interactive browser submissions as human", async () => {
  sessionStorage.clear();
  const fetch = vi.fn().mockResolvedValue(new Response("", { headers: { "Content-Type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  await streamChat({ current_turn: { kind: "message", content: "Synthetic question" }, expected_version: 0 });
  expect(JSON.parse(fetch.mock.calls[0][1].body).submission).toEqual({ origin: "human" });
});

it("preserves a browser test run for prompts, answers and steering", async () => {
  const submission = { origin: "machine_test", run_id: "browser-run", scenario: "Synthetic fixture" };
  sessionStorage.setItem("beaver.promptSubmission", JSON.stringify(submission));
  const fetch = vi.fn().mockResolvedValue(Response.json({ steered: true }));
  vi.stubGlobal("fetch", fetch);
  await streamChat({ current_turn: { kind: "ask_inputs_response", responses: [
    { id: "choice", kind: "choice", answer: "Synthetic answer" } ] }, expected_version: 1 });
  await steerChat("chat", "steer", "Synthetic instruction");
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).submission)).toEqual([submission, submission]);
});

it.each(["not json", '{"origin":"human"}', '{"origin":"machine_test"}'])(
  "keeps invalid browser markers unknown: %s", marker => {
    sessionStorage.setItem("beaver.promptSubmission", marker);
    expect(browserPromptSubmission()).toEqual({ origin: "unknown" });
  });
