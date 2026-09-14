import { describe, expect, it } from "vitest";
import { buildCreatorCatalog } from "../llm/catalog";
import type { PickerModel } from "../llm/models";

const option = (model: Pick<PickerModel, "id" | "label" | "group" | "provider"> & Partial<PickerModel>): PickerModel =>
    ({ ...model });

describe("creator catalog", () => {
    it("merges one model served by several providers and orders companies by commonness", () => {
        const models = buildCreatorCatalog([
            option({ id: "openai:gpt-5.5", label: "GPT-5.5", group: "OpenAI", provider: "openai" }),
            option({ id: "openrouter:anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6",
                group: "OpenRouter", provider: "openrouter", family: "Anthropic" }),
            option({ id: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6",
                group: "Anthropic", provider: "claude", family: "Sonnet" }),
            option({ id: "ollama:qwen3:32b", label: "Qwen 3 32B", group: "Desktop", provider: "ollama" }),
        ]);

        expect(models.map((model) => model.group))
            .toEqual(["Anthropic", "Anthropic", "OpenAI", "Desktop"]);
        const claude = models.filter((model) => model.modelKey === "anthropic/claude-sonnet-4-6");
        expect(claude.map((model) => model.id))
            .toEqual(["claude:claude-sonnet-4-6", "openrouter:anthropic/claude-sonnet-4-6"]);
        // The direct provider's tier names the whole row.
        expect(claude.every((model) => model.family === "Sonnet")).toBe(true);
    });

    it("drops companies outside the default allowlist", () => {
        const models = buildCreatorCatalog([
            option({ id: "openrouter:somevendor/obscure-1", label: "Obscure",
                group: "OpenRouter", provider: "openrouter" }),
        ]);
        expect(models).toEqual([]);
    });
});
