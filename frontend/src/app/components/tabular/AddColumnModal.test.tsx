import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AddColumnModal } from "./AddColumnModal";
import { PROMPT_PRESETS } from "./columnPresets";

it("applies a searched preset and keeps Escape inside the preset picker", () => {
    const onClose = vi.fn();
    render(
        <AddColumnModal
            open
            existingCount={0}
            onClose={onClose}
            onAdd={vi.fn()}
            editingColumn={{
                index: 0,
                name: "Existing",
                prompt: "Existing prompt",
                format: "tag",
                tags: ["Old tag"],
            }}
            onSave={vi.fn()}
        />,
    );

    fireEvent.click(
        screen.getByRole("button", { name: "Choose column preset" }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(
        PROMPT_PRESETS.length + 1,
    );
    expect(
        screen.getByRole("option", { name: "Custom column" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Search options"), {
        key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Search options")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Column title")).toBeInTheDocument();

    fireEvent.click(
        screen.getByRole("button", { name: "Choose column preset" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search options"), {
        target: { value: "Assignment" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Assignment" }));

    const preset = PROMPT_PRESETS.find(({ name }) => name === "Assignment")!;
    expect(screen.getByLabelText("Column title")).toHaveValue(preset.name);
    expect(screen.getByLabelText("Format")).toHaveTextContent("Yes / No");
    expect(screen.getByLabelText("Prompt")).toHaveValue(preset.prompt);
    expect(screen.queryByText("Old tag")).not.toBeInTheDocument();
});
