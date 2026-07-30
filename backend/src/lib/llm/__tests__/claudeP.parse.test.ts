import { describe, expect, it, vi } from "vitest";
import { parseReply } from "../claudeP";

const call = (input: Record<string, unknown>) =>
  `TOOL_CALLS\n${JSON.stringify({ calls: [{ id: "toolu_1", name: "submit", input }] })}`;

describe("claude-p parseReply", () => {
  it("parses a strict FINAL reply", () => {
    expect(parseReply("FINAL\nDone.", 0)).toEqual([
      { type: "text", text: "Done." },
    ]);
  });

  it("parses strict TOOL_CALLS", () => {
    const blocks = parseReply(call({ text: "plain" }), 0);
    expect(blocks).toEqual([
      { type: "tool_use", id: "toolu_1", name: "submit", input: { text: "plain" } },
    ]);
  });

  it("tolerates a code fence around the whole reply", () => {
    const blocks = parseReply("```\n" + call({ a: 1 }) + "\n```", 0);
    expect(blocks[0]).toMatchObject({ name: "submit", input: { a: 1 } });
  });

  it("tolerates a fenced JSON body after the marker", () => {
    const reply = 'TOOL_CALLS\n```json\n{"calls":[{"id":"x","name":"submit","input":{}}]}\n```';
    expect(parseReply(reply, 0)[0]).toMatchObject({ name: "submit" });
  });

  it("tolerates preamble prose before the marker", () => {
    const reply = "I will now submit.\n" + call({ ok: true });
    expect(parseReply(reply, 0)[0]).toMatchObject({ input: { ok: true } });
  });

  it("tolerates the JSON on the marker line", () => {
    const reply = 'TOOL_CALLS {"calls":[{"id":"x","name":"submit","input":{}}]}';
    expect(parseReply(reply, 0)[0]).toMatchObject({ name: "submit" });
  });

  it("repairs unescaped inner double quotes (the Stage 12 failure shape)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply =
      'TOOL_CALLS\n{"calls":[{"id":"x","name":"submit","input":{"quote":"The court held that "reasonable notice" was required."}}]}';
    const blocks = parseReply(reply, 0);
    expect(blocks[0]).toMatchObject({ name: "submit" });
    expect(String((blocks[0] as { input: { quote: string } }).input.quote)).toContain(
      "reasonable notice",
    );
    vi.restoreAllMocks();
  });

  it("repairs raw newlines inside string values", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply =
      'TOOL_CALLS\n{"calls":[{"id":"x","name":"submit","input":{"quote":"line one\nline two"}}]}';
    const blocks = parseReply(reply, 0);
    expect(
      String((blocks[0] as { input: { quote: string } }).input.quote),
    ).toContain("line two");
    vi.restoreAllMocks();
  });

  it("still rejects replies with no marker", () => {
    expect(() => parseReply("Here is my answer.", 0)).toThrow(
      /did not contain/u,
    );
  });

  it("still rejects an empty FINAL", () => {
    expect(() => parseReply("FINAL\n", 0)).toThrow(/empty/u);
  });

  it("still rejects TOOL_CALLS with no calls", () => {
    expect(() => parseReply('TOOL_CALLS\n{"calls":[]}', 0)).toThrow(
      /no calls/u,
    );
  });

  it("generates ids for calls that omit them", () => {
    const reply = 'TOOL_CALLS\n{"calls":[{"name":"submit","input":{}}]}';
    const block = parseReply(reply, 3)[0] as { id: string };
    expect(block.id).toMatch(/^toolu_3_0_/u);
  });
});
