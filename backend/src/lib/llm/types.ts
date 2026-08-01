// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider =
  | "claude"
  | "claude-p"
  | "gemini"
  | "openai"
  | "deepseek"
  | "openrouter"
  | "codex"
  | "ollama";

export type OpenAIToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Ask providers that support it to constrain arguments to the schema. */
    strict?: boolean;
  };
};

export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
  images?: LlmImage[];
};

export type LlmImage = {
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Raw base64 bytes, without a data-URL prefix. */
  data: string;
};

export type NormalizedToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type NormalizedToolResult = {
  tool_use_id: string;
  content: string;
  /** End the provider loop after this result; the caller owns final rendering. */
  terminal?: boolean;
};

export type StreamCallbacks = {
  onReasoningDelta?: (text: string) => void;
  onReasoningBlockEnd?: () => void;
  onContentDelta?: (text: string) => void;
  onContentBlockEnd?: () => void;
  onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
  claude?: string | null;
  gemini?: string | null;
  openai?: string | null;
  deepseek?: string | null;
  openrouter?: string | null;
  courtlistener?: string | null;
  codex?: string | null;
};

export type StreamChatParams = {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools?: OpenAIToolSchema[];
  /**
   * Re-read the tool list before every iteration of the tool loop, so a
   * caller can REVEAL tools mid-conversation — progressive disclosure, where
   * a discovery call opens a domain and its tools become callable on the
   * next turn.
   *
   * Without this the list is snapshotted once and a revealed tool can never
   * be called, which forces a caller to duplicate the provider loop. Purely
   * additive: when absent, `tools` behaves exactly as before.
   */
  resolveTools?: () => OpenAIToolSchema[];
  maxIterations?: number;
  callbacks?: StreamCallbacks;
  runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
  apiKeys?: UserApiKeys;
  /**
   * Enable provider-side reasoning/thinking. Off by default — should only
   * be turned on for interactive chat surfaces where the user actually
   * benefits from seeing the thought stream. Bulk extraction jobs and
   * one-shot completions should leave this off to save tokens and latency.
   */
  enableThinking?: boolean;
  /** Provider reasoning effort when the selected model supports it. */
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
  /**
   * Opt in to a provider-owned durable session. Callers remain responsible for
   * binding an opaque continuation ID to the correct user, chat, model, and
   * canonical transcript version before supplying it again.
   */
  providerSession?: {
    persist: true;
    continuationId?: string;
  };
};

export type NormalizedLlmUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
};

export type StreamChatResult = {
  fullText: string;
  /** Provider-reported usage when an adapter can supply it. */
  usage?: NormalizedLlmUsage;
  /** Opaque provider request/thread ID for diagnostics, not automatic reuse. */
  providerInvocationId?: string;
  /** Opaque provider continuation identifier, when one survives this call. */
  continuationId?: string;
};
