import type { Provider } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = ["gpt-5.5", "gpt-5.4"] as const;
export const DEEPSEEK_MAIN_MODELS = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
] as const;
export const META_MAIN_MODELS = ["meta/muse-spark-1.1"] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.4"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-lite"] as const;
export const CODEX_MAIN_MODELS = ["codex-exec"] as const;
export const CODEX_MODEL_PREFIX = "codex:";

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
    ...DEEPSEEK_MAIN_MODELS,
    ...META_MAIN_MODELS,
    ...CODEX_MAIN_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model === "codex-exec" || model.startsWith(CODEX_MODEL_PREFIX)) {
        return "codex";
    }
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    if (model.startsWith("deepseek-")) return "deepseek";
    if (model.startsWith("meta/")) return "openrouter";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && (id === "codex-exec" || id.startsWith(CODEX_MODEL_PREFIX))) {
        return id;
    }
    if (id && ALL_MODELS.has(id)) return id;
    return fallback;
}

export function codexModelSlug(model: string): string | null {
    if (!model.startsWith(CODEX_MODEL_PREFIX)) return null;
    const slug = model.slice(CODEX_MODEL_PREFIX.length).trim();
    return slug || null;
}

/** All currently exposed Mike models accept images; unknown future models fail closed. */
export function modelSupportsImageInput(model: string): boolean {
    if (model.startsWith("deepseek-")) return false;
    return (
        model === "codex-exec" ||
        model.startsWith(CODEX_MODEL_PREFIX) ||
        ALL_MODELS.has(model)
    );
}
