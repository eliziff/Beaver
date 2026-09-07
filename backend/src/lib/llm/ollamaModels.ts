import { createCatalogCache, fetchCatalogJson } from "../catalogCache";

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

async function probeOllama(): Promise<OllamaModelCatalog> {
  const payload = await fetchCatalogJson<{
    models?: { name?: unknown; model?: unknown; capabilities?: unknown }[];
  }>(`${ollamaBaseUrl()}/api/tags`, {
    label: "Ollama model listing",
    timeoutMs: Number(process.env.OLLAMA_CATALOG_TIMEOUT_MS) || 750,
    ...(process.env.OLLAMA_HOST_HEADER && { headers: { Host: process.env.OLLAMA_HOST_HEADER } }),
  });
  const models = (payload.models ?? []).flatMap(({ name, model, capabilities }) => {
    const id = typeof name === "string" ? name : typeof model === "string" ? model : "";
    return id ? [{
      name: id,
      displayName: label(id),
      supportsThinking: Array.isArray(capabilities) && capabilities.includes("thinking"),
    }] : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { source: "live", models };
}

const cache = createCatalogCache<OllamaModelCatalog>(probeOllama, {
  source: "unavailable", models: [],
});
export const ollamaModelCatalogSnapshot = () => cache.snapshot();
