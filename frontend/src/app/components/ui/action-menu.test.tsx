import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./action-menu";

describe("ActionMenu", () => {
    it("can run the same action repeatedly without a native picker", () => {
        const onSelect = vi.fn();
        render(
            <ActionMenu label="Actions" items={[{ label: "Download", onSelect }]}>
                Actions
            </ActionMenu>,
        );
        const trigger = screen.getByRole("button", { name: "Actions" });
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
        expect(onSelect).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("supports arrow navigation and Escape with focus restoration", () => {
        render(
            <ActionMenu label="Actions" items={[
                { label: "Rename", onSelect: vi.fn() },
                { label: "Delete", onSelect: vi.fn() },
            ]}>
                Actions
            </ActionMenu>,
        );
        const trigger = screen.getByRole("button", { name: "Actions" });
        fireEvent.click(trigger);
        const rename = screen.getByRole("menuitem", { name: "Rename" });
        const remove = screen.getByRole("menuitem", { name: "Delete" });
        expect(rename).toHaveFocus();
        fireEvent.keyDown(rename, { key: "ArrowDown" });
        expect(remove).toHaveFocus();
        fireEvent.keyDown(remove, { key: "Escape" });
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
