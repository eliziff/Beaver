import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    getCodexModelCatalog,
    type ApiKeyState,
    type CodexModelCatalog,
} from "@/app/lib/beaverApi";
import { ModelToggle, ReasoningEffortToggle } from "./ModelToggle";

vi.mock("@/app/lib/beaverApi", () => ({
    getCodexModelCatalog: vi.fn(),
}));

const getCatalogMock = vi.mocked(getCodexModelCatalog);
const configuredApiKeys: ApiKeyState = {
    claude: { configured: true, source: "env" },
    gemini: { configured: true, source: "env" },
    openai: { configured: true, source: "env" },
    deepseek: { configured: true, source: "env" },
    openrouter: { configured: true, source: "env" },
    courtlistener: { configured: true, source: "env" },
};

function catalog(
    models: CodexModelCatalog["models"],
): CodexModelCatalog {
    return { source: "live", models };
}

function luna(overrides: Partial<CodexModelCatalog["models"][number]> = {}) {
    return {
        slug: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "max" },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    window.localStorage.clear();
    getCatalogMock.mockReset();
});

describe("ModelToggle", () => {
    it("renders a restored dynamic selection before the catalog request completes", () => {
        getCatalogMock.mockResolvedValue({
            source: "unavailable",
            models: [],
        });

        render(
            <ModelToggle
                value="codex:gpt-5.6-terra"
                onChange={vi.fn()}
            />,
        );

        screen.getByRole("combobox", { name: /GPT 5.6 Terra/ });
    });

    it("keeps one fixed control and its selection while options refresh", async () => {
        const user = userEvent.setup();
        let resolveCatalog!: (value: CodexModelCatalog) => void;
        getCatalogMock.mockReturnValue(
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        );
        render(
            <ModelToggle
                value="codex:gpt-5.6-terra"
                onChange={vi.fn()}
            />,
        );

        const initial = screen.getByRole("combobox", {
            name: /GPT 5.6 Terra/,
        });

        resolveCatalog(catalog([luna()]));
        await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
        await user.click(initial);
        await screen.findByRole("option", { name: "GPT-5.6-Luna" });

        expect(
            screen.getByRole("combobox", { name: /GPT 5.6 Terra/ }),
        ).toBe(initial);
        expect(initial).toHaveTextContent("GPT 5.6 Terra");
    });

    it("shows each canonical model once and never exposes generic Codex local", async () => {
        getCatalogMock.mockResolvedValue(
            catalog([
                luna({
                    slug: "codex-auto-review",
                    displayName: "GPT-5.6-Luna",
                }),
                luna(),
                luna({ slug: "GPT-5.6-LUNA" }),
            ]),
        );

        render(
            <ModelToggle
                value="codex:gpt-5.6-luna"
                onChange={vi.fn()}
                apiKeys={configuredApiKeys}
            />,
        );
        const trigger = await screen.findByRole("combobox", {
            name: /GPT-5.6-Luna/,
        });
        await userEvent.click(trigger);
        const menu = screen.getByRole("listbox", { name: "Models" });

        expect(
            within(menu).getAllByRole("option", { name: "GPT-5.6-Luna" }),
        ).toHaveLength(1);
        for (const group of [
            "Anthropic",
            "Google",
            "DeepSeek",
            "Meta",
            "Codex",
        ]) {
            within(menu).getByText(group);
        }
        within(menu).getByText("Claude Fable 5");
        expect(screen.getAllByRole("combobox")).toHaveLength(1);
        expect(within(menu).queryByText("Codex (local)")).not.toBeInTheDocument();
        expect(within(menu).queryByText("GPT-5.5")).not.toBeInTheDocument();
    });

    it("changes provider and model in one grouped control", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        getCatalogMock.mockResolvedValue(catalog([luna()]));
        render(
            <ModelToggle
                value="codex:gpt-5.6-luna"
                onChange={onChange}
                apiKeys={configuredApiKeys}
            />,
        );

        await user.click(
            await screen.findByRole("combobox", {
                name: /GPT-5.6-Luna/,
            }),
        );
        await user.click(
            screen.getByRole("option", { name: "Claude Sonnet 4.6" }),
        );

        expect(onChange).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("uses the last good catalog when refresh is unavailable", async () => {
        window.localStorage.setItem(
            "mike.codexModelCatalog.v1",
            JSON.stringify({
                savedAt: 1,
                catalog: catalog([
                    luna({ displayName: "Cached Luna Label" }),
                ]),
            }),
        );
        getCatalogMock.mockRejectedValue(new Error("offline"));

        render(
            <ModelToggle value="codex:gpt-5.6-luna" onChange={vi.fn()} />,
        );

        await screen.findByRole("combobox", {
            name: /Cached Luna Label/,
        });
        await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
    });

    it("exposes both current DeepSeek V4 models in normal chat", async () => {
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle
                value="deepseek-v4-flash"
                onChange={vi.fn()}
                apiKeys={configuredApiKeys}
            />,
        );

        const trigger = screen.getByRole("combobox", {
            name: /DeepSeek V4 Flash/,
        });
        await userEvent.click(trigger);
        const menu = screen.getByRole("listbox", { name: "Models" });
        within(menu).getByText("DeepSeek V4 Flash");
        within(menu).getByText("DeepSeek V4 Pro");
        expect(menu).not.toHaveTextContent(/deepseek-(chat|reasoner)/u);
    });

    it("exposes Muse Spark through the configured OpenRouter provider", async () => {
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle
                value="meta/muse-spark-1.1"
                onChange={vi.fn()}
                apiKeys={configuredApiKeys}
            />,
        );

        await userEvent.click(
            screen.getByRole("combobox", { name: /Muse Spark 1.1/ }),
        );
        screen.getByRole("option", { name: "Muse Spark 1.1" });
    });

    it("keeps the searchable list bounded with keyboard dismissal", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        getCatalogMock.mockResolvedValue(catalog([luna()]));
        render(
            <ModelToggle
                value="codex:gpt-5.6-luna"
                onChange={onChange}
                apiKeys={configuredApiKeys}
            />,
        );

        const trigger = await screen.findByRole("combobox", {
            name: /GPT-5.6-Luna/,
        });
        await user.click(trigger);
        const listbox = screen.getByRole("listbox", { name: "Models" });
        const search = screen.getByRole("searchbox", {
            name: "Search models",
        });
        await user.type(search, "sonnet");
        screen.getByRole("option", { name: "Claude Sonnet 4.6" });
        expect(
            screen.queryByRole("option", { name: "GPT-5.6-Luna" }),
        ).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(listbox).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();

        await user.click(trigger);
        await user.type(
            screen.getByRole("searchbox", { name: "Search models" }),
            "sonnet",
        );
        await user.keyboard("{ArrowDown}{Enter}");
        expect(onChange).toHaveBeenCalledWith("claude-sonnet-4-6");

        await user.click(trigger);
        await user.click(
            document.querySelector<HTMLElement>("[data-shortcut-layer]")!,
        );
        expect(
            screen.queryByRole("listbox", { name: "Models" }),
        ).not.toBeInTheDocument();
    });
});

