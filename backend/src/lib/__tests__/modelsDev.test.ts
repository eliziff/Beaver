import { afterEach, describe, expect, it } from "vitest";
import {
    catalogModelContextWindow,
    familyForModel,
    isSupportedModel,
    modelSupportsImageInput,
    registerCatalogModels,
} from "../llm/models";
import { mergeCloudCatalog, normalizeModelsDevCatalog } from "../llm/modelsDev";

const chat = {
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
};

const payload = {
    anthropic: { models: {
        "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "claude-sonnet",
            ...chat, release_date: "2026-02-17", modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            limit: { context: 1_000_000 } },
        "claude-opus-4-5": { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", family: "claude-opus",
            ...chat, release_date: "2025-11-24" },
        "claude-opus-4-5-20251101": { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5",
            family: "claude-opus", ...chat, release_date: "2025-11-24" },
        "claude-fable-5-1": { id: "claude-fable-5-1", name: "Claude Fable 5.1", family: "claude-fable",
            ...chat, release_date: "2026-09-01" },
    } },
    google: { models: {
        "gemini-3.5-flash": { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", family: "gemini-flash",
            ...chat, release_date: "2026-02-01", limit: { context: 1_048_576 } },
        "gemma-4-26b": { id: "gemma-4-26b", name: "Gemma", family: "gemma", ...chat, release_date: "2026-01-01" },
    } },
    openai: { models: {
        "gpt-5.6-terra": { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", family: "gpt-terra", ...chat,
            release_date: "2026-07-09", modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_050_000 } },
        "gpt-5-nano": { id: "gpt-5-nano", name: "GPT-5 Nano", family: "gpt-nano", ...chat, release_date: "2025-08-07" },
        "gpt-image-1": { id: "gpt-image-1", name: "GPT Image", tool_call: false,
            modalities: { input: ["text"], output: ["image"] } },
        "text-embedding-3-small": { id: "text-embedding-3-small", name: "Embedding", tool_call: true,
            modalities: { input: ["text"], output: ["text"] } },
    } },
    deepseek: { models: {
        "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "deepseek-thinking", ...chat,
            modalities: { input: ["text"], output: ["text"] },
            reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
            release_date: "2026-01-01", limit: { context: 1_000_000 } },
        "deepseek-flash": { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", family: "deepseek-flash", ...chat,
            release_date: "2026-09-10", modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000 } },
    } },
    // Unsupported transports and aggregators stay out of the first-party overlay.
    meta: { models: { "muse-spark-1.3": { id: "muse-spark-1.3", name: "Muse", ...chat } } },
    openrouter: { models: { "qwen/qwen3.7-max": { id: "qwen/qwen3.7-max", name: "Qwen", ...chat } } },
};

describe("models.dev catalog", () => {
    afterEach(() => registerCatalogModels([]));

    it("keeps routable first-party chat models in tier order, newest first", () => {
        const { models } = normalizeModelsDevCatalog(payload);
        expect(models.map((model) => model.id)).toEqual([
            "claude-fable-5-1", "claude-sonnet-4-6", "claude-opus-4-5",
            "gemini-3.5-flash",
            "gpt-5.6-terra", "gpt-5-nano",
            "deepseek-flash", "deepseek-v4-pro",
        ]);
        expect(models.find((model) => model.id === "claude-fable-5-1")?.family).toBe("Fable");
        expect(models.find((model) => model.id === "claude-sonnet-4-6")?.family).toBe("Sonnet");
        expect(models.find((model) => model.id === "gpt-5.6-terra")?.family).toBe("GPT");
        expect(models.find((model) => model.id === "gpt-5-nano")?.family).toBe("GPT Nano");
        expect(models.find((model) => model.id === "deepseek-v4-pro")?.family).toBe("DeepSeek Pro");
    });

    it("collapses a dated snapshot under the latest alias", () => {
        const { models } = normalizeModelsDevCatalog(payload);
        expect(models.some((model) => model.id === "claude-opus-4-5")).toBe(true);
        expect(models.some((model) => model.id === "claude-opus-4-5-20251101")).toBe(false);
    });

    it("carries reasoning effort and routing metadata from the catalogue", () => {
        const { models, metadata } = normalizeModelsDevCatalog(payload);
        expect(models.find((model) => model.id === "claude-sonnet-4-6")).toMatchObject({
            provider: "claude", reasoningEfforts: ["low", "medium", "high", "max"],
            defaultReasoningEffort: "medium" });
        expect(models.find((model) => model.id === "deepseek-v4-pro")).toMatchObject({
            reasoningEfforts: ["high", "max"], defaultReasoningEffort: "high" });
        expect(metadata.find((entry) => entry.id === "claude-sonnet-4-6"))
            .toEqual({ id: "claude-sonnet-4-6", contextWindow: 1_000_000, imageInput: true });
        expect(metadata.find((entry) => entry.id === "deepseek-v4-pro"))
            .toEqual({ id: "deepseek-v4-pro", contextWindow: 1_000_000, imageInput: false });
    });

    it.each([undefined, null, 42, "text", {}, { anthropic: { models: 7 } }])(
        "ignores a malformed payload: %j", (value) => {
            expect(normalizeModelsDevCatalog(value)).toEqual({ models: [], metadata: [] });
        });

    it("overlays the live catalogue on the pinned seed without duplicating", () => {
        const { models: live } = normalizeModelsDevCatalog(payload);
        const merged = mergeCloudCatalog([
            { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic", provider: "claude",
                settingsOnly: true },
            { id: "muse-spark-1.2", label: "Muse Spark 1.2", group: "Meta", provider: "meta" },
        ], live);
        expect(merged.find((model) => model.id === "claude-sonnet-4-6"))
            .toMatchObject({ family: "Sonnet", settingsOnly: true });
        // Non-first-party groups stay flat.
        expect(merged.find((model) => model.id === "muse-spark-1.2")?.family).toBeUndefined();
        expect(new Set(merged.map((model) => model.id)).size).toBe(merged.length);
    });

    it("widens routing and capability only for registered ids", () => {
        registerCatalogModels([{ id: "gpt-9", contextWindow: 500_000, imageInput: true },
            { id: "claude-sonnet-4-6" }]);
        expect(isSupportedModel("gpt-9")).toBe(true);
        expect(catalogModelContextWindow("gpt-9")).toBe(500_000);
        expect(modelSupportsImageInput("gpt-9")).toBe(true);
        // An entry without image metadata must not shadow the pinned rule.
        expect(modelSupportsImageInput("claude-sonnet-4-6")).toBe(true);
        registerCatalogModels([]);
        expect(isSupportedModel("gpt-9")).toBe(false);
        expect(modelSupportsImageInput("gpt-9")).toBe(false);
    });

    it("groups OpenCode Go subscription models by upstream vendor", () => {
        expect([
            familyForModel("opencode-go/glm-5.3"),
            familyForModel("opencode-go/kimi-k3"),
            familyForModel("opencode-go/qwen3.8-max"),
            familyForModel("opencode-go/deepseek-v4-pro"),
            familyForModel("opencode-go/gpt-5.6-luna"),
            familyForModel("opencode-go/minimax-m3"),
            familyForModel("opencode-go/newvendor-1"),
        ]).toEqual(["GLM", "Kimi", "Qwen", "DeepSeek", "GPT", "MiniMax", "Newvendor"]);
        expect([familyForModel("claude-sonnet-4-6"), familyForModel("gemini-3-flash-preview"),
            familyForModel("opencode-go/")]).toEqual([undefined, undefined, undefined]);
    });
});
