import { requireApiKey } from "../../src/lib/llm/apiKeys";
import { createCompatibleWireAdapter } from "../../src/lib/llm/openaiCompatibleWire";
import { runProviderLoop } from "../../src/lib/llm/providerLoop";
import type { StreamChatParams, StreamChatResult } from "../../src/lib/llm/types";

type OxAlphaAuth = "required" | "anonymous" | "optional" | "proxy";
type OxAlphaRouteConfig = {
  base_url: string;
  catalog_url: string;
  model: string;
  key_env: string | null;
  auth: OxAlphaAuth;
  zero_price_must_be_advertised: boolean;
  default_requests_per_minute: number;
  maximum_requests_per_minute: number | null;
  published_daily_request_cap: number | null;
  requires_subscription: boolean;
};

export const OX_ALPHA_ROUTES = {
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    catalog_url: "https://openrouter.ai/api/v1/models",
    model: "stealth/ox-alpha",
    key_env: "OPENROUTER_API_KEY",
    auth: "required",
    zero_price_must_be_advertised: true,
    default_requests_per_minute: 20,
    maximum_requests_per_minute: 20,
    published_daily_request_cap: 50,
    requires_subscription: false,
  },
  "opencode-zen": {
    base_url: "https://opencode.ai/zen/v1",
    catalog_url: "https://opencode.ai/zen/v1/models",
    model: "x-preview-f-free",
    key_env: null,
    auth: "anonymous",
    zero_price_must_be_advertised: false,
    default_requests_per_minute: 20,
    maximum_requests_per_minute: null,
    published_daily_request_cap: null,
    requires_subscription: false,
  },
  "opencode-go": {
    base_url: "https://opencode.ai/zen/go/v1",
    catalog_url: "https://opencode.ai/zen/go/v1/models",
    model: "ox-alpha-free",
    key_env: "OPENCODE_API_KEY",
    auth: "required",
    zero_price_must_be_advertised: false,
    default_requests_per_minute: 20,
    maximum_requests_per_minute: null,
    published_daily_request_cap: null,
    requires_subscription: true,
  },
  nous: {
    // `hermes portal` + `hermes proxy start` keeps the OAuth refresh token out of Beaver.
    base_url: "http://127.0.0.1:8645/v1",
    catalog_url: "http://127.0.0.1:8645/v1/models",
    model: "stealth/ox-alpha",
    key_env: null,
    auth: "proxy",
    zero_price_must_be_advertised: true,
    default_requests_per_minute: 20,
    maximum_requests_per_minute: null,
    published_daily_request_cap: null,
    requires_subscription: false,
  },
  kilo: {
    base_url: "https://api.kilo.ai/api/gateway",
    catalog_url: "https://api.kilo.ai/api/gateway/models",
    model: "stealth/ox-alpha",
    key_env: "KILO_API_KEY",
    auth: "optional",
    zero_price_must_be_advertised: true,
    default_requests_per_minute: 200 / 60,
    maximum_requests_per_minute: 200 / 60,
    published_daily_request_cap: null,
    requires_subscription: false,
  },
} as const satisfies Record<string, OxAlphaRouteConfig>;

export type OxAlphaRoute = keyof typeof OX_ALPHA_ROUTES;
export type OxAlphaCredentials = { apiKey: string; omitAuthorization?: boolean };

export function oxAlphaRoute(value: string): OxAlphaRoute {
  if (value in OX_ALPHA_ROUTES) return value as OxAlphaRoute;
  throw new Error(`--ox-route/--ox-routes must use ${Object.keys(OX_ALPHA_ROUTES).join(", ")}`);
}

export function oxAlphaRoutes(value: string) {
  const names = value.split(/[\s,]+/u).filter(Boolean);
  if (!names.length) throw new Error("--ox-routes requires at least one route");
  const routes = names.map(oxAlphaRoute);
  if (new Set(routes).size !== routes.length) throw new Error("--ox-routes must not repeat a route");
  return routes;
}

export function assignedOxAlphaRoute(routes: readonly OxAlphaRoute[], index: number) {
  if (!routes.length) throw new Error("cannot assign an Ox Alpha case without a route");
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Ox Alpha case index must be a non-negative integer");
  return routes[index % routes.length];
}