describe("ReasoningEffortToggle", () => {
    it("keeps a disabled control while Codex capabilities load", async () => {
        let resolveCatalog!: (value: CodexModelCatalog) => void;
        getCatalogMock.mockReturnValue(
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        );

        render(
            <ReasoningEffortToggle
                model="codex:gpt-5.6-luna"
                value="medium"
                onChange={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("combobox", {
                name: "Reasoning effort unavailable",
            }),
        ).toBeDisabled();
        screen.getByRole("option", { name: "Loading" });

        resolveCatalog(catalog([luna()]));
        await waitFor(() =>
            expect(
                screen.getByRole("combobox", {
                    name: "Reasoning effort: medium",
                }),
            ).toBeInTheDocument(),
        );
    });

    it("uses the selected model's live effort levels, including max", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        getCatalogMock.mockResolvedValue(
            catalog([
                luna({
                    supportedReasoningLevels: [
                        { effort: "low" },
                        { effort: "max" },
                    ],
                }),
            ]),
        );
        render(
            <ReasoningEffortToggle
                model="codex:gpt-5.6-luna"
                value="low"
                onChange={onChange}
            />,
        );

        const trigger = await screen.findByRole("combobox", {
            name: "Reasoning effort: low",
        });
        await user.selectOptions(trigger, "max");

        expect(onChange).toHaveBeenCalledWith("max");
    });

    it("keeps stable geometry when effort is inapplicable", () => {
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ReasoningEffortToggle
                model="claude-sonnet-4-6"
                value="medium"
                onChange={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("combobox", {
                name: "Reasoning effort unavailable",
            }),
        ).toBeDisabled();
        screen.getByRole("option", { name: "Automatic" });
    });

    it("offers only high and max for DeepSeek, defaulting to high", async () => {
        const onChange = vi.fn();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ReasoningEffortToggle
                model="deepseek-v4-pro"
                onChange={onChange}
            />,
        );

        const trigger = screen.getByRole("combobox", {
            name: "Reasoning effort: high",
        });
        const items = within(trigger).getAllByRole("option").map((item) =>
            item.textContent?.trim(),
        );
        expect(items).toEqual(["high", "max"]);
        expect(onChange).toHaveBeenCalledWith("high");
    });

    it("offers Muse Spark's supported efforts, defaulting to medium", async () => {
        const onChange = vi.fn();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ReasoningEffortToggle
                model="meta/muse-spark-1.1"
                onChange={onChange}
            />,
        );

        const select = screen.getByRole("combobox", {
            name: "Reasoning effort: medium",
        });
        expect(
            within(select).getAllByRole("option").map((item) =>
                item.textContent?.trim(),
            ),
        ).toEqual(["xhigh", "high", "medium", "low", "minimal"]);
        expect(onChange).toHaveBeenCalledWith("medium");
    });
});
