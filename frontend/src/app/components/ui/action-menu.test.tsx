import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./action-menu";

describe("ActionMenu", () => {
    it("repeats actions and keeps current items without remeasuring", () => {
        const onSelect = vi.fn(), current = vi.fn();
        const { rerender } = render(
            <ActionMenu label="Actions" items={[{ label: "Download", onSelect }]}>
                Actions
            </ActionMenu>,
        );
        const trigger = screen.getByRole("button", { name: "Actions" });
        fireEvent.click(trigger);
        expect(screen.getByRole("menu").parentElement).toBe(document.body);
        expect(screen.getByRole("menu")).toHaveAttribute("data-shortcut-layer");
        fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
        expect(onSelect).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
        fireEvent.click(trigger); const measurements = rect.mock.calls.length;
        rerender(<ActionMenu label="Actions" items={[{ label: "Open", onSelect: current }]}>Actions</ActionMenu>);
        expect(rect).toHaveBeenCalledTimes(measurements);
        fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
        expect(current).toHaveBeenCalledOnce(); rect.mockRestore();
    });

    it("supports arrow navigation, Escape, and non-blocking Tab dismissal", () => {
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
        fireEvent.click(trigger);
        expect(fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), { key: "Tab" })).toBe(true);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("stays open for its own scroll and closes when its anchor scrolls", () => {
        render(<ActionMenu label="Actions" items={[{ label: "Open", onSelect: vi.fn() }]}>Actions</ActionMenu>);
        fireEvent.click(screen.getByRole("button", { name: "Actions" }));
        fireEvent.scroll(screen.getByRole("menu"));
        expect(screen.getByRole("menu")).toBeVisible();
        fireEvent.scroll(window);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("keeps actions inside a native dialog", () => {
        const onSelect = vi.fn();
        render(<dialog open><ActionMenu label="Actions" items={[{ label: "Open", onSelect }]}>Actions</ActionMenu></dialog>);

        fireEvent.click(screen.getByRole("button", { name: "Actions" }));
        const menu = screen.getByRole("menu");
        expect(screen.getByRole("dialog")).toContainElement(menu);
        fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
        expect(onSelect).toHaveBeenCalledOnce();
    });

    it("keeps an assistant-dock menu inside its focus boundary", () => {
        render(<aside data-assistant-dock aria-label="Assistant dock">
            <ActionMenu label="Actions" items={[{ label: "Open", onSelect: vi.fn() }]}>Actions</ActionMenu>
        </aside>);
        fireEvent.click(screen.getByRole("button", { name: "Actions" }));
        const dock = screen.getByRole("complementary", { name: "Assistant dock" });
        expect(dock).toContainElement(screen.getByRole("menu"));
        expect(dock).toContainElement(document.activeElement as HTMLElement);
    });
});
