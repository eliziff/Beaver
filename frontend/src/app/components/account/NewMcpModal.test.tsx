import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
    McpConnectorFields,
    McpToolList,
    type McpConnectorDraft,
} from "./NewMcpModal";
import type { McpConnectorSummary } from "@/app/lib/beaverApi";

const draft: McpConnectorDraft = {
    name: "Research",
    serverUrl: "https://example.test/mcp",
    bearerToken: "secret",
    customHeaders: "",
};
const connector = {
    id: "connector-1",
    tools: [
        {
            id: "tool-1",
            title: "Find cases",
            toolName: "find_cases",
            openaiToolName: "connector_find_cases",
            description: "Search reported decisions.",
            enabled: true,
            requiresConfirmation: false,
        },
    ],
} as McpConnectorSummary;

function FieldsHarness({ onClear }: { onClear: () => void }) {
    const [value, setValue] = useState(draft);

    return (
        <McpConnectorFields
            draft={value}
            tokenPlaceholder="Saved token encrypted"
            onClearToken={onClear}
            onDraftChange={setValue}
        />
    );
}

describe("McpConnectorFields", () => {
    it("supports the create and saved-connector field variants", () => {
        const onClear = vi.fn();
        const { rerender } = render(<FieldsHarness onClear={onClear} />);

        const name = screen.getByRole("textbox", { name: "Label" });
        fireEvent.change(name, { target: { value: "Authorities" } });
        expect(name).toHaveValue("Authorities");

        const token = screen.getByLabelText("Bearer token");
        expect(token).toHaveAttribute("type", "password");
        fireEvent.click(screen.getByRole("button", { name: "Show token" }));
        expect(token).toHaveAttribute("type", "text");
        fireEvent.click(screen.getByRole("button", { name: "Clear" }));
        expect(onClear).toHaveBeenCalledOnce();
        expect(
            screen.queryByText("Tokens are stored encrypted."),
        ).not.toBeInTheDocument();

        const advanced = screen.getByText("Advanced").closest("summary");
        fireEvent.click(advanced!);
        expect(advanced?.parentElement).toHaveAttribute("open");
        expect(
            screen.getByPlaceholderText('{"X-API-Key":"secret"}'),
        ).toBeInTheDocument();

        rerender(
            <McpConnectorFields
                draft={draft}
                showTokenNote
                disabled
                onDraftChange={vi.fn()}
            />,
        );
        expect(
            screen.getByText("Tokens are stored encrypted."),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
        expect(screen.getByRole("textbox", { name: "Label" })).toBeDisabled();
    });

    it("shares bounded read-only and editable tool rows", () => {
        const onToolEnabled = vi.fn().mockResolvedValue(undefined);
        const { rerender } = render(<McpToolList connector={connector} />);

        expect(screen.getByText("Search reported decisions.")).toBeVisible();
        expect(screen.getByText("Enabled")).toBeVisible();

        rerender(
            <McpToolList
                connector={connector}
                onToolEnabled={onToolEnabled}
            />,
        );
        fireEvent.click(screen.getByRole("switch", { name: "Find cases" }));
        expect(onToolEnabled).toHaveBeenCalledWith(
            "connector-1",
            "tool-1",
            false,
        );
        expect(
            screen.queryByText("Search reported decisions."),
        ).not.toBeInTheDocument();
    });
});
