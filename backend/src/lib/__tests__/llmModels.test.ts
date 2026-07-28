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
    providerForModel,
    resolveModel,
} from "../llm/models";

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
});
