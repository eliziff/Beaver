import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
    McpConnectorFields,
    type McpConnectorDraft,
} from "./NewMcpModal";

const draft: McpConnectorDraft = {
    name: "Research",
    serverUrl: "https://example.test/mcp",
    bearerToken: "secret",
    customHeaders: "",
};

function FieldsHarness({ onClear }: { onClear: () => void }) {
    const [value, setValue] = useState(draft);
    const [showToken, setShowToken] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);

    return (
        <McpConnectorFields
            draft={value}
            showToken={showToken}
            showAdvanced={showAdvanced}
            tokenPlaceholder="Saved token encrypted"
            tokenAction={{ label: "Clear", onClick: onClear }}
            onDraftChange={setValue}
            onShowTokenChange={setShowToken}
            onShowAdvancedChange={setShowAdvanced}
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

        const token = screen.getByPlaceholderText("Saved token encrypted");
        expect(token).toHaveAttribute("type", "password");
        fireEvent.click(screen.getByRole("button", { name: "Show token" }));
        expect(token).toHaveAttribute("type", "text");
        fireEvent.click(screen.getByRole("button", { name: "Clear" }));
        expect(onClear).toHaveBeenCalledOnce();
        expect(
            screen.queryByText("Tokens are stored encrypted."),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
        expect(
            screen.getByPlaceholderText('{"X-API-Key":"secret"}'),
        ).toBeInTheDocument();

        rerender(
            <McpConnectorFields
                draft={draft}
                showToken={false}
                showAdvanced={false}
                showTokenNote
                disabled
                onDraftChange={vi.fn()}
                onShowTokenChange={vi.fn()}
                onShowAdvancedChange={vi.fn()}
            />,
        );
        expect(
            screen.getByText("Tokens are stored encrypted."),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
        expect(screen.getByRole("textbox", { name: "Label" })).toBeDisabled();
    });
});
