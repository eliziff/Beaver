import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LegalResearchLabelsPanel } from "./LegalResearchLabelsPanel";

const nodes = [
    {
        id: "public-law",
        kind: "label",
        name: "Public law",
        color: "#b91c1c",
    },
    {
        id: "administrative-law",
        kind: "label",
        name: "Administrative law",
        color: "#2563eb",
    },
    {
        id: "reasonableness",
        kind: "factor",
        name: "Reasonableness",
        color: "#15803d",
    },
];

const edges = [
    {
        sourceId: "administrative-law",
        targetId: "public-law",
        kind: "parent",
    },
    {
        sourceId: "reasonableness",
        targetId: "administrative-law",
        kind: "parent",
    },
];

describe("LegalResearchLabelsPanel", () => {
    it("shows colored label paths without mixing in other graph nodes", () => {
        render(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={["administrative-law", "reasonableness"]}
                note=""
                onAssignedNodeIdsChange={vi.fn()}
                onNoteChange={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("checkbox", {
                name: "Public law \u203a Administrative law",
            }),
        ).toBeChecked();
        expect(
            screen.getByRole("checkbox", { name: "Public law" }),
        ).not.toBeChecked();
        expect(screen.queryByText("Reasonableness")).not.toBeInTheDocument();
        expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("changes source-to-node assignments with a keyboard-native checkbox", async () => {
        const user = userEvent.setup();
        const onAssignedNodeIdsChange = vi.fn();

        render(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={["public-law", "reasonableness"]}
                note=""
                onAssignedNodeIdsChange={onAssignedNodeIdsChange}
                onNoteChange={vi.fn()}
            />,
        );

        const childLabel = screen.getByRole("checkbox", {
            name: "Public law \u203a Administrative law",
        });
        childLabel.focus();
        await user.keyboard(" ");

        expect(onAssignedNodeIdsChange).toHaveBeenCalledWith([
            "public-law",
            "reasonableness",
            "administrative-law",
        ]);
    });

    it("keeps notes controlled by the parent", () => {
        const onNoteChange = vi.fn();

        render(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={[]}
                note=""
                onAssignedNodeIdsChange={vi.fn()}
                onNoteChange={onNoteChange}
            />,
        );

        fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
            target: { value: "Useful" },
        });

        expect(onNoteChange).toHaveBeenCalledWith("Useful");
    });

    it("switches the active project", async () => {
        const user = userEvent.setup();
        const onActiveProjectIdChange = vi.fn();

        render(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={[]}
                note=""
                onAssignedNodeIdsChange={vi.fn()}
                onNoteChange={vi.fn()}
                projectChoices={[
                    { id: "appeal", name: "Appeal" },
                    { id: "memo", name: "Research memo" },
                ]}
                activeProjectId="appeal"
                onActiveProjectIdChange={onActiveProjectIdChange}
            />,
        );

        await user.click(screen.getByTitle("Appeal"));
        await user.click(
            screen.getByRole("option", { name: "Research memo" }),
        );

        expect(onActiveProjectIdChange).toHaveBeenCalledWith("memo");
    });

    it("creates a child label from the collapsed native form", async () => {
        const user = userEvent.setup();
        const onCreateLabel = vi.fn();

        render(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={[]}
                note=""
                onAssignedNodeIdsChange={vi.fn()}
                onNoteChange={vi.fn()}
                onCreateLabel={onCreateLabel}
            />,
        );

        const summary = screen.getByText("New label");
        const details = summary.closest("details");
        expect(details).not.toHaveAttribute("open");
        await user.click(summary);
        expect(details).toHaveAttribute("open");

        await user.type(
            screen.getByRole("textbox", { name: "Name" }),
            "Judicial review",
        );
        fireEvent.input(screen.getByLabelText("Color"), {
            target: { value: "#7c3aed" },
        });
        await user.click(screen.getByTitle("No parent"));
        await user.click(
            screen.getByRole("option", {
                name: "Public law \u203a Administrative law",
            }),
        );
        await user.click(
            screen.getByRole("button", { name: "Create label" }),
        );

        expect(onCreateLabel).toHaveBeenCalledWith({
            name: "Judicial review",
            color: "#7c3aed",
            parentId: "administrative-law",
        });
    });

    it("saves and exposes the busy state", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        const { rerender } = render(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={[]}
                note=""
                onAssignedNodeIdsChange={vi.fn()}
                onNoteChange={vi.fn()}
                onSave={onSave}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(onSave).toHaveBeenCalledOnce();

        rerender(
            <LegalResearchLabelsPanel
                nodes={nodes}
                edges={edges}
                assignedNodeIds={[]}
                note=""
                onAssignedNodeIdsChange={vi.fn()}
                onNoteChange={vi.fn()}
                onSave={onSave}
                isSaving
            />,
        );

        expect(
            screen.getByRole("button", { name: "Saving\u2026" }),
        ).toBeDisabled();
        expect(screen.getByLabelText("Mark source")).toHaveAttribute(
            "aria-busy",
            "true",
        );
    });
});
