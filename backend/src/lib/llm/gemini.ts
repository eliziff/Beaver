import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type {
  StreamChatParams,
  StreamChatResult,
  NormalizedToolCall,
} from "./types";
import { toGeminiTools } from "./tools";
import { abortError, throwIfAborted } from "./abort";
import { requireApiKey } from "./apiKeys";
import { createLlmTrace } from "./rawStreamLog";
import { modelContextWindow } from "./contextWindow";

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  // Set by Gemini when the text content is a thought summary rather than
  // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
  // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
  // a functionCall. It must be echoed back verbatim on the same part when
  // we replay the model's turn, or the API rejects the next call.
  thoughtSignature?: string;
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

function client(override?: string | null): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: requireApiKey(override, ["GEMINI_API_KEY"], "Gemini"),
  });
}

export function toNativeContents(
  messages: StreamChatParams["messages"],
): GeminiContent[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      { text: m.content },
      ...(m.role === "user"
        ? (m.images ?? []).map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.data },
          }))
        : []),
    ],
  }));
}

function geminiErrorMessage(error: unknown): string {
  const parsedObject = geminiStreamFailureMessage(error);
  if (parsedObject) return parsedObject;
  if (typeof error === "string") {
    const parsed = parseGeminiErrorPayload(error);
    if (parsed) return parsed;
    return error.startsWith("Gemini error:") ? error : `Gemini error: ${error}`;
  }
  if (error instanceof Error && error.message) {
    const parsed = parseGeminiErrorPayload(error.message);
    if (parsed) return parsed;
    return error.message.startsWith("Gemini error:")
      ? error.message
      : `Gemini error: ${error.message}`;
  }
  return `Gemini error: ${String(error)}`;
}

function parseGeminiErrorPayload(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return geminiStreamFailureMessage(parsed);
  } catch {
    return null;
  }
}

function geminiStreamFailureMessage(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const nested =
      typeof err.message === "string"
        ? parseGeminiErrorPayload(err.message)
        : null;
    if (nested) return nested;
    const message =
      typeof err.message === "string" && err.message.trim()
        ? err.message.trim()
        : "Gemini stream failed.";
    const code =
      typeof err.code === "string" && err.code.trim()
        ? err.code.trim()
        : typeof err.code === "number" && Number.isFinite(err.code)
          ? String(err.code)
          : typeof err.status === "string" && err.status.trim()
            ? err.status.trim()
            : null;
    return code
      ? `Gemini error (${code}): ${message}`
      : `Gemini error: ${message}`;
  }

  const promptFeedback = record.promptFeedback;
  if (promptFeedback && typeof promptFeedback === "object") {
    const feedback = promptFeedback as Record<string, unknown>;
    const blockReason =
      typeof feedback.blockReason === "string" ? feedback.blockReason : null;
    if (blockReason) {
      const detail =
        typeof feedback.blockReasonMessage === "string" &&
        feedback.blockReasonMessage.trim()
          ? feedback.blockReasonMessage.trim()
          : "The Gemini response was blocked.";
      return `Gemini error (${blockReason}): ${detail}`;
    }
  }

  const candidates = Array.isArray(record.candidates)
    ? (record.candidates as Record<string, unknown>[])
    : [];
  const finishReason =
    typeof candidates[0]?.finishReason === "string"
      ? candidates[0].finishReason
      : null;
  const errorFinishReasons = new Set([
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "MALFORMED_FUNCTION_CALL",
    "OTHER",
  ]);
  if (finishReason && errorFinishReasons.has(finishReason)) {
    return `Gemini error (${finishReason}): The Gemini stream ended with an error finish reason.`;
  }

  return null;
}

