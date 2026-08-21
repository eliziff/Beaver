import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_STREAM_LIMITS,
  AssistantProtocolError,
  readAssistantEventStream,
} from "./assistantStream";

const encoder = new TextEncoder();
const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
    controller.close();
  },
});

describe("readAssistantEventStream", () => {
  it("frames multiline SSE, parses each payload once, and returns transport metadata", async () => {
    const onEvent = vi.fn();
    const result = await readAssistantEventStream({
      body: stream(
        'data: {"type":\n',
        'data: "chat_id","chatId":"chat-1"}\r\n\r\n',
        'data: {"type":"transcript_version","transcriptVersion":4}\n\n',
        'data: [DONE]\n\n',
      ),
      signal: new AbortController().signal,
      expectedChatId: "chat-1",
      onEvent,
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ chatId: "chat-1", sawDone: true, sawTranscriptVersion: true });
  });

  it.each([
    ["malformed JSON", 'data: {nope}\n\n'],
    ["unknown event", 'data: {"type":"take_over_state"}\n\n'],
    ["prototype pollution", 'data: {"type":"content_delta","text":"bad","constructor":{"prototype":{"polluted":true}}}\n\n'],
    ["oversized frame", `data: ${"x".repeat(ASSISTANT_STREAM_LIMITS.frame + 1)}\n\n`],
  ])("reports one bounded protocol error for %s", async (_name, payload) => {
    const onEvent = vi.fn();
    await expect(readAssistantEventStream({
      body: stream(payload),
      signal: new AbortController().signal,
      onEvent,
    })).rejects.toEqual(new AssistantProtocolError());
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("rejects a chat-id switch on an established stream", async () => {
    await expect(readAssistantEventStream({
      body: stream('data: {"type":"chat_id","chatId":"other"}\n\n'),
      signal: new AbortController().signal,
      expectedChatId: "chat-1",
      onEvent: vi.fn(),
    })).rejects.toBeInstanceOf(AssistantProtocolError);
  });

  it("cancels the reader promptly and emits no events after abort", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode('data: {"type":"tool_activity","id":"read-1","tool":"Read","label":"Reading","status":"running"}\n\n'));
      },
      cancel() { cancelled = true; },
    });
    const abort = new AbortController();
    const onEvent = vi.fn(() => abort.abort());
    const result = await readAssistantEventStream({ body, signal: abort.signal, onEvent });
    expect(result.sawDone).toBe(false);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
    expect(() => controller.enqueue(encoder.encode('data: {"type":"tool_activity","id":"read-1","tool":"Read","label":"Read","status":"completed"}\n\n'))).toThrow();
  });
});
