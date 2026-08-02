import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { legalDataHome } from "../legalDataPath";
import type {
  LlmCompactionReceipt,
  LlmContextRoundReceipt,
  NormalizedLlmUsage,
  Provider,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { sha256 } from "../hash";

type ComponentMeasurement = {
  count: number;
  bytes: number;
  sha256: string;
};

export type LlmContextManifest = {
  schemaVersion: 2;
  startedAt: string;
  provider: Provider;
  model: string;
  reasoningEffort: string | null;
  serviceTierRequested: string | null;
  serviceTierReported: string | null;
  components: {
    system: ComponentMeasurement;
    messages: ComponentMeasurement;
    tools: ComponentMeasurement;
    images: ComponentMeasurement;
  };
  inputEstimate: {
    scope: "provider-neutral-adapter-input";
    bytes: number;
    tokens: number;
    method: "utf8-text+canonical-tool-json+decoded-image-bytes;tokens=ceil(bytes/4)";
  };
  firstContentLatencyMs: number | null;
  totalLatencyMs: number;
  outputBytes: number;
  status: "completed" | "error" | "aborted";
  usage: NormalizedLlmUsage;
  providerInvocationId: string | null;
  rounds: LlmContextRoundReceipt[];
  compactions: LlmCompactionReceipt[];
  promptCache:
    | { strategy: "none"; keySha256: null }
    | { strategy: "session"; keySha256: string };
  compaction:
    | { strategy: "none"; reason: null; checkpointId: null }
    | {
        strategy: "provider";
        reason: "threshold_configured";
        threshold: number;
        checkpointId: null;
      };
  continuation:
    | { strategy: "none"; id: null }
    | { strategy: "provider"; id: string };
};

type BuildManifestParams = {
  params: StreamChatParams;
  provider: Provider;
  startedAt: string;
  firstContentLatencyMs: number | null;
  totalLatencyMs: number;
  outputBytes: number;
  status: LlmContextManifest["status"];
  result?: StreamChatResult;
};

const EMPTY_USAGE: NormalizedLlmUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cacheReadInputTokens: null,
  cacheWriteInputTokens: null,
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function buildContextManifest(
  args: BuildManifestParams,
): LlmContextManifest {
  const systemBytes = Buffer.byteLength(args.params.systemPrompt);
  const messageBytes = args.params.messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content),
    0,
  );
  const imageDescriptors = args.params.messages.flatMap((message) =>
    (message.images ?? []).map((image) => ({
      filename: sha256(image.filename),
      mimeType: image.mimeType,
      data: sha256(image.data),
      bytes: Buffer.byteLength(image.data, "base64"),
    })),
  );
  const imageBytes = imageDescriptors.reduce(
    (total, image) => total + image.bytes,
    0,
  );
  const messageFingerprint = args.params.messages.map((message) => ({
    role: message.role,
    content: sha256(message.content),
    imageCount: message.images?.length ?? 0,
  }));
  const toolJson = args.params.tools?.length
    ? canonicalJson(args.params.tools)
    : "";
  const toolBytes = Buffer.byteLength(toolJson);
  const inputBytes = systemBytes + messageBytes + toolBytes + imageBytes;

  return {
    schemaVersion: 2,
    startedAt: args.startedAt,
    provider: args.provider,
    model: args.params.model,
    reasoningEffort: args.params.reasoningEffort?.trim() || null,
    serviceTierRequested: args.params.serviceTier?.trim() || null,
    serviceTierReported: args.result?.serviceTier?.trim() || null,
    components: {
      system: {
        count: 1,
        bytes: systemBytes,
        sha256: sha256(args.params.systemPrompt),
      },
      messages: {
        count: args.params.messages.length,
        bytes: messageBytes,
        sha256: sha256(canonicalJson(messageFingerprint)),
      },
      tools: {
        count: args.params.tools?.length ?? 0,
        bytes: toolBytes,
        sha256: sha256(toolJson),
      },
      images: {
        count: imageDescriptors.length,
        bytes: imageBytes,
        sha256: sha256(canonicalJson(imageDescriptors)),
      },
    },
    inputEstimate: {
      scope: "provider-neutral-adapter-input",
      bytes: inputBytes,
      tokens: Math.ceil(inputBytes / 4),
      method:
        "utf8-text+canonical-tool-json+decoded-image-bytes;tokens=ceil(bytes/4)",
    },
    firstContentLatencyMs: args.firstContentLatencyMs,
    totalLatencyMs: args.totalLatencyMs,
    outputBytes: args.outputBytes,
    status: args.status,
    usage: args.result?.usage ?? { ...EMPTY_USAGE },
    providerInvocationId: args.result?.providerInvocationId ?? null,
    rounds: args.result?.contextRounds ?? [],
    compactions: args.result?.compactions ?? [],
    promptCache: args.result?.promptCacheKeySha256
      ? {
          strategy: "session",
          keySha256: args.result.promptCacheKeySha256,
        }
      : { strategy: "none", keySha256: null },
    compaction: args.params.compactThreshold
      ? {
          strategy: "provider",
          reason: "threshold_configured",
          threshold: args.params.compactThreshold,
          checkpointId: null,
        }
      : { strategy: "none", reason: null, checkpointId: null },
    continuation: args.result?.continuationId
      ? { strategy: "provider", id: args.result.continuationId }
      : { strategy: "none", id: null },
  };
}

let appendQueue = Promise.resolve();

export async function appendContextManifest(
  manifest: LlmContextManifest,
): Promise<void> {
  const configured = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH?.trim();
  if (!configured && process.env.NODE_ENV === "test") return;
  const filename =
    configured ??
    path.join(
      legalDataHome(),
      "apps",
      "mike",
      "telemetry",
      "llm-context-manifests.jsonl",
    );
  const write = appendQueue.then(async () => {
    await mkdir(path.dirname(filename), { recursive: true });
    await appendFile(filename, `${JSON.stringify(manifest)}\n`, "utf8");
  });
  appendQueue = write.catch(() => undefined);
  await write;
}
