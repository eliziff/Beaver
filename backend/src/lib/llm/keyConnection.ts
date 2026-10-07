// A model a person connects in their own browser: an API key (its provider read from the key's prefix), an
// OpenRouter key made by OAuth PKCE, or an OpenAI-compatible server on their own computer (Ollama, LM Studio).
// Requests go from the browser to that provider alone, through the same AI SDK provider packages as
// sdkProviders.ts; the key is never written anywhere by this module. `structuredLlm` gives such a model as the
// `{ complete(messages, { schema }) }` contract structured callers (the note splitter) take; an evaluation can
// give the same contract over another transport.
import type { LanguageModel } from "ai" with { "resolution-mode": "import" };

export type KeyProvider = "openai" | "anthropic" | "gemini" | "groq" | "cerebras" | "openrouter" | "mistral" | "local";
export type ModelConnection = { provider: KeyProvider; model: string; apiKey?: string; baseUrl?: string };
export type StructuredMessage = { role: "system" | "user" | "assistant"; content: string };
export type StructuredUsage = { input_tokens: number; cached_input_tokens: number; output_tokens: number;
  reasoning_tokens: number };
export type StructuredLlm = {
  complete(messages: StructuredMessage[], options?: { schema?: Record<string, unknown>; name?: string;
    signal?: AbortSignal }): Promise<{ text: string; usage: StructuredUsage }>;
};

/** Each provider: its name, where its OpenAI-compatible API is (when it has one), and the model it is used with
 *  first when its listing has it. `confidential` is false where the provider's own terms let it use what is sent. */
export const KEY_PROVIDERS: Record<KeyProvider, { label: string; baseUrl?: string; preferred: RegExp[];
  confidential: boolean }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", preferred: [/^gpt-5\.2$/u, /^gpt-5(\.\d+)?$/u, /^gpt-5/u], confidential: true },
  anthropic: { label: "Anthropic", preferred: [/sonnet/u, /opus/u], confidential: true },
  gemini: { label: "Google Gemini", preferred: [/^gemini-[\d.]+-flash$/u, /flash(?!.*lite)/u], confidential: false },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", preferred: [/^openai\/gpt-oss-120b$/u], confidential: true },
  cerebras: { label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", preferred: [/^gpt-oss-120b$/u], confidential: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", preferred: [/^openai\/gpt-5\.2$/u, /^openai\/gpt-5/u], confidential: true },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", preferred: [/^mistral-medium-latest$/u, /^mistral-large-latest$/u], confidential: false },
  local: { label: "Local model", baseUrl: "http://localhost:11434/v1", preferred: [], confidential: true },
};

/** The provider a key belongs to, read from its prefix; Mistral's keys have none, only their 32 letters and digits. */
export function detectKeyProvider(key: string): Exclude<KeyProvider, "local"> | null {
  const value = key.trim();
  if (value.startsWith("sk-ant-")) return "anthropic";
  if (value.startsWith("sk-or-")) return "openrouter";
  if (value.startsWith("sk-")) return "openai";
  if (value.startsWith("AIza")) return "gemini";
  if (value.startsWith("gsk_")) return "groq";
  if (value.startsWith("csk-")) return "cerebras";
  if (/^[A-Za-z0-9]{32}$/u.test(value)) return "mistral";
  return null;
}

const ANTHROPIC_HEADERS = (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01",
  // Anthropic answers a browser only when it is told the key is the person's own.
  "anthropic-dangerous-direct-browser-access": "true" });
const baseUrl = (connection: Pick<ModelConnection, "provider" | "baseUrl">) =>
  (connection.baseUrl?.trim() || KEY_PROVIDERS[connection.provider].baseUrl || "").replace(/\/+$/u, "");

