import { z } from "zod";
import { API_KEY_PROVIDERS } from "../userCredentials";
import type { UserApiKeys } from "./types";

const endpoint = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u),
  provider: z.literal("openai-compatible"),
  label: z.string().trim().min(1).max(200).optional(),
  location: z.enum(["local", "cloud"]),
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password && !url.search && !url.hash;
  }),
  apiModel: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).optional(),
  apiKeyProvider: z.enum(API_KEY_PROVIDERS).optional(),
  tolerateTextToolCalls: z.boolean().optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  contextWindow: z.number().int().positive().optional(),
  imageInput: z.boolean().default(false),
}).strict();
export type ConfiguredModel = z.infer<typeof endpoint>;

let cached: { source: string; models: ConfiguredModel[] } | undefined;
export function configuredModels() {
  const source = process.env.MIKE_MODEL_CONFIG_JSON?.trim() || '{"models":[]}';
  if (cached?.source === source) return cached.models;
  let models: ConfiguredModel[];
  try {
    models = z.object({ models: z.array(endpoint).max(100) }).strict().parse(JSON.parse(source)).models;
    if (new Set(models.map(({ id }) => id)).size !== models.length) throw new Error();
  } catch {
    // Configuration can contain credentials; never echo parser input/errors.
    throw new Error("MIKE_MODEL_CONFIG_JSON must contain valid, uniquely named model declarations.");
  }
  cached = { source, models };
  return models;
}
export function getConfiguredModel(id: string) {
  return id.startsWith("configured:")
    ? configuredModels().find((model) => `configured:${model.id}` === id) : undefined;
}
export function configuredApiKey(model: ConfiguredModel, keys?: UserApiKeys) {
  return (model.apiKeyProvider && keys?.[model.apiKeyProvider]?.trim()) || model.apiKey ||
    (model.apiKeyEnv && process.env[model.apiKeyEnv]?.trim()) || undefined;
}
export function configuredAvailable(model: ConfiguredModel, keys?: UserApiKeys) {
  return !(model.apiKey || model.apiKeyEnv || model.apiKeyProvider) || !!configuredApiKey(model, keys);
}
