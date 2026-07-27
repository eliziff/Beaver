import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    getCodexModelCatalog,
    type CodexModelCatalog,
} from "@/app/lib/mikeApi";
import { ModelToggle, ReasoningEffortToggle } from "./ModelToggle";

vi.mock("@/app/lib/mikeApi", () => ({
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
            screen.getByRole("button", { name: /GPT 5.6 Terra/ }),
        ).toBeInTheDocument();
    });

    it("shows each canonical model once and never exposes generic Codex local", async () => {
        const user = userEvent.setup();
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
        await screen.findByRole("button", { name: /GPT-5.6-Luna/ });
        await user.click(
            screen.getByRole("button", { name: /GPT-5.6-Luna/ }),
        );
        const menu = screen.getByRole("menu");

        expect(within(menu).getAllByText("GPT-5.6-Luna")).toHaveLength(1);
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
            await screen.findByRole("button", { name: /Cached Luna Label/ }),
        ).toBeInTheDocument();
        await waitFor(() => expect(getCatalogMock).toHaveBeenCalled());
        expect(
            screen.getByRole("button", { name: /Cached Luna Label/ }),
        ).toBeInTheDocument();
    });

    it("exposes both current DeepSeek V4 models in normal chat", async () => {
        const user = userEvent.setup();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle value="deepseek-v4-flash" onChange={vi.fn()} />,
        );

        await user.click(
            screen.getByRole("button", { name: /DeepSeek V4 Flash/ }),
        );
        const menu = screen.getByRole("menu");
        expect(within(menu).getByText("DeepSeek V4 Flash")).toBeInTheDocument();
        expect(within(menu).getByText("DeepSeek V4 Pro")).toBeInTheDocument();
        expect(within(menu).queryByText("deepseek-chat")).not.toBeInTheDocument();
        expect(within(menu).queryByText("deepseek-reasoner")).not.toBeInTheDocument();
    });

    it("exposes Muse Spark through the configured OpenRouter provider", async () => {
        const user = userEvent.setup();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ModelToggle
                value="meta/muse-spark-1.1"
                onChange={vi.fn()}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: /Muse Spark 1.1/ }),
        );
        expect(
            within(screen.getByRole("menu")).getByText("Muse Spark 1.1"),
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
                screen.getByRole("button", {
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

        const trigger = await screen.findByRole("button", {
            name: "Reasoning effort: low",
        });
        await user.click(trigger);
        await user.click(
            await screen.findByRole("menuitem", { name: "max" }),
        );

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
            screen.queryByRole("button", {
                name: /Reasoning effort/,
            }),
        ).not.toBeInTheDocument();
    });

    it("offers only high and max for DeepSeek, defaulting to high", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ReasoningEffortToggle
                model="deepseek-v4-pro"
                onChange={onChange}
            />,
        );

        const trigger = screen.getByRole("button", {
            name: "Reasoning effort: high",
        });
        await user.click(trigger);
        const items = screen.getAllByRole("menuitem").map((item) =>
            item.textContent?.trim(),
        );
        expect(items).toEqual(["high", "max"]);
        expect(onChange).toHaveBeenCalledWith("high");
    });

    it("offers Muse Spark's supported efforts, defaulting to medium", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        getCatalogMock.mockResolvedValue(catalog([]));
        render(
            <ReasoningEffortToggle
                model="meta/muse-spark-1.1"
                onChange={onChange}
            />,
        );

        await user.click(
            screen.getByRole("button", {
                name: "Reasoning effort: medium",
            }),
        );
        expect(
            screen.getAllByRole("menuitem").map((item) =>
                item.textContent?.trim(),
            ),
        ).toEqual(["xhigh", "high", "medium", "low", "minimal"]);
        expect(onChange).toHaveBeenCalledWith("medium");
    });
});