/** The models the provider lists for this key, newest listing order kept, and the one to start with. */
export async function listConnectionModels(connection: Omit<ModelConnection, "model">, signal?: AbortSignal) {
  const key = connection.apiKey?.trim() ?? "";
  let ids: string[];
  if (connection.provider === "anthropic") {
    const answer = await readJson("https://api.anthropic.com/v1/models?limit=100", { headers: ANTHROPIC_HEADERS(key), signal });
    ids = (answer.data ?? []).map((model: { id: string }) => model.id);
  } else if (connection.provider === "gemini") {
    const answer = await readJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": key }, signal });
    ids = (answer.models ?? []).filter((model: { supportedGenerationMethods?: string[] }) =>
      model.supportedGenerationMethods?.includes("generateContent"))
      .map((model: { name: string }) => model.name.replace(/^models\//u, ""));
  } else {
    const answer = await readJson(`${baseUrl(connection)}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal });
    ids = (answer.data ?? answer.models ?? []).map((model: { id?: string; name?: string }) => model.id ?? model.name ?? "");
  }
  ids = [...new Set(ids.filter(Boolean))];
  const preferred = KEY_PROVIDERS[connection.provider].preferred
    .map((pattern) => ids.find((id) => pattern.test(id))).find(Boolean);
  return { models: ids, preferred: preferred ?? ids[0] ?? "" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each provider's own listing shape, read field by field
async function readJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw await providerError(response);
  return response.json();
}

/** What a provider's refusal says, without echoing the key. */
async function providerError(response: Response) {
  const body = await response.text().catch(() => "");
  let detail = "";
  try { const parsed = JSON.parse(body); detail = parsed.error?.message ?? parsed.message ?? parsed.error ?? ""; } catch { detail = body; }
  const reason = response.status === 401 || response.status === 403 ? "it did not accept the key"
    : response.status === 429 ? "it is limiting how often it is asked" : `it answered ${response.status}`;
  return Object.assign(new Error(`The provider could not be used: ${reason}.${detail ? ` ${String(detail).slice(0, 200)}` : ""}`),
    { status: response.status });
}

async function languageModel(connection: ModelConnection): Promise<LanguageModel> {
  const apiKey = connection.apiKey?.trim() ?? "";
  if (connection.provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey, headers: { "anthropic-dangerous-direct-browser-access": "true" } })(connection.model);
  }
  if (connection.provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({ apiKey })(connection.model);
  }
  if (connection.provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey }).chat(connection.model);
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  // A local server takes no key; one is sent only where there is one.
  return createOpenAICompatible({ name: connection.provider, baseURL: baseUrl(connection),
    ...(apiKey && { apiKey }), supportsStructuredOutputs: true, includeUsage: true })(connection.model);
}

/** A connected model as the structured contract: each answer is JSON matching the request's schema. */
export function structuredLlm(connection: ModelConnection): StructuredLlm {
  return {
    async complete(messages, { schema, name, signal } = {}) {
      const { generateText, Output, jsonSchema } = await import("ai");
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
      let result;
      try {
        result = await generateText({ model: await languageModel(connection), system: system || undefined,
          messages: messages.filter((message) => message.role !== "system")
            .map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
          ...(schema && { output: Output.object({ schema: jsonSchema(schema), name }) }),
          maxRetries: 2, abortSignal: signal });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (signal?.aborted || !status) throw error;
        throw Object.assign(new Error(`The provider could not be used: ${status === 401 || status === 403
          ? "it did not accept the key" : status === 429 ? "it is limiting how often it is asked" : `it answered ${status}`}.`),
        { status });
      }
      const usage = result.totalUsage;
      return { text: result.text, usage: { input_tokens: usage.inputTokens ?? 0,
        cached_input_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0, output_tokens: usage.outputTokens ?? 0,
        reasoning_tokens: usage.outputTokenDetails?.reasoningTokens ?? 0 } };
    },
  };
}

/** Answers kept by the request they answer, so asking again costs nothing: `store` is where (the page's
 *  IndexedDB), keyed by a SHA-256 of the model and the request. */
export function rememberingLlm(llm: StructuredLlm, model: string, store: {
  get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }): StructuredLlm & { stats: { calls: number; kept: number } } {
  const stats = { calls: 0, kept: 0 };
  return { stats, async complete(messages, options = {}) {
    const request = new TextEncoder().encode(JSON.stringify([model, messages, options.schema ?? null]));
    const key = [...new Uint8Array(await crypto.subtle.digest("SHA-256", request))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const kept = await store.get(key).catch(() => undefined);
    if (kept !== undefined) { stats.kept++; return { text: kept, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 } }; }
    const answer = await llm.complete(messages, options);
    stats.calls++;
    await store.set(key, answer.text).catch(() => undefined);
    return answer;
  } };
}

// OpenRouter's OAuth PKCE (https://openrouter.ai/docs/use-cases/oauth-pkce): the person signs in at OpenRouter,
// which gives a code, exchanged here for a key of their own. Without a callback address (a page opened from a
// file), OpenRouter shows the code for the person to paste back.
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

export async function openRouterAuthorization(callbackUrl?: string) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL("https://openrouter.ai/auth");
  if (callbackUrl) url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.href, verifier };
}

export async function exchangeOpenRouterCode(code: string, verifier: string, signal?: AbortSignal) {
  const answer = await readJson("https://openrouter.ai/api/v1/auth/keys", { method: "POST", signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim(), code_verifier: verifier, code_challenge_method: "S256" }) });
  if (typeof answer.key !== "string" || !answer.key) throw new Error("OpenRouter gave no key for that code.");
  return answer.key as string;
}
