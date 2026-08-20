import { describe, expect, it } from "vitest";
import {
    CLAUDE_LOW_MODELS,
    CLAUDE_MAIN_MODELS,
    CLAUDE_MID_MODELS,
    DEEPSEEK_MAIN_MODELS,
    DEFAULT_MAIN_MODEL,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
    GEMINI_LOW_MODELS,
    GEMINI_MAIN_MODELS,
    GEMINI_MID_MODELS,
    META_MAIN_MODELS,
    OPENAI_LOW_MODELS,
    OPENAI_MAIN_MODELS,
    OPENAI_MID_MODELS,
    isSupportedModel,
    providerForModel,
    resolveModel,
    resolveRequestedModel,
} from "../llm/models";
import {
    hasNativeCompaction,
    modelContextWindow,
    needsHostCheckpoint,
} from "../llm/contextWindow";

const PROVIDER_CATALOGS: Record<string, string[]> = {
    claude: [
        ...CLAUDE_MAIN_MODELS,
        ...CLAUDE_MID_MODELS,
        ...CLAUDE_LOW_MODELS,
    ],
    gemini: [
        ...GEMINI_MAIN_MODELS,
        ...GEMINI_MID_MODELS,
        ...GEMINI_LOW_MODELS,
    ],
    openai: [
        ...OPENAI_MAIN_MODELS,
        ...OPENAI_MID_MODELS,
        ...OPENAI_LOW_MODELS,
    ],
    deepseek: [...DEEPSEEK_MAIN_MODELS],
    openrouter: [...META_MAIN_MODELS],
};
const CATALOG = Object.values(PROVIDER_CATALOGS).flat();

describe("model catalog", () => {
    it("maps every catalog and provider-shaped id", () => {
        expect(
            Object.fromEntries(
                Object.entries(PROVIDER_CATALOGS).map(
                    ([provider, models]) => [
                        provider,
                        [...new Set(models.map(providerForModel))],
                    ],
                ),
            ),
        ).toEqual({
            claude: ["claude"],
            gemini: ["gemini"],
            openai: ["openai"],
            deepseek: ["deepseek"],
            openrouter: ["openrouter"],
        });
        expect([
            providerForModel("claude-nonexistent"),
            providerForModel("gpt-nonexistent"),
        ]).toEqual(["claude", "openai"]);
    });

    it("rejects ids without a known provider", () => {
        expect(() => providerForModel("llama-3")).toThrow(
            /Unknown model id/u,
        );
        expect(() => providerForModel("")).toThrow(/Unknown model id/u);
    });

    it("accepts catalog models and falls back for empty or unknown ids", () => {
        expect([
            CATALOG.map((model) => resolveModel(model, "fallback-model")),
            resolveModel("gpt-3.5-turbo", DEFAULT_MAIN_MODEL),
            resolveModel(null, DEFAULT_MAIN_MODEL),
            resolveModel(undefined, DEFAULT_TABULAR_MODEL),
            resolveModel("", DEFAULT_TITLE_MODEL),
        ]).toEqual([
            CATALOG,
            DEFAULT_MAIN_MODEL,
            DEFAULT_MAIN_MODEL,
            DEFAULT_TABULAR_MODEL,
            DEFAULT_TITLE_MODEL,
        ]);

        const defaults = [
            DEFAULT_MAIN_MODEL,
            DEFAULT_TITLE_MODEL,
            DEFAULT_TABULAR_MODEL,
        ];
        expect(defaults.map((model) => resolveModel(model, "x"))).toEqual(
            defaults,
        );
        for (const model of defaults) providerForModel(model);
    });

    it("fails an explicit unsupported selection before provider routing", () => {
        expect(resolveRequestedModel(undefined, DEFAULT_MAIN_MODEL)).toBe(
            DEFAULT_MAIN_MODEL,
        );
        expect(resolveRequestedModel("ollama:llama3", DEFAULT_MAIN_MODEL)).toBe(
            "ollama:llama3",
        );
        expect(isSupportedModel("ollama:")).toBe(false);
        expect(() => resolveRequestedModel(
            "gpt-3.5-turbo",
            DEFAULT_MAIN_MODEL,
        )).toThrow(/Unsupported model id/u);
    });

    it("uses native compaction only where the transport can resume it", () => {
        expect(hasNativeCompaction("claude-sonnet-4-6")).toBe(true);
        expect(hasNativeCompaction("claude-haiku-4-5")).toBe(false);
        expect(needsHostCheckpoint("claude-p:claude-sonnet-4-6")).toBe(true);
        expect(needsHostCheckpoint("gemini-3-flash-preview")).toBe(true);
        expect(hasNativeCompaction("codex:gpt-5.6-sol")).toBe(true);
        expect(hasNativeCompaction("gpt-5.5")).toBe(true);
        expect([
            modelContextWindow("claude-sonnet-4-6"),
            modelContextWindow("claude-haiku-4-5"),
            modelContextWindow("gpt-5.5"),
            modelContextWindow("gpt-5.4-lite"),
        ]).toEqual([1_000_000, 200_000, 1_050_000, 400_000]);
    });
});
