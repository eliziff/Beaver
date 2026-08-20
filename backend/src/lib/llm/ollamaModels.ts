import { bufferRemoteResponse } from "../remoteUrlSafety";

const DEFAULT_URL = "http://127.0.0.1:11434";

type OllamaModelCatalog = {
  source: "live" | "unavailable";
  models: { name: string; displayName: string; supportsThinking: boolean }[];
};

function label(name: string) {
  const [rawFamily, tag = ""] = name.split(":", 2);
  const family = rawFamily.replace(/^qwen(?=\d)/iu, "Qwen ");
  const size = /^(\d+(?:\.\d+)?)b(?:-(.+))?$/iu.exec(tag);
  return size ? `${family} ${size[1]}B${size[2] ? ` (${size[2].toUpperCase()})` : ""}`
    : tag ? `${family} ${tag}` : family;
}

export function ollamaBaseUrl() {
  const url = new URL(process.env.OLLAMA_BASE_URL || DEFAULT_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Ollama requires an HTTP(S) endpoint.");
  if (url.username || url.password) throw new Error("Ollama endpoint credentials are not allowed in the URL.");
  const loopback = ["localhost", "::1", "[::1]"].includes(url.hostname) || /^127\./u.test(url.hostname);
  const trusted = (process.env.OLLAMA_TRUSTED_HTTP_ORIGINS ?? "")
    .split(",").map((origin) => origin.trim()).includes(url.origin);
  if (url.protocol === "http:" && !loopback && !trusted) {
    throw new Error(
      `Refusing insecure remote Ollama endpoint ${url.origin}. Use HTTPS or add this exact origin to OLLAMA_TRUSTED_HTTP_ORIGINS.`,
    );
  }
  return url.toString().replace(/\/$/u, "");
}

export async function getOllamaModelCatalog(): Promise<OllamaModelCatalog> {
  try {
    const response = await fetch(`${ollamaBaseUrl()}/api/tags`, {
      headers: process.env.OLLAMA_HOST_HEADER ? { Host: process.env.OLLAMA_HOST_HEADER } : undefined,
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_CATALOG_TIMEOUT_MS) || 750),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Ollama model listing failed (HTTP ${response.status}).`);
    }
    const bounded = await bufferRemoteResponse(response, {
      label: "Ollama model listing",
      maxBytes: 1024 * 1024,
      contentTypes: ["application/json"],
    });
    const payload = await bounded.json() as {
      models?: { name?: unknown; model?: unknown; capabilities?: unknown }[];
    };
    const models = (payload.models ?? []).flatMap(({ name, model, capabilities }) => {
      const id = typeof name === "string" ? name : typeof model === "string" ? model : "";
      return id ? [{
        name: id,
        displayName: label(id),
        supportsThinking: Array.isArray(capabilities) && capabilities.includes("thinking"),
      }] : [];
    }).sort((left, right) => left.name.localeCompare(right.name));
    return { source: "live", models };
  } catch { return { source: "unavailable", models: [] }; }
}
