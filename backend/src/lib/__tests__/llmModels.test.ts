import { describe, expect, it } from "vitest";
import {
    DEFAULT_MAIN_MODEL,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
    isSupportedModel,
    staticPickerModels,
    openCodeGoProtocol,
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
    claude: ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
    gemini: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"],
    openai: ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-lite"],
    deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
    openrouter: ["meta/muse-spark-1.1"],
};
const CATALOG = Object.values(PROVIDER_CATALOGS).flat();

describe("model catalog", () => {
    it("offers the existing chat and settings models with their own reasoning and protocol", () => {
        const models = staticPickerModels();
        expect(new Set(models.map(model => model.id)).size).toBe(models.length);
        for (const model of models) {
            expect(model.provider).toBe(providerForModel(model.id));
            if (model.defaultReasoningEffort) {
                expect(model.reasoningEfforts).toContain(model.defaultReasoningEffort);
            }
        }
        expect(models.find(model => model.id === "deepseek-v4-flash")).toMatchObject({
            reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" });
        expect(models.find(model => model.id === "meta/muse-spark-1.1")).toMatchObject({
            provider: "openrouter", reasoningEfforts: ["xhigh", "high", "medium", "low", "minimal"] });
        expect(models.find(model => model.id === "muse-spark-1.2-contributor")).toMatchObject({
            provider: "meta", settingsOnly: true, defaultReasoningEffort: "medium" });
        expect(models.every(model => isSupportedModel(model.id))).toBe(true);
    });

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

    it("accepts only OpenCode Go models with a known wire protocol", () => {
        expect([
            openCodeGoProtocol("opencode-go/gpt-5.6-luna"),
            openCodeGoProtocol("opencode-go/glm-5.3"),
            openCodeGoProtocol("opencode-go/qwen3.8-max"),
        ]).toEqual(["responses", "chat", "messages"]);
        expect(providerForModel("opencode-go/glm-5.3")).toBe("opencode-go");
        expect(isSupportedModel("opencode-go/future-model")).toBe(false);
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
