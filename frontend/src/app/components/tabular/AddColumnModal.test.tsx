import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AddColumnModal } from "./AddColumnModal";
import { PROMPT_PRESETS } from "./columnPresets";
import { generateTabularColumnPrompt } from "@/app/lib/beaverApi";

vi.mock("@/app/lib/beaverApi", () => ({
    generateTabularColumnPrompt: vi.fn(),
}));

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

it("adds multiple validated columns with consecutive indexes", async () => {
    const onAdd = vi.fn();
    render(
        <AddColumnModal
            open
            existingCount={3}
            onClose={vi.fn()}
            onAdd={onAdd}
        />,
    );

    expect(screen.getByRole("button", { name: "Add columns" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Column title"), {
        target: { value: "First" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
        target: { value: "First prompt" },
    });
    fireEvent.click(
        screen.getByRole("button", { name: "Add another column" }),
    );
    fireEvent.change(screen.getAllByLabelText("Column title")[1], {
        target: { value: "Second" },
    });
    fireEvent.change(screen.getAllByLabelText("Prompt")[1], {
        target: { value: "Second prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add columns" }));

    await waitFor(() =>
        expect(onAdd).toHaveBeenCalledWith([
            {
                index: 3,
                name: "First",
                prompt: "First prompt",
                format: "text",
                tags: undefined,
            },
            {
                index: 4,
                name: "Second",
                prompt: "Second prompt",
                format: "text",
                tags: undefined,
            },
        ]),
    );
});

it("edits tag options and auto-generates a prompt", async () => {
    vi.mocked(generateTabularColumnPrompt).mockResolvedValue({
        prompt: "Generated prompt",
    });
    const onSave = vi.fn();
    render(
        <AddColumnModal
            open
            existingCount={1}
            onClose={vi.fn()}
            onAdd={vi.fn()}
            editingColumn={{
                index: 7,
                name: "Issues",
                prompt: "Old prompt",
                format: "tag",
                tags: ["Existing"],
            }}
            onSave={onSave}
            onDelete={vi.fn()}
        />,
    );

    fireEvent.change(screen.getByPlaceholderText("Add tag…"), {
        target: { value: "New" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), {
        key: "Enter",
    });
    fireEvent.click(
        screen.getByRole("button", { name: "Auto-Generate Prompt" }),
    );
    await waitFor(() =>
        expect(screen.getByLabelText("Prompt")).toHaveValue("Generated prompt"),
    );
    expect(generateTabularColumnPrompt).toHaveBeenCalledWith("Issues", {
        format: "tag",
        tags: ["Existing", "New"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith({
            index: 7,
            name: "Issues",
            prompt: "Generated prompt",
            format: "tag",
            tags: ["Existing", "New"],
        }),
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
});
