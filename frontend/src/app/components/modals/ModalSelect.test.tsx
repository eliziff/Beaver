import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { SearchableChoiceModal } from "./ModalSelect";

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
                { value: "appeal", label: "Appeal", description: "Created Sep 2, 2026" },
            ]}
            onChange={onChange}
        />,
    );

    const search = screen.getByRole("searchbox", { name: "Search options" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, {
        target: { value: "appe" },
    });
    expect(screen.getByRole("button", { name: "Appeal. Created Sep 2, 2026" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.keyDown(search, {
        key: "Enter",
    });

    expect(onChange).toHaveBeenCalledWith("appeal");
    expect(onClose).toHaveBeenCalledOnce();
});
