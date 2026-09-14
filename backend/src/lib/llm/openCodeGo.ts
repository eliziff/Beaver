import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCatalogCache, fetchCatalogJson } from "../catalogCache";
import { createAnthropicWireAdapter } from "./anthropicWire";
import { requireApiKey } from "./apiKeys";
import { openCodeGoModelSlug, openCodeGoWireProtocol } from "./models";
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

// Flat-rate subscription: the credential is the one the OpenCode CLI already
// holds, not a per-token API key the user pastes.
let cliToken: string | null | undefined;
function subscriptionToken(): string | null {
  if (cliToken === undefined) try {
    const auth = JSON.parse(readFileSync(process.env.OPENCODE_AUTH_PATH?.trim() ||
      join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"));
    cliToken = String(auth?.["opencode-go"]?.key ?? "").trim() || null;
  } catch { cliToken = null; }
  return cliToken;
}

function key(params: StreamChatParams) {
  return requireApiKey(
    params.apiKeys?.["opencode-go"] ?? subscriptionToken(),
    "OPENCODE_GO_API_KEY",
    label,
  );
}

// The gateway rejects the default Node agent and routes chat-format requests by
// session, so both headers are mandatory on every protocol.
const wireHeaders = (session: string) =>
  ({ "User-Agent": "opencode/1.0", "x-opencode-session": session });

export function streamOpenCodeGo(params: StreamChatParams): Promise<StreamChatResult> {
  const model = openCodeGoModelSlug(params.model);
  const protocol = openCodeGoWireProtocol(params.model);
  if (!model) throw new Error(`Unsupported OpenCode Go model: ${params.model}`);
  const apiKey = key(params);
  const endpoint = baseUrl();
  const session = params.promptCacheKey?.trim() || randomUUID();
  const headers = wireHeaders(session);

  if (protocol === "responses") {
    return runProviderLoop(params, createResponsesWireAdapter(params, {
      apiKey,
      baseURL: endpoint,
      model,
      provider: label,
      persistent: false,
      promptCacheKey: session,
      headers,
    }));
  }
  if (protocol === "messages") {
    return runProviderLoop(params, createAnthropicWireAdapter(params, apiKey, false, {
      baseURL: endpoint.replace(/\/v1$/u, ""),
      model,
      provider: label,
      adaptiveThinking: false,
      headers,
    }));
  }
  return runProviderLoop(params, createCompatibleWireAdapter(params, {
    apiKey,
    baseURL: endpoint,
    model,
    provider: label,
    maxTokens: 16_384,
    imageInput: model === "deepseek-v4-flash-vision-exp",
    headers,
  }));
}

export type OpenCodeGoCatalog = {
  source: "live" | "unavailable";
  models: { id: string; displayName: string }[];
};

/** Exposes every slug the subscription publishes; the wire is chosen when a turn is sent. */
export function normalizeOpenCodeGoCatalog(payload: unknown): OpenCodeGoCatalog["models"] {
  const data = (payload as { data?: unknown } | null)?.data;
  return (Array.isArray(data) ? data : []).flatMap((raw) => {
    const row = (raw ?? {}) as { id?: unknown; name?: unknown };
    if (typeof row.id !== "string") return [];
    const id = row.id.trim();
    if (!id || id.includes("/")) return [];
    return [{ id, displayName: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id }];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function probeOpenCodeGo(apiKey: string | null | undefined): Promise<OpenCodeGoCatalog> {
  const token = apiKey?.trim() || subscriptionToken();
  if (!token) throw new Error(`${label} is not configured.`);
  const payload = await fetchCatalogJson<unknown>(
    `${baseUrl()}/models`, {
      label: "OpenCode Go model listing",
      timeoutMs: Number(process.env.OPENCODE_GO_CATALOG_TIMEOUT_MS) || 3_000,
      headers: { ...wireHeaders(randomUUID()), Authorization: `Bearer ${token}` },
    },
  );
  return { source: "live", models: normalizeOpenCodeGoCatalog(payload) };
}

const cache = createCatalogCache<OpenCodeGoCatalog, string | null | undefined>(probeOpenCodeGo, {
  source: "unavailable", models: [],
});
export const openCodeGoModelCatalogSnapshot = (apiKey: string | null | undefined) =>
  cache.snapshot(apiKey);
