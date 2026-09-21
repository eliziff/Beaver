import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCatalogCache, fetchCatalogJson } from "../catalogCache";
import { requireApiKey } from "./apiKeys";
import { openCodeGoModelSlug, openCodeGoWireProtocol } from "./models";
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
function subscriptionToken(): string | null {
  try {
    const auth = JSON.parse(readFileSync(process.env.OPENCODE_AUTH_PATH?.trim() ||
      join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
        "opencode", "auth.json"), "utf8"));
    const key = auth?.["opencode-go"]?.key;
    return typeof key === "string" ? key.trim() || null : null;
  } catch { return null; }
}

function key(override: string | null | undefined) {
  return requireApiKey(override?.trim() || process.env.OPENCODE_GO_API_KEY?.trim() ||
    subscriptionToken(), "OPENCODE_GO_API_KEY", label);
}

// The gateway rejects the default Node agent and routes chat-format requests by
// session, so both headers are mandatory on every protocol.
const wireHeaders = (session: string) =>
  ({ "User-Agent": "beaver/1.0", "x-opencode-session": session });

export function openCodeGoConnection(params: StreamChatParams) {
  const model = openCodeGoModelSlug(params.model), protocol = openCodeGoWireProtocol(params.model);
  if (!model) throw new Error(`Unsupported OpenCode Go model: ${params.model}`);
  return { model, protocol, apiKey: key(params.apiKeys?.["opencode-go"]), baseURL: baseUrl(),
    headers: wireHeaders(params.promptCacheKey?.trim() || randomUUID()) };
}

export type OpenCodeGoCatalog = {
  source: "live" | "unavailable";
  models: { id: string; displayName: string }[];
};

export function normalizeOpenCodeGoCatalog(payload: unknown): OpenCodeGoCatalog["models"] {
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : null;
  const models = new Map<string, OpenCodeGoCatalog["models"][number]>();
  for (const entry of Array.isArray(data) ? data : []) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) continue;
    models.set(id, { id, displayName: typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim() : id });
  }
  return [...models.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function probeOpenCodeGo(apiKey: string | null | undefined): Promise<OpenCodeGoCatalog> {
  const payload = await fetchCatalogJson<unknown>(`${baseUrl()}/models`, {
    label: "OpenCode Go model listing",
    timeoutMs: Number(process.env.OPENCODE_GO_CATALOG_TIMEOUT_MS) || 3_000,
    headers: { ...wireHeaders(randomUUID()), Authorization: `Bearer ${key(apiKey)}` },
  });
  return { source: "live", models: normalizeOpenCodeGoCatalog(payload) };
}

const catalog = () => createCatalogCache<OpenCodeGoCatalog, string>(probeOpenCodeGo, {
  source: "unavailable", models: [],
});
let cached = { credential: "", value: catalog() };
export function openCodeGoModelCatalogSnapshot(apiKey: string | null | undefined) {
  let credential: string;
  try { credential = key(apiKey); } catch { return { source: "unavailable" as const, models: [] }; }
  if (credential !== cached.credential) cached = { credential, value: catalog() };
  return cached.value.snapshot(credential);
}
