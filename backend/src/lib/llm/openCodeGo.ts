import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCatalogCache, fetchCatalogJson } from "../catalogCache";
import { requireApiKey } from "./apiKeys";
import { openCodeGoModelSlug, openCodeGoProtocol } from "./models";
import type { StreamChatParams } from "./types";

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

export function openCodeGoConnection(params: StreamChatParams) {
  const model = openCodeGoModelSlug(params.model), protocol = openCodeGoProtocol(params.model);
  if (!model || !protocol) throw new Error(`Unsupported OpenCode Go model: ${params.model}`);
  return { model, protocol, apiKey: key(params), baseURL: baseUrl(),
    headers: wireHeaders(params.promptCacheKey?.trim() || randomUUID()) };
}

export type OpenCodeGoCatalog = {
  source: "live" | "unavailable";
  models: { id: string; displayName: string }[];
};

async function probeOpenCodeGo(apiKey: string | null | undefined): Promise<OpenCodeGoCatalog> {
  const token = apiKey?.trim() || subscriptionToken();
  if (!token) throw new Error(`${label} is not configured.`);
  const payload = await fetchCatalogJson<{ data?: { id?: unknown; name?: unknown }[] }>(
    `${baseUrl()}/models`, {
      label: "OpenCode Go model listing",
      timeoutMs: Number(process.env.OPENCODE_GO_CATALOG_TIMEOUT_MS) || 3_000,
      headers: { ...wireHeaders(randomUUID()), Authorization: `Bearer ${token}` },
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
