import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiKeyState } from "@/app/lib/beaverApi";
import { ModelPicker, type ModelOption } from "./ModelPicker";

const models: ModelOption[] = [
    { id: "codex:gpt-5.6-terra", label: "GPT-5.6 Terra", group: "Codex" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "DeepSeek" },
    { id: "meta/muse-spark-1.1", label: "Muse Spark 1.1", group: "Meta" },
];

const apiKeys: ApiKeyState = {
    claude: { configured: true, source: "env" },
    gemini: { configured: false, source: null },
    openai: { configured: false, source: null },
    deepseek: { configured: false, source: null },
    openrouter: { configured: false, source: null },
    courtlistener: { configured: false, source: null },
};

describe("ModelPicker", () => {
    it("shows Codex and only API-key-backed providers", async () => {
        render(
            <ModelPicker
                value="codex:gpt-5.6-terra"
                models={models}
                apiKeys={apiKeys}
                onChange={vi.fn()}
            />,
        );
        await userEvent.click(screen.getByRole("combobox"));
        const options = screen.getByRole("listbox", { name: "Models" });

        within(options).getByRole("option", { name: "GPT-5.6 Terra" });
        within(options).getByRole("option", { name: "Claude Sonnet 4.6" });
        expect(within(options).queryByText(/Gemini|DeepSeek|Muse/u)).toBeNull();
        expect(options).not.toHaveTextContent("API key missing");
    });

    it("shows only Codex while API-key status loads", async () => {
        render(
            <ModelPicker
                value="codex:gpt-5.6-terra"
                models={models}
                onChange={vi.fn()}
            />,
        );
        await userEvent.click(screen.getByRole("combobox"));
        expect(
            screen.getAllByRole("option").map((option) => option.textContent),
        ).toEqual(["GPT-5.6 Terra"]);
    });
});
