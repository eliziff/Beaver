import type { Provider } from "./types";
import { getConfiguredModel } from "./registry";

export type PickerModel = {
    id: string; label: string; group: string; provider: Provider;
    settingsOnly?: boolean; available?: boolean; family?: string;
    /** Canonical identity shared by every provider serving the same model. */
    modelKey?: string;
    /** First release date (ms) when the catalogue publishes one. */
    releasedAt?: number;
    reasoningEfforts?: string[]; defaultReasoningEffort?: string;
};
const STATIC_MODELS = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", group: "DeepSeek" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "DeepSeek" },
    { id: "muse-spark-1.2", label: "Muse Spark 1.2", group: "Meta" },
    { id: "muse-spark-1.1", label: "Muse Spark 1.1", group: "Meta" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI", settingsOnly: true },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI", settingsOnly: true },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic", settingsOnly: true },
    { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", group: "Google", settingsOnly: true },
    { id: "gpt-5.4-lite", label: "GPT-5.4 Lite", group: "OpenAI", settingsOnly: true },
    // The contributor tier trains on inputs and stays out of the chat picker.
    { id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 (contributor � trains on input)", group: "Meta", settingsOnly: true },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "OpenAI", hidden: true },
];

export function pickerModel(model: Omit<PickerModel, "provider">): PickerModel {
    const reasoning = model.id.startsWith("deepseek-")
        ? { reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" }
        : model.id.startsWith("claude-p:")
            ? { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high" }
        : model.id.includes("muse-spark-")
            ? { reasoningEfforts: ["xhigh", "high", "medium", "low", "minimal"], defaultReasoningEffort: "medium" }
            : {};
    return { ...reasoning, ...model, family: model.family ?? familyForModel(model.id),
        provider: providerForModel(model.id) };
}

export function staticPickerModels() {
    const models = STATIC_MODELS.filter(model => !model.hidden);
    return [...models.map(pickerModel), ...models.filter(model => model.group === "Anthropic")
        .map(model => pickerModel({ ...model, id: `claude-p:${model.id}`, group: "Claude Code" }))];
}

const CODEX_MODEL_PREFIX = "codex:";
const CLAUDE_P_MODEL_PREFIX = "claude-p:";
const OLLAMA_MODEL_PREFIX = "ollama:";
const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";
/**
 * A selected model is a (provider, native id) pair, written `provider:native`.
 * The provider is explicit so one model can be served by several inference
 * providers. Legacy shape-only ids stay readable.
 */
const COMPOSITE_PROVIDERS: Record<string, Provider> = {
    claude: "claude", gemini: "gemini", openai: "openai", deepseek: "deepseek",
    openrouter: "openrouter", meta: "meta", "opencode-go": "opencode-go",
    codex: "codex", "claude-p": "claude-p", ollama: "ollama",
    configured: "configured",
};
const COMPOSITE_PATTERN = /^([a-z-]+):([\s\S]+)$/u;

/** The provider half of a composite id, when one is present. */
function compositeProvider(model: string): Provider | null {
    const match = COMPOSITE_PATTERN.exec(model);
    return match ? COMPOSITE_PROVIDERS[match[1]] ?? null : null;
}
// OpenCode Go publishes one catalog over three wire protocols, but /models
// does not say which protocol each model speaks. This map pins the known
// models; a newly published slug inherits its vendor's wire (see
// openCodeGoWireProtocol), so the live catalog stays complete.
const OPENCODE_GO_MODELS = {
    responses: new Set([
        "grok-4.6",
        "grok-4.5",
        "gpt-5.6-luna",
        "muse-spark-1.3-contributor",
        "muse-spark-1.2-contributor",
        "omen-alpha",
    ]),
    chat: new Set([
        "glm-5.3-flash",
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "glm-5",
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.6",
        "kimi-k2.5",
        "longcat-2.0",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "mimo-v2-pro",
        "mimo-v2-omni",
        "hy4-preview",
        "hy3",
        "hy3-preview",
    ]),
    messages: new Set([
        "minimax-m3",
        "minimax-m2.7",
        "minimax-m2.5",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-plus",
        "qwen3.5-plus",
    ]),
} as const;

export type OpenCodeGoProtocol = keyof typeof OPENCODE_GO_MODELS;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "codex:gpt-5.6-luna";

const ALL_MODELS = new Set(STATIC_MODELS.map(model => model.id));

type CatalogModelMetadata = { contextWindow?: number; imageInput?: boolean };
// Runtime-discovered models, one map per source (models.dev, OpenRouter). The
// pinned STATIC_MODELS seed stays authoritative for flags and hand-tuned
// defaults; this only widens routing to newly published ids and carries their
// metadata.
const catalogSources = new Map<string, Map<string, CatalogModelMetadata>>();

/** Replaces one source's runtime-discovered model metadata; called by its probe. */
export function registerCatalogModels(
    entries: readonly ({ id: string } & CatalogModelMetadata)[],
    source = "default",
): void {
    const metadata = new Map<string, CatalogModelMetadata>();
    for (const entry of entries) {
        if (!entry.id) continue;
        metadata.set(entry.id, {
            ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
            ...(typeof entry.imageInput === "boolean" ? { imageInput: entry.imageInput } : {}),
        });
    }
    catalogSources.set(source, metadata);
}

function catalogMetadataFor(model: string): CatalogModelMetadata | undefined {
    const native = modelForProvider(model);
    for (const metadata of catalogSources.values()) {
        const entry = metadata.get(model) ?? (native === model ? undefined : metadata.get(native));
        if (entry) return entry;
    }
    return undefined;
}

/** Context window reported by a runtime catalogue, when one was published. */
export function catalogModelContextWindow(model: string): number | null {
    return catalogMetadataFor(model)?.contextWindow ?? null;
}

/** The provider-native model id, with any composite provider prefix removed. */
export function modelForProvider(model: string): string {
    const match = COMPOSITE_PATTERN.exec(model);
    return match && COMPOSITE_PROVIDERS[match[1]] ? match[2] : model;
}

export function providerForModel(model: string): Provider {
    const composite = compositeProvider(model);
    if (composite) return composite;
    if (model.startsWith(CODEX_MODEL_PREFIX)) return "codex";
    if (model.startsWith(CLAUDE_P_MODEL_PREFIX)) return "claude-p";
    if (model.startsWith(OLLAMA_MODEL_PREFIX)) return "ollama";
    if (model.startsWith(OPENCODE_GO_MODEL_PREFIX)) return "opencode-go";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    if (model.startsWith("deepseek-")) return "deepseek";
    // Transport is carried by the id shape: OpenRouter slugs are namespaced,
    // Meta Model API takes the bare id.
    if (model.includes("/")) return "openrouter";
    if (model.startsWith("muse-spark-")) return "meta";
    throw new Error(`Unknown model id: ${model}`);
}

export function isSupportedModel(model: string): boolean {
    if (model.startsWith("configured:")) return !!getConfiguredModel(model);
    const composite = compositeProvider(model);
    if (composite) {
        return composite === "opencode-go"
            ? !!openCodeGoModelSlug(model)
            : modelForProvider(model).trim().length > 0;
    }
    if (ALL_MODELS.has(model)) return true;
    if (catalogMetadataFor(model)) return true;
    if (openCodeGoProtocol(model)) return true;
    // The OpenCode Go catalogue is live; a newly published slug is routable even
    // before its wire protocol is known.
    if (model.startsWith(OPENCODE_GO_MODEL_PREFIX)) return !!openCodeGoModelSlug(model);
    return [CODEX_MODEL_PREFIX, CLAUDE_P_MODEL_PREFIX, OLLAMA_MODEL_PREFIX]
        .some((prefix) => model.startsWith(prefix) && model.slice(prefix.length).trim().length > 0);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && isSupportedModel(id)) return id;
    return fallback;
}

export function resolveRequestedModel(
    id: string | null | undefined,
    fallback: string,
): string {
    if (!id) return fallback;
    if (isSupportedModel(id)) return id;
    throw new Error(`Unsupported model id: ${id}`);
}

export function codexModelSlug(model: string): string | null {
    if (compositeProvider(model) !== "codex" && !model.startsWith(CODEX_MODEL_PREFIX)) return null;
    const slug = modelForProvider(model).trim();
    return slug || null;
}

export function openCodeGoModelSlug(model: string): string | null {
    const legacy = model.startsWith(OPENCODE_GO_MODEL_PREFIX);
    if (!legacy && compositeProvider(model) !== "opencode-go") return null;
    const slug = (legacy ? model.slice(OPENCODE_GO_MODEL_PREFIX.length) : modelForProvider(model)).trim();
    return slug && !slug.includes("/") ? slug : null;
}

export function openCodeGoProtocol(model: string): OpenCodeGoProtocol | null {
    const slug = openCodeGoSlug(model);
    if (!slug) return null;
    return (Object.keys(OPENCODE_GO_MODELS) as OpenCodeGoProtocol[])
        .find((protocol) => OPENCODE_GO_MODELS[protocol].has(slug)) ?? null;
}

function openCodeGoSlug(model: string): string | null {
    return model.startsWith(OPENCODE_GO_MODEL_PREFIX) || compositeProvider(model) === "opencode-go"
        ? openCodeGoModelSlug(model)
        : model.trim() || null;
}

// A newly published OpenCode Go slug inherits its sibling vendor's wire, so a
// vendor's newest model routes like the rest of that vendor. Unseen vendors fall
// back to the OpenAI-compatible chat wire the gateway exposes for most models.
const OPENCODE_GO_VENDOR_PROTOCOLS: Record<string, OpenCodeGoProtocol> = (() => {
    const protocols: Record<string, OpenCodeGoProtocol> = {};
    for (const protocol of Object.keys(OPENCODE_GO_MODELS) as OpenCodeGoProtocol[]) {
        for (const slug of OPENCODE_GO_MODELS[protocol]) {
            const vendor = openCodeGoVendor(slug);
            if (vendor && !protocols[vendor]) protocols[vendor] = protocol;
        }
    }
    return protocols;
})();

function openCodeGoVendor(slug: string): string | undefined {
    return /^[a-z]+/u.exec(slug)?.[0];
}

/** Routing for a confirmed OpenCode Go slug: known wire, sibling-vendor wire, then chat. */
export function openCodeGoWireProtocol(model: string): OpenCodeGoProtocol {
    const slug = openCodeGoSlug(model);
    if (!slug) return "chat";
    const vendor = openCodeGoVendor(slug);
    return openCodeGoProtocol(slug) ??
        (vendor ? OPENCODE_GO_VENDOR_PROTOCOLS[vendor] : undefined) ?? "chat";
}

// Upstream vendors behind the OpenCode Go subscription. The leading identifier
// letters select a vendor, so newly published versions group automatically;
// unseen vendors fall back to a title-cased token.
const OPENCODE_GO_VENDOR_LABELS: Record<string, string> = {
    glm: "GLM", kimi: "Kimi", qwen: "Qwen", deepseek: "DeepSeek", minimax: "MiniMax",
    mimo: "MiMo", hy: "Hunyuan", grok: "Grok", gpt: "GPT", muse: "Muse",
    omen: "Omen", longcat: "LongCat",
};

/** Picker subtab label for aggregator lanes; first-party lanes return undefined. */
export function familyForModel(model: string): string | undefined {
    if (compositeProvider(model) !== "opencode-go" && !model.startsWith(OPENCODE_GO_MODEL_PREFIX)) {
        return undefined;
    }
    const slug = openCodeGoModelSlug(model);
    const vendor = slug && /^[a-z]+/u.exec(slug)?.[0];
    if (!vendor) return undefined;
    return OPENCODE_GO_VENDOR_LABELS[vendor] ??
        `${vendor[0].toUpperCase()}${vendor.slice(1)}`;
}

/** All currently exposed Beaver models accept images; unknown future models fail closed. */
export function modelSupportsImageInput(model: string): boolean {
    if (model.startsWith("configured:")) return getConfiguredModel(model)?.imageInput ?? false;
    if (model.startsWith(OPENCODE_GO_MODEL_PREFIX) || compositeProvider(model) === "opencode-go") {
        return openCodeGoModelSlug(model) === "deepseek-v4-flash-vision-exp";
    }
    const discoveredImage = catalogMetadataFor(model)?.imageInput;
    if (typeof discoveredImage === "boolean") return discoveredImage;
    const native = modelForProvider(model);
    if (native.startsWith("deepseek-")) return false;
    // Experiment transports carry text only.
    if (model.startsWith(CLAUDE_P_MODEL_PREFIX)) return false;
    if (model.startsWith(OLLAMA_MODEL_PREFIX)) return false;
    return model.startsWith(CODEX_MODEL_PREFIX) || ALL_MODELS.has(model) || ALL_MODELS.has(native);
}
