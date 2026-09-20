import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyState } from "@/app/lib/api/account";
import { ModelPicker, type ModelOption } from "./ModelPicker";

import { ModelProviderSettings } from "../settings/DisplaySettings";
import { readAssistantPreferences, updateAssistantPreferences } from "./assistantPreferences";

beforeEach(() => window.localStorage.clear());

const models: ModelOption[] = [
    { id: "codex:gpt-5.6-terra", label: "GPT-5.6 Terra", group: "Codex" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "claude-p:claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Claude Code" },
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
        await userEvent.click(
            screen.getByRole("button", { name: "Model: GPT-5.6 Terra" }),
        );
        const options = screen.getByRole("group", { name: "Models" });

        expect(
            within(options).getByRole("button", { name: "GPT-5.6 Terra" }),
        ).toHaveAttribute("aria-pressed", "true");
        await userEvent.click(screen.getByRole("tab", { name: "Anthropic" }));
        within(options).getByRole("button", { name: "Claude Sonnet 4.6" });
        await userEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
        within(options).getByRole("button", { name: "Claude Sonnet 4.6" });
        expect(within(options).queryByRole("button", { name: "GPT-5.6 Terra" })).toBeNull();
        expect(screen.getAllByRole("tab").map((tab) => tab.textContent))
            .toEqual(["Codex", "Anthropic", "Claude Code"]);
    });
});

it("persists provider visibility without changing the selected model or resetting older preferences", async () => {
    const { disabledProviders: _disabled, ...older } = readAssistantPreferences();
    localStorage.setItem("beaver.assistant.preferences", JSON.stringify({ ...older, showAutoMode: true }));
    expect(readAssistantPreferences()).toMatchObject({ showAutoMode: true, disabledProviders: [] });
    const onChange = vi.fn();
    render(<><ModelProviderSettings /><ModelPicker value="claude-sonnet-4-6"
        models={models} apiKeys={apiKeys} onChange={onChange} /></>);
    await userEvent.click(screen.getByRole("switch", { name: "Show Anthropic (Claude) in the model picker" }));
    expect(JSON.parse(localStorage.getItem("beaver.assistant.preferences")!)).toMatchObject({
        showAutoMode: true, disabledProviders: ["claude"],
    });
    await userEvent.click(screen.getByRole("button", { name: "Model: Claude Sonnet 4.6" }));
    expect(screen.queryByRole("tab", { name: "Anthropic" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("switch", { name: "Show Anthropic (Claude) in the model picker" }));
    expect(screen.getByRole("tab", { name: "Anthropic" })).toBeVisible();
    updateAssistantPreferences({ disabledProviders: ["unknown" as never] });
    expect(readAssistantPreferences().disabledProviders).toEqual([]);
});
