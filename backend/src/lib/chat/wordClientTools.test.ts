import { describe, expect, it, vi } from "vitest";
import { APPLY_WORD_EDITS, READ_ACTIVE_DOCUMENT, wordClientTools } from "./wordClientTools";

const signal = new AbortController().signal;
const context = {} as Parameters<ReturnType<typeof wordClientTools>[number]["execute"]>[1];
const call = { id: "call", name: "tool", input: {} } as Parameters<
  ReturnType<typeof wordClientTools>[number]["execute"]
>[3];

describe("Word client tools", () => {
  it("reads bounded live excerpts through the supplied client port", async () => {
    const client = vi.fn().mockResolvedValue({
      scope: "document", offset: 0, text: "Live text", total_chars: 9,
    });
    const tools = wordClientTools({
      call: client,
      editMode: "manual",
      onMutation: vi.fn(),
    });
    const outcome = await tools[0].execute({}, context, signal, call);
    expect(tools[0].name).toBe(READ_ACTIVE_DOCUMENT);
    expect(client).toHaveBeenCalledWith(READ_ACTIVE_DOCUMENT, {}, signal);
    expect(outcome.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Live text") });
  });

  it("fences mutation before dispatch and reports tracked outcomes", async () => {
    const order: string[] = [];
    const tools = wordClientTools({
      editMode: "manual",
      onMutation: async () => { order.push("fence"); },
      call: async () => {
        order.push("client");
        return { edits: [{ index: 0, status: "tracked", matches: 1 }] };
      },
    });
    const outcome = await tools[1].execute({ edits: [{
      original: "old", replacement: "new", reason: "Clarity",
    }] }, context, signal, call);
    expect(tools[1].name).toBe(APPLY_WORD_EDITS);
    expect(order).toEqual(["fence", "client"]);
    expect(outcome.mutated).toBe(true);
    expect(outcome.result.isError).toBeUndefined();
  });

  it("rejects anchors Word cannot search before contacting the pane", async () => {
    const client = vi.fn();
    const tools = wordClientTools({ call: client, editMode: "auto", onMutation: vi.fn() });
    const outcome = await tools[1].execute({ edits: [{
      original: "two\nparagraphs", replacement: "one",
    }] }, context, signal, call);
    expect(outcome.result.isError).toBe(true);
    expect(client).not.toHaveBeenCalled();
  });
});