export async function streamGemini(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
    apiKeys,
    enableThinking,
  } = params;
  const maxIter = params.maxIterations;
  const ai = client(apiKeys?.gemini);
  const contents: GeminiContent[] = toNativeContents(params.messages);
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let requiredToolCall: string[] = [];
  const trace = createLlmTrace({ provider: "gemini", model });

  try {
    for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      const functionDeclarations = toGeminiTools(
        params.resolveTools?.() ?? tools,
      );
      const declaredToolNames = new Set(
        functionDeclarations.map(({ name }) => name),
      );
      const forcedNames = requiredToolCall;
      requiredToolCall = [];
      trace.record({
        iteration: iter,
        label: "request",
        payload: {
          tools: functionDeclarations.map(({ name }) => name),
          forcedTools: forcedNames,
        },
      });
      let stream: AsyncIterable<unknown>;
      try {
        stream = await ai.models.generateContentStream({
          model,
          contents: contents as never,
          config: {
            systemInstruction: systemPrompt,
            tools: functionDeclarations.length
              ? [{ functionDeclarations } as never]
              : undefined,
            toolConfig: forcedNames.length
              ? {
                  functionCallingConfig: {
                    mode: FunctionCallingConfigMode.ANY,
                    allowedFunctionNames: forcedNames,
                  },
                }
              : undefined,
            // When enabled, ask Gemini to surface thought summaries.
            // When disabled, explicitly zero the thinking budget so the
            // model skips thinking entirely (saves tokens and latency
            // for bulk extraction jobs).
            thinkingConfig: enableThinking
              ? { includeThoughts: true }
              : { thinkingBudget: 0 },
          },
        });
      } catch (error) {
        throw new Error(geminiErrorMessage(error));
      }

      // Per-iteration accumulators.
      const textParts: string[] = [];
      const callParts: GeminiPart[] = [];
      const toolCalls: NormalizedToolCall[] = [];
      let sawThinking = false;
      let roundUsage: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      } | undefined;
      const iterator = stream[Symbol.asyncIterator]();
      let rejectAbort: ((reason?: unknown) => void) | null = null;
      const abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => rejectAbort?.(abortError());
      params.abortSignal?.addEventListener("abort", onAbort, {
        once: true,
      });

      try {
        while (true) {
          throwIfAborted(params.abortSignal);
          const { value: chunk, done } = await Promise.race([
            iterator.next(),
            abortPromise,
          ]);
          if (done) break;
          trace.record({ iteration: iter, label: "chunk", payload: chunk });
          const failureMessage = geminiStreamFailureMessage(chunk);
          if (failureMessage) throw new Error(failureMessage);
          roundUsage = (chunk as { usageMetadata?: typeof roundUsage })
            .usageMetadata ?? roundUsage;

          const parts =
            (chunk as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
              .candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (part.text) {
              if (part.thought) {
                sawThinking = true;
                callbacks.onReasoningDelta?.(part.text);
              } else {
                textParts.push(part.text);
                callbacks.onContentDelta?.(part.text);
              }
            }
            if (part.functionCall) {
              // Preserve the whole part (including thoughtSignature)
              // so it can be echoed verbatim in the replay turn.
              callParts.push(part);
              const call: NormalizedToolCall = {
                id:
                  part.functionCall.id ??
                  `${part.functionCall.name}-${toolCalls.length}`,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
              };
              callbacks.onToolCallStart?.(call);
              toolCalls.push(call);
            }
          }
        }
      } catch (error) {
        if (params.abortSignal?.aborted) throw abortError();
        throw new Error(geminiErrorMessage(error));
      } finally {
        params.abortSignal?.removeEventListener("abort", onAbort);
        if (params.abortSignal?.aborted) {
          await iterator.return?.();
        }
      }

      if (sawThinking) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);
      inputTokens += roundUsage?.promptTokenCount ?? 0;
      outputTokens += roundUsage?.candidatesTokenCount ?? 0;
      reasoningTokens += roundUsage?.thoughtsTokenCount ?? 0;
      const contextWindowTokens = modelContextWindow(model);
      if (contextWindowTokens && roundUsage?.promptTokenCount !== undefined) {
        callbacks.onContextUsage?.({
          usedTokens: roundUsage.promptTokenCount,
          contextWindowTokens,
        });
      }

      fullText += textParts.join("");

      const results = toolCalls.length && runTools
        ? await runTools(toolCalls)
        : [];
      requiredToolCall = params.resolveTools
        ? toGeminiTools(params.resolveTools())
            .map(({ name }) => name)
            .filter((name) => !declaredToolNames.has(name))
        : [];
      throwIfAborted(params.abortSignal);
      if (results.some((result) => result.terminal)) break;
      const steering = params.takeSteering?.() ?? [];
      if (!results.length && !steering.length) break;

      // Append the completed model step, then deliver tool results and queued
      // steering together at the provider's next safe user boundary.
      const modelParts: GeminiPart[] = [];
      if (textParts.length) modelParts.push({ text: textParts.join("") });
      for (const cp of callParts) modelParts.push(cp);
      contents.push({ role: "model", parts: modelParts });

      contents.push({
        role: "user",
        parts: [
          ...results.map((r) => {
            const match = toolCalls.find((c) => c.id === r.tool_use_id);
            return {
              functionResponse: {
                ...(r.tool_use_id && !r.tool_use_id.startsWith(match?.name ?? "")
                  ? { id: r.tool_use_id }
                  : {}),
                name: match?.name ?? "tool",
                response: { output: r.content },
              },
            };
          }),
          ...steering.map(({ text }) => ({ text })),
        ],
      });
    }

    await trace.flush("completed");
    return {
      fullText,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
      },
    };
  } catch (error) {
    await trace.flush("error", error);
    throw error;
  }
}

export async function completeGeminiText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  apiKeys?: { gemini?: string | null };
}): Promise<string> {
  const ai = client(params.apiKeys?.gemini);
  let resp: Awaited<ReturnType<typeof ai.models.generateContent>>;
  try {
    resp = await ai.models.generateContent({
      model: params.model,
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      config: params.systemPrompt
        ? { systemInstruction: params.systemPrompt }
        : undefined,
    });
  } catch (error) {
    throw new Error(geminiErrorMessage(error));
  }
  return resp.text ?? "";
}
