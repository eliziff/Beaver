import { afterEach, describe, expect, it, vi } from "vitest";

// Integration test: a model response whose <CITATIONS> block is truncated
// (missing "]" and </CITATIONS>) must still produce recovered citations in
// the final citations SSE event and keep the block out of visible text.
// The LLM adapter is mocked; everything downstream of it is real.

afterEach(() => {
  vi.doUnmock("../llm");
  vi.doUnmock("../mcpConnectors");
  vi.resetModules();
});

const PROSE =
  "The annual rent is $84,000 [1] and the term is five (5) years [2].";
const TRUNCATED_BLOCK = `\n<CITATIONS>\n[\n  {"ref": 1, "doc_id": "doc-0", "quotes": [{"page": 1, "quote": "The initial annual rent is $84,000"}]},\n  {"ref": 2, "doc_id": "doc-0", "quotes": [{"page": 2, "quote": "The term of this lease is five (5) years"}]}\n`;

async function runWithMockedModel(fullResponse: string) {
  vi.doMock("../mcpConnectors", () => ({
    buildUserMcpTools: async () => [],
  }));
  vi.doMock("../llm", async (importOriginal) => {
    const original = await importOriginal<typeof import("../llm")>();
    return {
      ...original,
      streamChatWithTools: async (params: {
        callbacks?: { onContentDelta?: (text: string) => void };
      }) => {
        // Stream in small chunks to exercise the visible-tail buffering.
        for (let index = 0; index < fullResponse.length; index += 7) {
          params.callbacks?.onContentDelta?.(fullResponse.slice(index, index + 7));
        }
        return { fullText: fullResponse };
      },
    };
  });
  const { runLLMStream } = await import("../chat/streaming");

  const written: string[] = [];
  const result = await runLLMStream({
    apiMessages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "What are the rent and term?" },
    ],
    docStore: new Map(),
    docIndex: {
      "doc-0": { document_id: "11111111-1111-1111-1111-111111111111", filename: "lease.pdf" },
    },
    userId: "test-user",
    db: {} as never,
    write: (chunk: string) => {
      written.push(chunk);
    },
  });
  return { result, written };
}

describe("streaming citation truncation recovery", () => {
  it("recovers citations when the block loses its closing bracket and tag", async () => {
    const { result, written } = await runWithMockedModel(
      PROSE + TRUNCATED_BLOCK,
    );

    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toMatchObject({
      type: "citation_data",
      kind: "document",
      ref: 1,
      doc_id: "doc-0",
      filename: "lease.pdf",
      page: 1,
    });
    expect(result.citations[1]).toMatchObject({ ref: 2, page: 2 });

    // The final SSE citations event carries the recovered citations.
    const finalEvent = written
      .map((chunk) => chunk.replace(/^data: /u, "").trim())
      .filter((chunk) => chunk && chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk) as { type: string; status?: string; citations?: unknown[] })
      .find((event) => event.type === "citations" && event.status === "final");
    expect(finalEvent?.citations).toHaveLength(2);

    // Visible text keeps the prose and never leaks the block.
    const contentEvents = result.events.filter(
      (event): event is { type: "content"; text: string } =>
        event.type === "content",
    );
    const visible = contentEvents.map((event) => event.text).join("");
    expect(visible).toContain("[1]");
    expect(visible).not.toContain("<CITATIONS>");
    expect(visible).not.toContain('"doc_id"');
  });

  it("still parses a complete block strictly through the same path", async () => {
    const { result } = await runWithMockedModel(
      `${PROSE}${TRUNCATED_BLOCK}]\n</CITATIONS>`,
    );
    expect(result.citations).toHaveLength(2);
  });

  it("streams partial citation snapshots while the block is arriving", async () => {
    const { written } = await runWithMockedModel(PROSE + TRUNCATED_BLOCK);
    const partials = written
      .map((chunk) => chunk.replace(/^data: /u, "").trim())
      .filter((chunk) => chunk && chunk !== "[DONE]")
      .map((chunk) => JSON.parse(chunk) as { type: string; status?: string })
      .filter((event) => event.type === "citations" && event.status === "partial");
    expect(partials.length).toBeGreaterThan(0);
  });
});
