import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiKeyState } from "@/app/lib/api/account";
import { ModelPicker, type ModelOption } from "./ModelPicker";

const models: ModelOption[] = [
    { id: "codex:gpt-5.6-terra", label: "GPT-5.6 Terra", group: "OpenAI", family: "GPT",
        modelKey: "openai/gpt-5.6-terra", provider: "codex" },
    { id: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic", family: "Sonnet",
        modelKey: "anthropic/claude-sonnet-4-6", provider: "claude" },
    { id: "openrouter:anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic",
        family: "Sonnet", modelKey: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
    { id: "claude:claude-opus-5", label: "Claude Opus 5", group: "Anthropic", family: "Opus",
        modelKey: "anthropic/claude-opus-5", provider: "claude" },
    { id: "gemini:gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google", family: "Gemini Flash",
        modelKey: "google/gemini-3.5-flash", provider: "gemini" },
];

const apiKeys: ApiKeyState = {
    claude: { configured: true, source: "env" },
    gemini: { configured: false, source: null },
    openai: { configured: false, source: null },
    deepseek: { configured: false, source: null },
    openrouter: { configured: true, source: "env" },
    courtlistener: { configured: false, source: null },
};

describe("ModelPicker", () => {
    it("shows one row per model with an inline provider control", async () => {
        render(<ModelPicker value="claude:claude-sonnet-4-6" models={models}
            apiKeys={apiKeys} onChange={vi.fn()} />);
        await userEvent.click(screen.getByRole("button", { name: "Model: Claude Sonnet 4.6" }));
        const options = screen.getByRole("group", { name: "Models" });

        expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "Sonnet" })).toBeVisible();
        // The model appears once, not once per provider.
        expect(within(options).getAllByText("Claude Sonnet 4.6")).toHaveLength(1);
        const providers = within(options).getByRole("group", { name: "Provider for Claude Sonnet 4.6" });
        expect(within(providers).getByRole("button", { name: "Anthropic" }))
            .toHaveAttribute("aria-pressed", "true");
        expect(within(providers).getByRole("button", { name: "OpenRouter" })).toBeVisible();
        expect(within(options).queryByRole("button", { name: "OpenAI" })).toBeNull();
        // The tier is already in the label; no family subtitle repeats it.
        expect(within(options).queryByText("Sonnet")).toBeNull();
    });

    it("compacts the trigger label to the distinguishing tier", () => {
        render(<ModelPicker value="claude:claude-sonnet-4-6" models={models}
            apiKeys={apiKeys} detail="high" onChange={vi.fn()} />);
        expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent("Sonnet");

        render(<ModelPicker value="codex:gpt-5.6-terra" models={models}
            apiKeys={apiKeys} detail="high" onChange={vi.fn()} />);
        const triggers = screen.getAllByRole("button", { name: /^Model:/ });
        expect(triggers[triggers.length - 1]).toHaveTextContent("Terra");
    });

    it("selects the inference provider the reader clicks", async () => {
        const onChange = vi.fn();
        render(<ModelPicker value="claude:claude-sonnet-4-6" models={models}
            apiKeys={apiKeys} onChange={onChange} />);
        await userEvent.click(screen.getByRole("button", { name: "Model: Claude Sonnet 4.6" }));
        await userEvent.click(within(screen.getByRole("group", { name: "Models" }))
            .getByRole("button", { name: "OpenRouter" }));

        expect(onChange).toHaveBeenCalledWith("openrouter:anthropic/claude-sonnet-4-6");
    });

    it("searches every company, not only the active tab", async () => {
        render(<ModelPicker value="claude:claude-sonnet-4-6" models={models}
            apiKeys={apiKeys} onChange={vi.fn()} />);
        await userEvent.click(screen.getByRole("button", { name: "Model: Claude Sonnet 4.6" }));
        expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");

        await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "GPT-5.6");
        expect(within(screen.getByRole("group", { name: "Models" })).getByText("GPT-5.6 Terra"))
            .toBeVisible();
    });

    it("hides a provider disabled in settings", async () => {
        render(<ModelPicker value="claude:claude-sonnet-4-6" models={models} apiKeys={apiKeys}
            disabledProviders={["openrouter"]} onChange={vi.fn()} />);
        await userEvent.click(screen.getByRole("button", { name: "Model: Claude Sonnet 4.6" }));
        const providers = within(screen.getByRole("group", { name: "Models" }))
            .getByRole("group", { name: "Provider for Claude Sonnet 4.6" });

        expect(within(providers).queryByRole("button", { name: "OpenRouter" })).toBeNull();
        expect(within(providers).getByRole("button", { name: "Anthropic" })).toBeVisible();
    });

    it("skips a provider whose credential is not configured", async () => {
        render(<ModelPicker value="codex:gpt-5.6-terra" models={models}
            apiKeys={{ ...apiKeys, openrouter: { configured: false, source: null } }} onChange={vi.fn()} />);
        await userEvent.click(screen.getByRole("button", { name: "Model: GPT-5.6 Terra" }));
        await userEvent.click(screen.getByRole("tab", { name: "Anthropic" }));

        const providers = within(screen.getByRole("group", { name: "Models" }))
            .getByRole("group", { name: "Provider for Claude Sonnet 4.6" });
        expect(within(providers).getByRole("button", { name: "Anthropic" })).toBeVisible();
        expect(within(providers).queryByRole("button", { name: "OpenRouter" })).toBeNull();
    });
});
