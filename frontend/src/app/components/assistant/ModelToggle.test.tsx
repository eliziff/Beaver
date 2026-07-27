import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    getCodexModelCatalog,
    type CodexModelCatalog,
} from "@/app/lib/beaverApi";
import { ModelToggle, ReasoningEffortToggle } from "./ModelToggle";

vi.mock("@/app/lib/beaverApi", () => ({
    getCodexModelCatalog: vi.fn(),
}));

const getCatalogMock = vi.mocked(getCodexModelCatalog);

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

        expect(
            screen.getByRole("combobox", { name: /GPT 5.6 Terra/ }),
        ).toBeInTheDocument();
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
            <ModelToggle value="codex:gpt-5.6-luna" onChange={vi.fn()} />,
        );
        const menu = await screen.findByRole("combobox", {
            name: /GPT-5.6-Luna/,
        });

        expect(
            within(menu).getAllByRole("option", { name: "GPT-5.6-Luna" }),
        ).toHaveLength(1);
        expect(within(menu).queryByText("Claude Fable 5")).not.toBeInTheDocument();
        expect(
            screen.getByRole("combobox", {
                name: "Model provider: Codex",
            }),
        ).toBeInTheDocument();
        expect(within(menu).queryByText("Codex (local)")).not.toBeInTheDocument();
        expect(within(menu).queryByText("GPT-5.5")).not.toBeInTheDocument();
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

        expect(
            await screen.findByRole("combobox", {
                name: /Cached Luna Label/,
            }),
        ).toBeInTheDocument();
        await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
        expect(
            screen.getByRole("combobox", { name: /Cached Luna Label/ }),
        ).toBeInTheDocument();
    });

    it("exposes both current DeepSeek V4 models in normal chat", async () => {
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle value="deepseek-v4-flash" onChange={vi.fn()} />,
        );

        const menu = screen.getByRole("combobox", {
            name: /DeepSeek V4 Flash/,
        });
        expect(within(menu).getByText("DeepSeek V4 Flash")).toBeInTheDocument();
        expect(within(menu).getByText("DeepSeek V4 Pro")).toBeInTheDocument();
        expect(within(menu).queryByText("deepseek-chat")).not.toBeInTheDocument();
        expect(within(menu).queryByText("deepseek-reasoner")).not.toBeInTheDocument();
    });

    it("exposes Muse Spark through the configured OpenRouter provider", async () => {
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle
                value="meta/muse-spark-1.1"
                onChange={vi.fn()}
            />,
        );

        expect(
            within(
                screen.getByRole("combobox", { name: /Muse Spark 1.1/ }),
            ).getByRole("option", { name: "Muse Spark 1.1" }),
        ).toBeInTheDocument();
    });
});

describe("ReasoningEffortToggle", () => {
    it("reserves the control width while Codex capabilities load", async () => {
        let resolveCatalog!: (value: CodexModelCatalog) => void;
        getCatalogMock.mockReturnValue(
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        );

        const { container } = render(
            <ReasoningEffortToggle
                model="codex:gpt-5.6-luna"
                value="medium"
                onChange={vi.fn()}
            />,
        );

        expect(
            container.querySelector(".reasoning-effort-toggle"),
        ).toHaveAttribute("aria-hidden", "true");

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

    it("does not show an inapplicable effort control", () => {
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ReasoningEffortToggle
                model="claude-sonnet-4-6"
                value="medium"
                onChange={vi.fn()}
            />,
        );

        expect(
            screen.queryByRole("combobox", {
                name: /Reasoning effort/,
            }),
        ).not.toBeInTheDocument();
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