export function oxAlphaCredentials(route: OxAlphaRoute): OxAlphaCredentials {
  const config = OX_ALPHA_ROUTES[route];
  if (config.auth === "required") {
    return {
      apiKey: requireApiKey(undefined, config.key_env!, `Ox Alpha through ${route}`),
    };
  }
  if (config.auth === "optional") {
    const apiKey = process.env[config.key_env!]?.trim();
    if (apiKey) return { apiKey };
    return { apiKey: "sk-unused", omitAuthorization: true };
  }
  if (config.auth === "anonymous") {
    return { apiKey: "sk-unused", omitAuthorization: true };
  }
  return { apiKey: "sk-unused" };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function zero(value: unknown) {
  return (typeof value === "string" || typeof value === "number") && Number(value) === 0;
}

export function inspectOxAlphaCatalog(route: OxAlphaRoute, raw: unknown) {
  const config = OX_ALPHA_ROUTES[route];
  const root = record(raw);
  const models = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models) ? root.models : Array.isArray(raw) ? raw : [];
  const model = models.map(record).find((item) => item?.id === config.model) ?? null;
  if (!model) throw new Error(`${config.model} is not advertised by ${route}`);
  const pricing = record(model.pricing);
  const priceVerified = model.isFree === true || Boolean(
    pricing && zero(pricing.prompt) && zero(pricing.completion),
  );
  if (config.zero_price_must_be_advertised && (!priceVerified || model.isFree === false)) {
    throw new Error(`${route} no longer advertises zero input and output prices for ${config.model}`);
  }
  const reasoning = record(model.reasoning);
  return {
    route,
    hostname: new URL(config.base_url).hostname,
    model: config.model,
    price_verified_zero: priceVerified,
    advertised_pricing: pricing ?? null,
    advertised_reasoning: reasoning ?? null,
    advertised_free: typeof model.isFree === "boolean" ? model.isFree : null,
    may_train_on_prompts: typeof model.mayTrainOnYourPrompts === "boolean"
      ? model.mayTrainOnYourPrompts : null,
    checked_at: new Date().toISOString(),
  };
}

function catalogHeaders(credentials: OxAlphaCredentials): Record<string, string> {
  if (credentials.omitAuthorization) return { accept: "application/json" };
  return { accept: "application/json", authorization: `Bearer ${credentials.apiKey}` };
}

export async function preflightOxAlpha(
  route: OxAlphaRoute,
  credentials: OxAlphaCredentials,
  fetcher: typeof fetch = fetch,
) {
  const config = OX_ALPHA_ROUTES[route];
  const response = await fetcher(config.catalog_url, {
    headers: catalogHeaders(credentials),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${route} model-catalog preflight failed with HTTP ${response.status}`);
  return inspectOxAlphaCatalog(route, await response.json());
}

function reasoningEffort(value?: string) {
  const effort = value?.toLowerCase() || "high";
  if (!["low", "high", "max"].includes(effort)) {
    throw new Error("Ox Alpha effort must be low, high, or max");
  }
  return effort;
}

export function streamOxAlpha(
  params: StreamChatParams,
  route: OxAlphaRoute,
  credentials: OxAlphaCredentials,
): Promise<StreamChatResult> {
  const config = OX_ALPHA_ROUTES[route];
  const effort = reasoningEffort(params.reasoningEffort);
  const request = route === "openrouter"
    ? { response_format: { type: "json_object" }, reasoning: { effort, exclude: true } }
    : { response_format: { type: "json_object" }, reasoning_effort: effort };
  const routed = {
    ...params,
    model: config.model,
    outputSchema: undefined,
    maxIterations: 1,
    maxProviderAttempts: 1,
  };
  return runProviderLoop(routed, createCompatibleWireAdapter(routed, {
    apiKey: credentials.apiKey,
    baseURL: config.base_url,
    model: config.model,
    provider: `ox-alpha:${route}`,
    maxTokens: params.maxTokens ?? 32_768,
    // openai-node uses null to explicitly omit its otherwise mandatory bearer header.
    headers: credentials.omitAuthorization
      ? ({ Authorization: null } as unknown as Record<string, string>)
      : undefined,
    request,
  }));
}
