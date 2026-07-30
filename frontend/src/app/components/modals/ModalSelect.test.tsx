import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { SearchableChoiceModal } from "./ModalSelect";

it("filters and selects the first matching choice with Enter", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
        <SearchableChoiceModal
            open
            onClose={onClose}
            title="Choose project"
            value={null}
            options={[
                { value: null, label: "All projects" },
                { value: "appeal", label: "Appeal" },
            ]}
            onChange={onChange}
        />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search options"), {
        target: { value: "appe" },
    });
    const choices = screen.getByRole("group", { name: "Choose project" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(
        screen.queryByRole("option"),
    ).not.toBeInTheDocument();
    expect(
        screen.getByRole("button", { name: "Appeal" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(choices).toContainElement(
        screen.getByRole("button", { name: "Appeal" }),
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Search options"), {
        key: "Enter",
    });

    expect(onChange).toHaveBeenCalledWith("appeal");
    expect(onClose).toHaveBeenCalledOnce();
});
