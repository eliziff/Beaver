// Shared provider-neutral LLM types. Tool contracts use MCP's standard shape;
// provider adapters only translate at their wire boundary.

export type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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

export type ProviderContextCheckpoint =
  | { provider: "claude"; content: string; block: Record<string, unknown> }
  | { provider: "openai"; item: Record<string, unknown> };

export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
  images?: LlmImage[];
  /** Provider-native continuation block retained alongside the plain summary. */
  contextCheckpoint?: ProviderContextCheckpoint;
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
    locatorKind?: "paragraph" | "page" | "section" | "footnote";
    /** Immutable virtual source view used to expose this exact span. */
    virtualPath?: string;
    projection?: string;
    /** Search previews orient; reads and exact passages support a draft. */
    kind?: "candidate" | "evidence";
  }>;
  /** Exact provider/PDF passages that cannot be rehydrated from a local file. */
  evidenceRefs?: Array<{
    handle: string;
    text: string;
    filename?: string;
    locator?: string;
    exactSha256?: string;
    kind?: "candidate" | "evidence";
  }>;
  /** Host-only deterministic navigation hints offered alongside search hits. */
  retrievalHints?: Array<{
    kind: "literal_reference";
    label: string;
    path: string;
    offset: number;
    limit: number;
  }>;
  /** Host-only exact-evidence accounting; never duplicated into provider context. */
  exposure?: {
    uniqueSourceChars: number;
    suppressedSourceChars: number;
  };
  /** End the provider loop after this result; the caller owns final rendering. */
  terminal?: boolean;
};

export type ProviderSubagentUpdate = {
  id: string;
  task: string;
  model: string;
  effort: string;
  status: "running" | "completed" | "error" | "interrupted";
  output?: string;
  error?: string;
  activities?: Array<{
    id: string;
    label: string;
    status: "running" | "completed" | "error" | "interrupted";
  }>;
};

export type StreamCallbacks = {
  onReasoningDelta?: (text: string) => void;
  onReasoningBlockEnd?: () => void;
  onContentDelta?: (text: string) => void;
  onContentBlockEnd?: () => void;
  onToolCallStart?: (call: NormalizedToolCall) => void;
  onContextUsage?: (usage: {
    usedTokens: number;
    contextWindowTokens: number;
  }) => void;
  onCompaction?: (status: "running" | "completed" | "failed") => void;
  onContextCheckpoint?: (checkpoint: ProviderContextCheckpoint) => void;
  onSteer?: (message: { id: string; text: string }) => void;
  onSubagentUpdate?: (update: ProviderSubagentUpdate) => void;
};

export type ProviderTurnControl = {
  steer: (message: { id: string; text: string }) => Promise<void>;
};

export type SteeringMessage = Parameters<ProviderTurnControl["steer"]>[0];

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

export type SubagentMode = "none" | "beaver" | "native";

export type StreamChatParams = {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  /** Optional output cap used by one-shot callers. */
  maxTokens?: number;
  /** Provider-enforced JSON Schema for callers that need structured output. */
  outputSchema?: Record<string, unknown>;
  tools?: Tool[];
  /** Full catalog for provider transports that snapshot MCP tools once. */
  staticTools?: Tool[];
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
  resolveTools?: () => Tool[];
  /** Optional provider-call cap. Interactive loops otherwise stop after 32 rounds. */
  maxIterations?: number;
  callbacks?: StreamCallbacks;
  runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
  /** Drain user steering at the next completed provider step. */
  takeSteering?: () => SteeringMessage[];
  apiKeys?: UserApiKeys;
  /**
   * Enable provider-side reasoning/thinking. Off by default — should only
   * be turned on for interactive chat surfaces where the user actually
   * benefits from seeing the thought stream. Bulk extraction jobs and
   * one-shot completions should leave this off to save tokens and latency.
   */
  enableThinking?: boolean;
  /** Whether provider-generated reasoning summaries should be surfaced. */
  reasoningSummary?: "auto" | "none";
  /** Provider reasoning effort when the selected model supports it. */
  reasoningEffort?: string;
  /** Allow Codex app-server to expose its provider-native multi-agent tools. */
  nativeSubagents?: boolean;
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
    onContinuationId?: (continuationId: string) => void;
    onControl?: (control: ProviderTurnControl | null) => void;
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
  instructionsBytes: number;
  inputItems: number;
  inputBytes: number;
  toolCount: number;
  toolBytes: number;
  toolCallCount: number;
  toolArgumentBytes: number;
  toolResultBytes: number;
  usage: NormalizedLlmUsage;
};

export type StreamChatResult = {
  fullText: string;
  /** Provider-reported usage when an adapter can supply it. */
  usage?: NormalizedLlmUsage;
  /** Provider-reported service tier actually used for the response. */
  serviceTier?: string;
  /** Opaque provider continuation identifier, when one survives this call. */
  continuationId?: string;
  /** Content-free per-request receipts for diagnosing tool-loop context cost. */
  contextRounds?: LlmContextRoundReceipt[];
};
