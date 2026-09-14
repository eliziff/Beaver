import { describe, expect, it } from "vitest";
import { normalizeOpenRouterCatalog } from "../openRouter";

describe("OpenRouter catalog", () => {
    it("lists every chat model by vendor and drops unusable listings", () => {
        const { models, metadata } = normalizeOpenRouterCatalog({ data: [
            { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", created: 1_710_000_000,
                context_length: 128_000, expiration_date: null,
                architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
                supported_parameters: ["tools", "temperature"] },
            { id: "openai/gpt-4o-old", name: "OpenAI: GPT-4o Old", created: 1_700_000_000,
                context_length: 128_000, expiration_date: "2026-01-01", supported_parameters: ["tools"] },
            { id: "acme/embed", name: "Acme: Embed", supported_parameters: ["embeddings"] },
            { id: "acme/vision", name: "Acme: Vision", supported_parameters: ["tools"],
                architecture: { output_modalities: ["image"] } },
            { id: "qwen/qwen3.7-max", name: "Qwen: Qwen3.7 Max", created: 1_720_000_000,
                context_length: 1_000_000, supported_parameters: ["tools"] },
            { id: "meta/muse-spark-1.1", name: "Meta: Muse Spark 1.1", created: 1_730_000_000,
                context_length: 1_048_576,
                architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
                supported_parameters: ["tools", "reasoning"] },
        ] });

        expect(models.map((model) => model.id)).toEqual([
            "meta/muse-spark-1.1", "openai/gpt-4o", "qwen/qwen3.7-max",
        ]);
        expect(models.find((model) => model.id === "meta/muse-spark-1.1"))
            .toMatchObject({ label: "Muse Spark 1.1", group: "OpenRouter", provider: "openrouter" });
        // The tier comes from the id, not the vendor label.
        expect(models.find((model) => model.id === "qwen/qwen3.7-max")?.family).toBeUndefined();
        expect(metadata.find((entry) => entry.id === "openai/gpt-4o"))
            .toEqual({ id: "openai/gpt-4o", contextWindow: 128_000, imageInput: true });
        // The listing did not publish input modalities, so none is claimed.
        expect(metadata.find((entry) => entry.id === "qwen/qwen3.7-max"))
            .toEqual({ id: "qwen/qwen3.7-max", contextWindow: 1_000_000 });
    });

    it.each([undefined, null, {}, { data: "nope" }, { data: [{}, { id: "no-slash" }, { id: "a/b" }] }])(
        "ignores malformed listings: %j", (value) => {
            expect(normalizeOpenRouterCatalog(value)).toEqual({ models: [], metadata: [] });
        });
});
