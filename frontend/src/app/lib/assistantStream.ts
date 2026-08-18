import { parseAssistantProtocolEvent, type AssistantProtocolEvent } from "./assistantSession";
import { readSseData } from "./sse";

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
  let chatId = expectedChatId;
  let sawDone = false;
  let sawTranscriptVersion = false;
  for await (const data of readSseData(body, {
    signal,
    frameLimit: ASSISTANT_STREAM_LIMITS.frame,
    bufferLimit: ASSISTANT_STREAM_LIMITS.buffered,
    responseLimit: ASSISTANT_STREAM_LIMITS.response,
    onLimit: protocolError,
  })) {
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
  return { chatId, sawDone, sawTranscriptVersion };
}
