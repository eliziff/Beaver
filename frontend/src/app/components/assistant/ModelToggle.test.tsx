import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    getModelCatalog,
    type ApiKeyState,
    type ModelCatalog,
} from "@/app/lib/beaverApi";
import { useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";
import { resetModelCatalogSession } from "@/app/lib/modelCatalog";
import { ModelEffortToggle, ModelToggle, ReasoningEffortToggle } from "./ModelToggle";

vi.mock("@/app/lib/beaverApi", () => ({
    getModelCatalog: vi.fn(),
}));

const getCatalogMock = vi.mocked(getModelCatalog);
const configuredApiKeys: ApiKeyState = {
    claude: { configured: true, source: "env" },
    gemini: { configured: true, source: "env" },
    openai: { configured: true, source: "env" },
    deepseek: { configured: true, source: "env" },
    openrouter: { configured: true, source: "env" },
    courtlistener: { configured: true, source: "env" },
};

function catalog(
    models: ModelCatalog["models"],
): ModelCatalog {
    return { source: "live", models };
}

function luna(overrides: Partial<ModelCatalog["models"][number]> = {}) {
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
    resetModelCatalogSession();
    getCatalogMock.mockReset();
});

describe("ModelToggle", () => {
    it("advances from model selection to that model's effort choices", async () => {
        const onEffortChange = vi.fn();
        getCatalogMock.mockResolvedValue(catalog([luna()]));
        render(
            <ModelEffortToggle
                model="codex:gpt-5.6-luna"
                effort="medium"
                onModelChange={vi.fn()}
                onEffortChange={onEffortChange}
            />,
        );

        const trigger = await screen.findByRole("button", {
            name: "Model: GPT-5.6-Luna · medium",
        });
        await userEvent.click(trigger);
        await userEvent.click(
            within(screen.getByRole("group", { name: "Models" })).getByRole(
                "button",
                { name: "GPT-5.6-Luna" },
            ),
        );
        const efforts = screen.getByRole("group", { name: "Reasoning effort" });
        expect(within(efforts).queryByRole("searchbox")).not.toBeInTheDocument();
        await userEvent.click(within(efforts).getByRole("button", { name: "Max" }));

        expect(onEffortChange).toHaveBeenCalledWith("max");
    });

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

        screen.getByRole("button", { name: /GPT 5.6 Terra/ });
    });

    it("shows configured desktop Qwen models before the catalog request completes", async () => {
        getCatalogMock.mockResolvedValue({
            source: "unavailable",
            models: [],
        });
        render(
            <ModelToggle value="codex:gpt-5.6-terra" onChange={vi.fn()} />,
        );
        await userEvent.click(screen.getByRole("button", { name: /^Model:/ }));
        const menu = screen.getByRole("group", { name: "Models" });
        within(menu).getByRole("button", {
            name: /Qwen 3.5 2B \(Q4_K_M\)/,
        });
        within(menu).getByRole("button", {
            name: /Qwen 3.5 4B \(Q4_K_M\)/,
        });
        within(menu).getByRole("button", { name: /Qwen 3.5 9B/ });
    });

    it("keeps one fixed control and its selection while options refresh", async () => {
        const user = userEvent.setup();
        let resolveCatalog!: (value: ModelCatalog) => void;
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

        const initial = screen.getByRole("button", {
            name: /GPT 5.6 Terra/,
        });

        resolveCatalog(catalog([luna()]));
        await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
        await user.click(initial);
        await screen.findByRole("button", { name: "GPT-5.6-Luna" });

        expect(
            screen.getByRole("button", {
                name: "Model: GPT 5.6 Terra",
            }),
        ).toBe(initial);
        expect(initial).toHaveTextContent("GPT 5.6 Terra");
    });

    it("shares one catalog request across controls and remounts", async () => {
        let resolveCatalog!: (value: ModelCatalog) => void;
        getCatalogMock.mockReturnValue(
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        );
        const first = render(
            <>
                <ModelToggle
                    value="codex:gpt-5.6-luna"
                    onChange={vi.fn()}
                />
                <ReasoningEffortToggle
                    model="codex:gpt-5.6-luna"
                    value="medium"
                    onChange={vi.fn()}
                />
            </>,
        );

        await waitFor(() => expect(getCatalogMock).toHaveBeenCalledTimes(1));
        resolveCatalog(catalog([luna()]));
        await screen.findByRole("combobox", {
            name: "Reasoning effort: medium",
        });
        first.unmount();

        render(
            <ReasoningEffortToggle
                model="codex:gpt-5.6-luna"
                value="medium"
                onChange={vi.fn()}
            />,
        );
        screen.getByRole("combobox", {
            name: "Reasoning effort: medium",
        });
        expect(getCatalogMock).toHaveBeenCalledTimes(1);
    });

    it("shows only API-supported catalog models", async () => {
        getCatalogMock.mockResolvedValue(
            catalog([
                luna(),
                luna({
                    slug: "gpt-5.3-codex-spark",
                    displayName: "GPT-5.3-Codex-Spark",
                    supportedInApi: false,
                }),
            ]),
        );

        render(
            <ModelToggle
                value="codex:gpt-5.6-luna"
                onChange={vi.fn()}
                apiKeys={configuredApiKeys}
            />,
        );
        const trigger = await screen.findByRole("button", {
            name: /GPT-5.6-Luna/,
        });
        await userEvent.click(trigger);
        const menu = screen.getByRole("group", { name: "Models" });

        expect(
            within(menu).getAllByRole("button", { name: "GPT-5.6-Luna" }),
        ).toHaveLength(1);
        expect(
            within(menu).queryByRole("button", {
                name: "GPT-5.3-Codex-Spark",
            }),
        ).not.toBeInTheDocument();
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
        expect(
            screen.getAllByRole("button", { name: /^Model:/ }),
        ).toHaveLength(1);
        expect(within(menu).queryByText("Codex (local)")).not.toBeInTheDocument();
        expect(within(menu).queryByText("GPT-5.5")).not.toBeInTheDocument();
    });

    it("shows installed desktop Ollama models without an API key", async () => {
        getCatalogMock.mockResolvedValue({
            ...catalog([]),
            ollama: {
                source: "live",
                models: [
                    {
                        name: "qwen3:32b",
                        displayName: "Qwen3 32B",
                        supportsThinking: true,
                    },
                ],
            },
        });
        render(
            <>
                <ModelToggle
                    value="ollama:qwen3:32b"
                    onChange={vi.fn()}
                    apiKeys={configuredApiKeys}
                />
                <ReasoningEffortToggle
                    model="ollama:qwen3:32b"
                    onChange={vi.fn()}
                />
            </>,
        );

        const trigger = await screen.findByRole("button", {
            name: /Qwen3 32B/,
        });
        await userEvent.click(trigger);
        const menu = screen.getByRole("group", { name: "Models" });
        within(menu).getByText("Desktop");
        within(menu).getByRole("button", { name: "Qwen3 32B" });
        expect(
            screen.getByRole("combobox", { name: /Reasoning effort/i }),
        ).toHaveValue("off");
    });

    it("labels configured desktop models offline when the host is unreachable", async () => {
        getCatalogMock.mockResolvedValue({
            ...catalog([]),
            ollama: {
                source: "unavailable",
                models: [
                    {
                        name: "qwen3.5:9b",
                        displayName: "Qwen 3.5 9B",
                        supportsThinking: true,
                    },
                ],
            },
        });
        render(
            <ModelToggle
                value="ollama:qwen3.5:9b"
                onChange={vi.fn()}
                apiKeys={configuredApiKeys}
            />,
        );
        await userEvent.click(
            await screen.findByRole("button", {
                name: /Qwen 3.5 9B — desktop offline/,
            }),
        );
        within(screen.getByRole("group", { name: "Models" })).getByRole(
            "button",
            { name: /Qwen 3.5 9B — desktop offline/ },
        );
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
            await screen.findByRole("button", {
                name: /GPT-5.6-Luna/,
            }),
        );
        await user.click(
            screen.getByRole("button", { name: "Claude Sonnet 4.6" }),
        );

        expect(onChange).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("routes Anthropic subscription choices through claude -p", async () => {
        const onChange = vi.fn();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle
                value="codex:gpt-5.6-terra"
                onChange={onChange}
                apiKeys={configuredApiKeys}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: /GPT 5.6 Terra/ }),
        );
        await userEvent.click(
            screen.getByRole("button", {
                name: "Claude Sonnet 4.6 · subscription",
            }),
        );

        expect(onChange).toHaveBeenCalledWith(
            "claude-p:claude-sonnet-4-6",
        );
    });

    it("uses the last good catalog when refresh is unavailable", async () => {
        window.localStorage.setItem(
            "beaver.modelCatalog.v1",
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

        await screen.findByRole("button", {
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

        const trigger = screen.getByRole("button", {
            name: /DeepSeek V4 Flash/,
        });
        await userEvent.click(trigger);
        const menu = screen.getByRole("group", { name: "Models" });
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
            screen.getByRole("button", { name: /Muse Spark 1.1/ }),
        );
        screen.getByRole("button", {
            name: "Muse Spark 1.1 (OpenRouter)",
        });
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

        const trigger = await screen.findByRole("button", {
            name: /GPT-5.6-Luna/,
        });
        await user.click(trigger);
        const choices = screen.getByRole("group", { name: "Models" });
        const search = screen.getByRole("searchbox", {
            name: "Search models",
        });
        await user.type(search, "sonnet");
        screen.getByRole("button", { name: "Claude Sonnet 4.6" });
        expect(
            screen.queryByRole("button", { name: "GPT-5.6-Luna" }),
        ).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(choices).not.toBeInTheDocument();
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
            screen.queryByRole("group", { name: "Models" }),
        ).not.toBeInTheDocument();
    });
});

describe("ReasoningEffortToggle", () => {
    it("preserves the saved effort while a cached catalog hydrates", async () => {
        window.localStorage.setItem(
            "beaver.modelCatalog.v1",
            JSON.stringify({ catalog: catalog([luna()]) }),
        );
        window.localStorage.setItem("beaver.reasoningEffort", "max");
        getCatalogMock.mockResolvedValue(catalog([luna()]));
        function PersistedEffort() {
            const [effort, setEffort] = useSelectedReasoningEffort();
            return (
                <ReasoningEffortToggle
                    model="codex:gpt-5.6-luna"
                    value={effort}
                    onChange={setEffort}
                />
            );
        }

        render(<PersistedEffort />);

        await screen.findByRole("combobox", {
            name: "Reasoning effort: max",
        });
        expect(window.localStorage.getItem("beaver.reasoningEffort")).toBe(
            "max",
        );
    });

    it("keeps a disabled control while Codex capabilities load", async () => {
        let resolveCatalog!: (value: ModelCatalog) => void;
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

    it("offers low, high, and max for DeepSeek, displaying high initially", async () => {
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
        expect(items).toEqual(["low", "high", "max"]);
    });

    it("offers Muse Spark's supported efforts, displaying medium initially", async () => {
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
    });
});
