import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  StreamChatParams,
  StreamChatResult,
  NormalizedToolCall,
} from "./types";
import { toClaudeTools } from "./tools";
import { abortError, throwIfAborted } from "./abort";
import { requireApiKey } from "./apiKeys";
import { createLlmTrace } from "./rawStreamLog";
import { hasNativeCompaction, modelContextWindow } from "./contextWindow";

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

type NativeMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

const MAX_TOKENS = 16384;

function client(override?: string | null): Anthropic {
  return new Anthropic({
    apiKey: requireApiKey(override, ["ANTHROPIC_API_KEY"], "Anthropic"),
  });
}

export function toNativeMessages(
  messages: StreamChatParams["messages"],
  nativeCompaction = true,
): NativeMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      nativeCompaction && message.contextCheckpoint?.provider === "claude"
        ? [{
            type: "compaction",
            content: message.contextCheckpoint.content,
          }]
        : message.role === "user" && message.images?.length
        ? [
            { type: "text", text: message.content },
            ...message.images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mimeType,
                data: image.data,
              },
            })),
          ]
        : message.content,
  }));
}

function claudeErrorMessage(error: unknown): string {
  const parsedObject = claudeStreamFailureMessage(error);
  if (parsedObject) return parsedObject;
  if (error instanceof Error && error.message) {
    const parsed = parseClaudeErrorPayload(error.message);
    if (parsed) return parsed;
    return error.message.startsWith("Claude error:")
      ? error.message
      : `Claude error: ${error.message}`;
  }
  const parsed = parseClaudeErrorPayload(String(error));
  if (parsed) return parsed;
  return `Claude error: ${String(error)}`;
}

function parseClaudeErrorPayload(value: string): string | null {
  const trimmed = value.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return null;
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonEnd <= jsonStart) return null;
  const payload = trimmed.slice(jsonStart, jsonEnd + 1);
  try {
    const parsed = JSON.parse(payload) as unknown;
    return claudeStreamFailureMessage(parsed);
  } catch {
    return null;
  }
}

function claudeStreamFailureMessage(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  const error = record.error;
  if (record.type !== "error" || !error || typeof error !== "object") {
    return null;
  }
  const err = error as Record<string, unknown>;
  const type =
    typeof err.type === "string" && err.type.trim() ? err.type.trim() : null;
  const message =
    typeof err.message === "string" && err.message.trim()
      ? err.message.trim()
      : "Claude stream failed.";
  return type
    ? `Claude error (${type}): ${message}`
    : `Claude error: ${message}`;
}

