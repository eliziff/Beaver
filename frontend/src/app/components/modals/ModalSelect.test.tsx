import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { ModalSelect, SearchableChoiceModal } from "./ModalSelect";

it("renders only supplied native options when the placeholder is disabled", () => {
    const onChange = vi.fn();
    render(
        <ModalSelect id="mode" value="auto" placeholder={null}
            options={[{ value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }]}
            onChange={onChange} />,
    );

    const select = screen.getByRole("combobox");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(select, { target: { value: "manual" } });
    expect(onChange).toHaveBeenCalledWith("manual");
});

it("filters and selects the first matching choice with Enter", async () => {
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

    const search = screen.getByRole("searchbox", { name: "Search options" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, {
        target: { value: "appe" },
    });
    expect(screen.getByRole("button", { name: "Appeal" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.keyDown(search, {
        key: "Enter",
    });

    expect(onChange).toHaveBeenCalledWith("appeal");
    expect(onClose).toHaveBeenCalledOnce();
});
