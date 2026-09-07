import { randomUUID } from "node:crypto";
import { createCatalogCache, fetchCatalogJson } from "../catalogCache";
import { createAnthropicWireAdapter } from "./anthropicWire";
import { requireApiKey } from "./apiKeys";
import { openCodeGoModelSlug, openCodeGoProtocol } from "./models";
import { createCompatibleWireAdapter } from "./openaiCompatibleWire";
import { createResponsesWireAdapter } from "./openaiResponsesWire";
import { runProviderLoop } from "./providerLoop";
import type { StreamChatParams, StreamChatResult } from "./types";

const label = "OpenCode Go";

function baseUrl() {
  const url = new URL(
    process.env.OPENCODE_GO_BASE_URL?.trim() ||
      "https://opencode.ai/zen/go/v1",
  );
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OpenCode Go requires an HTTP(S) endpoint without URL credentials.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function key(params: StreamChatParams) {
  return requireApiKey(
    params.apiKeys?.["opencode-go"],
    "OPENCODE_GO_API_KEY",
    label,
  );
}

export function streamOpenCodeGo(params: StreamChatParams): Promise<StreamChatResult> {
  const model = openCodeGoModelSlug(params.model);
  const protocol = openCodeGoProtocol(params.model);
  if (!model || !protocol) throw new Error(`Unsupported OpenCode Go model: ${params.model}`);
  const apiKey = key(params);
  const endpoint = baseUrl();

  if (protocol === "responses") {
    return runProviderLoop(params, createResponsesWireAdapter(params, {
      apiKey,
      baseURL: endpoint,
      model,
      provider: label,
      persistent: false,
      promptCacheKey: params.promptCacheKey?.trim() || randomUUID(),
    }));
  }
  if (protocol === "messages") {
    return runProviderLoop(params, createAnthropicWireAdapter(params, apiKey, false, {
      baseURL: endpoint.replace(/\/v1$/u, ""),
      model,
      provider: label,
      adaptiveThinking: false,
    }));
  }
  return runProviderLoop(params, createCompatibleWireAdapter(params, {
    apiKey,
    baseURL: endpoint,
    model,
    provider: label,
    maxTokens: 16_384,
    imageInput: model === "deepseek-v4-flash-vision-exp",
  }));
}

export type OpenCodeGoCatalog = {
  source: "live" | "unavailable";
  models: { id: string; displayName: string }[];
};

async function probeOpenCodeGo(apiKey: string | null | undefined): Promise<OpenCodeGoCatalog> {
  if (!apiKey?.trim()) throw new Error(`${label} is not configured.`);
  const payload = await fetchCatalogJson<{ data?: { id?: unknown; name?: unknown }[] }>(
    `${baseUrl()}/models`, {
      label: "OpenCode Go model listing",
      timeoutMs: Number(process.env.OPENCODE_GO_CATALOG_TIMEOUT_MS) || 3_000,
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    },
  );
  const models = (payload.data ?? []).flatMap(({ id, name }) => {
    if (typeof id !== "string" || !openCodeGoProtocol(id)) return [];
    return [{ id, displayName: typeof name === "string" && name.trim() ? name.trim() : id }];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));
  return { source: "live", models };
}

const cache = createCatalogCache<OpenCodeGoCatalog, string | null | undefined>(probeOpenCodeGo, {
  source: "unavailable", models: [],
});
export const openCodeGoModelCatalogSnapshot = (apiKey: string | null | undefined) =>
  cache.snapshot(apiKey);
