import { expect, it } from "vitest";
import { parsePublicAssistantEvent, publicEvent } from "./assistantWire";
import { parseAssistantEvent, publicAssistantEvent } from "./assistantEvents";

it("keeps citation normalization stable across persistence and public replay", () => {
  const event = parsePublicAssistantEvent({ type: "content_final", text: "Answer [1]", citations: [
    { kind: "a2aj", ref: 1, citation: "2009 SCC 32", url: "javascript:alert(1)",
      external_url: "https://example.test/case", quotes: [{ quote: "Source passage" }] },
    { kind: "document", ref: 2, document_id: "d", filename: "bad.docx", quotes: [{ quote: {} }] },
  ] });
  expect(event).toMatchObject({ citations: [{ ref: 1, url: null }] });
  expect(parsePublicAssistantEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
});

it("projects reader display without exposing private continuation or checkpoint state", () => {
  const stored = parseAssistantEvent({ type: "subagent_run", id: "reader", task: "Read Grant",
    status: "completed", agent: "scout", model: "luna", effort: "low",
    output: "Public result", error: "private failure", publicError: "Reader failed." });
  expect(stored).not.toBeNull();
  expect(publicEvent.safeParse(stored).success).toBe(false);
  const visible = publicAssistantEvent(stored!);
  expect(parsePublicAssistantEvent(visible)).toEqual({ type: "subagent_run", id: "reader",
    task: "Read Grant", status: "completed", output: "Public result", error: "Reader failed." });
  const checkpoint = parseAssistantEvent({ type: "context_checkpoint", schema_version: 1,
    keep_current: false, payload: { secret: "private continuation" } });
  expect(publicAssistantEvent(checkpoint!)).toBeNull();
  expect(publicEvent.safeParse(checkpoint).success).toBe(false);
});
