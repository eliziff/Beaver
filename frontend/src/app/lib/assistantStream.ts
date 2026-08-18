import { parseAssistantProtocolEvent, type AssistantProtocolEvent } from "./assistantSession";

export const ASSISTANT_STREAM_LIMITS = {
  frame: 512 * 1024,
  buffered: 1024 * 1024,
  response: 8 * 1024 * 1024,
} as const;

export class AssistantProtocolError extends Error {
  name = "AssistantProtocolError";
  constructor() { super("The assistant response could not be read safely."); }
}

const protocolError = (): never => { throw new AssistantProtocolError(); };

export async function readAssistantEventStream({
  body,
  signal,
  expectedChatId,
  onEvent,
}: {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  expectedChatId?: string;
  onEvent: (event: AssistantProtocolEvent, chatId?: string) => void;
}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let chatId = expectedChatId;
  let sawDone = false;
  let sawTranscriptVersion = false;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted && !sawDone) {
      const chunk = await reader.read();
      if (signal.aborted) break;
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      total += text.length;
      if (total > ASSISTANT_STREAM_LIMITS.response) protocolError();
      buffer += text;
      if (buffer.length > ASSISTANT_STREAM_LIMITS.buffered) protocolError();
      if (chunk.done) buffer += "\n\n";
      const records = buffer.split(/\r?\n\r?\n/u);
      buffer = records.pop() ?? "";
      for (const record of records) {
        if (signal.aborted) break;
        const data = record.split(/\r?\n/u)
          .filter((line) => line === "data" || line.startsWith("data:"))
          .map((line) => line.slice(line[4] === ":" ? 5 : 4).replace(/^ /u, ""))
          .join("\n");
        if (!data && !record.includes("data")) continue;
        if (data.length > ASSISTANT_STREAM_LIMITS.frame) protocolError();
        if (data === "[DONE]") { sawDone = true; break; }
        let raw: unknown;
        try { raw = JSON.parse(data); } catch { protocolError(); }
        const parsed = parseAssistantProtocolEvent(raw);
        const event = parsed.ok ? parsed.event : protocolError();
        if (event.type === "chat_id") {
          if ((expectedChatId && event.chatId !== expectedChatId) || (chatId && event.chatId !== chatId)) protocolError();
          chatId = event.chatId;
        } else if (event.type === "transcript_version") {
          sawTranscriptVersion = true;
        }
        onEvent(event, chatId);
      }
      if (chunk.done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { chatId, sawDone, sawTranscriptVersion };
}
