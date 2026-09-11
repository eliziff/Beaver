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
});