export async function streamClaude(
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
  const anthropic = client(apiKeys?.claude);
  const messages: NativeMessage[] = toNativeMessages(
    params.messages,
    hasNativeCompaction(model),
  );
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const trace = createLlmTrace({ provider: "claude", model });

  try {
    for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      const claudeTools = toClaudeTools(params.resolveTools?.() ?? tools);
      const body = {
        model,
        system: systemPrompt,
        messages: messages as Anthropic.MessageParam[],
        tools: claudeTools.length
          ? (claudeTools as unknown as Tool[])
          : undefined,
        max_tokens: params.maxTokens ?? MAX_TOKENS,
        // Claude 4.x models require `thinking.type: "adaptive"` and
        // drive effort via `output_config.effort` rather than a fixed
        // token budget. We only opt in when the caller requested it.
        ...(enableThinking
          ? ({
              thinking: { type: "adaptive" },
              output_config: { effort: "high" },
            } as unknown as Record<string, unknown>)
          : {}),
        // Extended thinking requires temperature to be default (omitted).
      };
      const stream = (params.compactThreshold && hasNativeCompaction(model)
        ? anthropic.beta.messages.stream({
            ...body,
            betas: ["compact-2026-01-12"],
            context_management: {
              edits: [{
                type: "compact_20260112",
                instructions:
                  "Summarize the transcript for continuing the task. Preserve user constraints, decisions, exact identifiers, unfinished work, and next steps. Do not call tools; return text only.",
                trigger: {
                  type: "input_tokens",
                  value: Math.max(50_000, params.compactThreshold),
                },
              }],
            },
          } as never)
        : anthropic.messages.stream(body as never)) as unknown as ReturnType<
          typeof anthropic.messages.stream
        >;

      let sawThinking = false;
      let streamFailureMessage: string | null = null;
      const compacting = new Set<number>();
      const abortStream = () => stream.abort();
      params.abortSignal?.addEventListener("abort", abortStream, {
        once: true,
      });

      stream.on("streamEvent", (event: unknown) => {
        trace.record({ iteration: iter, label: "streamEvent", payload: event });
        const item = event as unknown as {
          type?: string;
          index?: number;
          content_block?: { type?: string };
          delta?: { type?: string; content?: string | null };
        };
        if (
          item.type === "content_block_start" &&
          item.content_block?.type === "compaction" &&
          typeof item.index === "number"
        ) {
          compacting.add(item.index);
          callbacks.onCompaction?.("running");
        } else if (
          item.type === "content_block_delta" &&
          item.delta?.type === "compaction_delta" &&
          typeof item.index === "number" &&
          compacting.has(item.index)
        ) {
          if (item.delta.content) {
            callbacks.onContextCheckpoint?.({
              provider: "claude",
              content: item.delta.content,
            });
          }
          callbacks.onCompaction?.("completed");
        }
        const failureMessage = claudeStreamFailureMessage(event);
        if (failureMessage) {
          streamFailureMessage = failureMessage;
          stream.abort();
        }
      });
      stream.on("error", (error: unknown) => {
        trace.record({ iteration: iter, label: "error", payload: error });
      });

      stream.on("text", (delta: string) => {
        callbacks.onContentDelta?.(delta);
      });
      if (enableThinking) {
        stream.on("thinking", (delta: string) => {
          sawThinking = true;
          callbacks.onReasoningDelta?.(delta);
        });
      }

      let final: Awaited<ReturnType<typeof stream.finalMessage>>;
      try {
        final = await stream.finalMessage();
      } catch (error) {
        if (params.abortSignal?.aborted) throw abortError();
        if (streamFailureMessage) throw new Error(streamFailureMessage);
        throw new Error(claudeErrorMessage(error));
      } finally {
        params.abortSignal?.removeEventListener("abort", abortStream);
      }
      if (sawThinking) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);
      const stopReason = final.stop_reason;
      const assistantBlocks = final.content as ContentBlock[];
      const reported = final.usage ?? {};
      inputTokens += reported.input_tokens ?? 0;
      outputTokens += reported.output_tokens ?? 0;
      cacheReadTokens += reported.cache_read_input_tokens ?? 0;
      cacheWriteTokens += reported.cache_creation_input_tokens ?? 0;
      const contextWindowTokens = modelContextWindow(model);
      if (contextWindowTokens) {
        callbacks.onContextUsage?.({
          usedTokens: reported.input_tokens ?? 0,
          contextWindowTokens,
        });
      }

      // Extract text content and tool_use calls from the final assistant
      // message so we can accumulate text and drive the tool-call loop.
      const toolCalls: NormalizedToolCall[] = [];
      for (const block of assistantBlocks) {
        if (block.type === "text") {
          const txt = (block as { text: string }).text;
          if (typeof txt === "string") fullText += txt;
        } else if (block.type === "tool_use") {
          const tu = block as {
            id: string;
            name: string;
            input: unknown;
          };
          const call: NormalizedToolCall = {
            id: tu.id,
            name: tu.name,
            input: (tu.input as Record<string, unknown>) ?? {},
          };
          callbacks.onToolCallStart?.(call);
          toolCalls.push(call);
        }
      }

      const results =
        stopReason === "tool_use" && toolCalls.length && runTools
          ? await runTools(toolCalls)
          : [];
      throwIfAborted(params.abortSignal);
      if (results.some((result) => result.terminal)) break;
      const steering = params.takeSteering?.() ?? [];
      if (!results.length && !steering.length) break;

      // Claude combines consecutive user blocks, so steering can share the
      // tool-result turn without inventing another protocol layer.
      messages.push({ role: "assistant", content: assistantBlocks });
      messages.push({
        role: "user",
        content: [
          ...results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.tool_use_id,
            content: r.content,
          })),
          ...steering.map(({ text }) => ({ type: "text", text })),
        ],
      });
    }

    await trace.flush("completed");
    return {
      fullText,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: null,
        cacheReadInputTokens: cacheReadTokens,
        cacheWriteInputTokens: cacheWriteTokens,
      },
    };
  } catch (error) {
    await trace.flush("error", error);
    throw error;
  }
}
