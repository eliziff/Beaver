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
  | "meta"
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
  /** Host-visible result state; adapters still send only `content`. */
  status?:
    | "ok"
    | "not_found"
    | "ambiguous"
    | "selection_required"
    | "truncated"
    | "past_end"
    | "already_exposed"
    | "error";
  /** Host-only durable mutation receipt; provider adapters send `content`. */
  mutationReceipt?: string;
  /** Host-only source ranges exposed by text-shaped navigation tools. */
  evidenceSpans?: Array<[number, number]>;
  /** Host-only original-source ranges for virtual multi-document projections. */
  evidenceSegments?: Array<{
    documentId: string;
    versionId: string;
    start: number;
    end: number;
    filename?: string;
    locator?: string;
    /** Immutable virtual source view used to expose this exact span. */
    virtualPath?: string;
    projection?: string;
    /** Search previews orient; reads and exact passages support a draft. */
    kind?: "candidate" | "evidence";
    /** This exact span is projected from the already-durable mounted union. */
    durableUnionBacked?: boolean;
  }>;
  /** Exact provider/PDF passages that cannot be rehydrated from a local file. */
  evidenceRefs?: Array<{
    handle: string;
    text: string;
    filename?: string;
    locator?: string;
    exactSha256?: string;
    kind?: "candidate" | "evidence";
    /** This exact span is projected from the already-durable mounted union. */
    durableUnionBacked?: boolean;
  }>;
  /** Host-only deterministic navigation hints offered alongside search hits. */
  retrievalHints?: Array<{
    kind: "literal_reference";
    label: string;
    path: string;
    offset: number;
    limit: number;
  }>;
  /** Host-only union accounting; never duplicated into provider context. */
  exposure?: {
    uniqueSourceChars: number;
    suppressedSourceChars: number;
  };
  /** Host-only durable-union delta, separate from the current context guard. */
  unionExposure?: {
    uniqueSourceChars: number;
    suppressedSourceChars: number;
  };
  /** Gross exact source bytes reread from the already-reviewed mounted union. */
  reviewedUnionBackedSourceChars?: number;
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
  meta?: string | null;
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
  /** Optional explicit provider-call cap. Omit for a natural-stop agent loop. */
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
  /** Host-selected service tier; adapters must gate it on model capability. */
  serviceTier?: string;
  /** Responses compaction threshold. Unsupported adapters ignore it. */
  compactThreshold?: number;
  /**
   * Stable, privacy-preserving Responses prompt-cache routing key. The chat
   * surface binds this to the durable chat; adapters generate an invocation-
   * scoped fallback for one-shot callers.
   */
  promptCacheKey?: string;
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

/** Content-free accounting for one provider request in a tool loop. */
export type LlmContextRoundReceipt = {
  iteration: number;
  requestAttempts: number;
  continuation: "none" | "provider";
  instructionsBytes: number;
  instructionsSha256: string;
  inputItems: number;
  inputBytes: number;
  inputSha256: string;
  /** Explicit provider-cache boundaries present in this request. */
  cacheBreakpointCount?: number;
  /** Byte length and hash of the longest explicitly cacheable input prefix. */
  cachePrefixBytes?: number;
  cachePrefixSha256?: string;
  toolCount: number;
  toolBytes: number;
  toolSha256: string;
  toolCallCount: number;
  toolArgumentBytes: number;
  toolResultBytes: number;
  usage: NormalizedLlmUsage;
};

/** Content-free receipt for one provider compaction request. */
export type LlmCompactionReceipt = {
  iteration: number;
  thresholdTokens: number;
  triggerInputTokens: number;
  triggerReason?:
    | "reported_usage"
    | "projected_input"
    | "context_length_exceeded";
  projectedInputTokens?: number;
  requestInputItems: number;
  requestInputBytes: number;
  requestInputSha256: string;
  requestInstructionsBytes: number;
  requestInstructionsSha256: string;
  requestToolCount: number;
  requestToolBytes: number;
  requestToolSha256: string;
  outputItems: number;
  outputBytes: number;
  outputSha256: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  latencyMs: number;
  usage: NormalizedLlmUsage;
};

export type StreamChatResult = {
  fullText: string;
  /** Provider-reported usage when an adapter can supply it. */
  usage?: NormalizedLlmUsage;
  /** Provider-reported service tier actually used for the response. */
  serviceTier?: string;
  /** Opaque provider request/thread ID for diagnostics, not automatic reuse. */
  providerInvocationId?: string;
  /** Opaque provider continuation identifier, when one survives this call. */
  continuationId?: string;
  /** Content-free per-request receipts for diagnosing tool-loop context cost. */
  contextRounds?: LlmContextRoundReceipt[];
  /** Content-free receipts for actual provider compactions. */
  compactions?: LlmCompactionReceipt[];
  /** Hash only; the provider cache-routing key is never persisted. */
  promptCacheKeySha256?: string;
};
