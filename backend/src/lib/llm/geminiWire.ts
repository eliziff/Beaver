import type { FunctionCallingConfigMode } from "@google/genai";
import type { ProviderAdapter, ProviderEvent, ProviderStep } from "./providerLoop";
import type { LlmMessage, NormalizedLlmUsage, StreamChatParams, Tool } from "./types";

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };
type Call = { name: string; providerId?: string };
type State = { contents: Content[]; calls: Record<string, Call> };
const gemini = import("@google/genai").then((sdk) => sdk.GoogleGenAI);

function declarations(tools: Tool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parametersJsonSchema: tool.inputSchema,
  }));
}

function contents(messages: LlmMessage[]): Content[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      { text: message.content },
      ...(message.role === "user" ? (message.images ?? []).map((image) => ({
        inlineData: { mimeType: image.mimeType, data: image.data },
      })) : []),
    ],
  }));
}

function failure(chunk: Record<string, unknown>): string | null {
  const error = chunk.error as Record<string, unknown> | undefined;
  if (error) {
    const message = typeof error.message === "string" && error.message.trim()
      ? error.message.trim() : "Gemini stream failed.";
    const code = typeof error.code === "string" || typeof error.code === "number"
      ? String(error.code) : typeof error.status === "string" ? error.status : "";
    return code ? `Gemini error (${code}): ${message}` : `Gemini error: ${message}`;
  }
  const feedback = chunk.promptFeedback as Record<string, unknown> | undefined;
  if (typeof feedback?.blockReason === "string") {
    return `Gemini error (${feedback.blockReason}): ${
      typeof feedback.blockReasonMessage === "string"
        ? feedback.blockReasonMessage : "The Gemini response was blocked."
    }`;
  }
  const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] as Record<string, unknown> : undefined;
  const reason = candidate?.finishReason;
  return typeof reason === "string" && [
    "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "OTHER",
  ].includes(reason) ? `Gemini error (${reason}): The Gemini stream ended with an error finish reason.` : null;
}

function providerError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("Gemini error")) return error;
  return new Error(`Gemini error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export function createGeminiWireAdapter(
  params: StreamChatParams,
  apiKey: string,
): ProviderAdapter {
  const client = gemini.then((GoogleGenAI) => new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: { baseUrl: "https://generativelanguage.googleapis.com" },
  }));
  const initial = contents(params.messages);
  return {
    provider: "gemini",
    async *events(step: ProviderStep): AsyncIterable<ProviderEvent> {
      const state = step.iteration ? step.checkpoint as State | undefined : { contents: initial, calls: {} };
      if (!state) throw new Error("Gemini did not return continuation state");
      const requestContents = [...state.contents];
      if (step.results.length || step.steering.length) {
        const responses = step.results.map((result) => {
          const call = state.calls[result.tool_use_id];
          if (!call) throw new Error(`Gemini lost function call ${result.tool_use_id}`);
          return {
            functionResponse: {
              ...(call.providerId ? { id: call.providerId } : {}),
              name: call.name,
              response: { output: result.content },
            },
          };
        });
        requestContents.push({
          role: "user",
          parts: [
            ...responses,
            ...step.results.flatMap((result) => result.images ?? []).map((image) => ({
              inlineData: { mimeType: image.mimeType, data: image.data },
            })),
            ...step.steering.map(({ text }) => ({ text })),
          ],
        });
      }
      let stream: AsyncIterable<unknown>;
      try {
        stream = await (await client).models.generateContentStream({
          model: params.model,
          contents: requestContents,
          config: {
            systemInstruction: params.systemPrompt,
            abortSignal: step.signal,
            maxOutputTokens: params.maxTokens,
            tools: step.tools.length ? [{ functionDeclarations: declarations(step.tools) }] : undefined,
            toolConfig: step.newToolNames.length ? {
              functionCallingConfig: { mode: "ANY" as FunctionCallingConfigMode, allowedFunctionNames: step.newToolNames },
            } : undefined,
            thinkingConfig: params.enableThinking ? { includeThoughts: true } : { thinkingBudget: 0 },
          },
        });
      } catch (error) {
        throw providerError(error);
      }

      const modelParts: Part[] = [];
      const calls: Record<string, Call> = {};
      let callNumber = 0;
      let reported: Record<string, unknown> | undefined;
      try {
        for await (const raw of stream) {
          const chunk = raw as Record<string, unknown>;
          const message = failure(chunk);
          if (message) throw new Error(message);
          if (chunk.usageMetadata && typeof chunk.usageMetadata === "object") {
            reported = chunk.usageMetadata as Record<string, unknown>;
          }
          const candidate = Array.isArray(chunk.candidates)
            ? chunk.candidates[0] as Record<string, unknown> : undefined;
          const content = candidate?.content as Record<string, unknown> | undefined;
          const parts = Array.isArray(content?.parts) ? content.parts as Part[] : [];
          for (const rawPart of parts) {
            const part = { ...rawPart };
            modelParts.push(part);
            if (typeof part.text === "string" && part.text) {
              yield part.thought
                ? { type: "reasoning_delta", text: part.text }
                : { type: "text_delta", text: part.text };
            }
            const fn = part.functionCall as Record<string, unknown> | undefined;
            if (fn && typeof fn.name === "string") {
              const providerId = typeof fn.id === "string" ? fn.id : undefined;
              const id = providerId ?? `${fn.name}-${callNumber++}`;
              calls[id] = { name: fn.name, providerId };
              yield {
                type: "tool_call",
                call: {
                  id,
                  name: fn.name,
                  input: fn.args && typeof fn.args === "object" && !Array.isArray(fn.args)
                    ? fn.args as Record<string, unknown> : {},
                },
              };
            }
          }
        }
      } catch (error) {
        throw providerError(error);
      }

      if (reported) {
        const normalized: NormalizedLlmUsage = {
          inputTokens: typeof reported.promptTokenCount === "number" ? reported.promptTokenCount : null,
          outputTokens: typeof reported.candidatesTokenCount === "number" ? reported.candidatesTokenCount : null,
          reasoningTokens: typeof reported.thoughtsTokenCount === "number" ? reported.thoughtsTokenCount : null,
          cacheReadInputTokens: typeof reported.cachedContentTokenCount === "number"
            ? reported.cachedContentTokenCount : null,
          cacheWriteInputTokens: null,
        };
        yield {
          type: "usage",
          usage: normalized,
          usedTokens: normalized.inputTokens ?? undefined,
        };
      }
      yield {
        type: "opaque_checkpoint",
        checkpoint: {
          contents: [...requestContents, { role: "model", parts: modelParts }],
          calls,
        } satisfies State,
      };
      yield { type: "done" };
    },
  };
}
