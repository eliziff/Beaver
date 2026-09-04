import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { Tabs } from "./tabs";

it("gives pill filter rails the shared keyboard and selected behavior", () => {
    function Example() {
        const [value, setValue] = useState<"all" | "mine">("all");
        return <TableToolbar items={[{ id: "all", label: "All" },
            { id: "mine", label: "Mine" }]} active={value}
            onChange={setValue} ariaLabel="Project filters" />;
    }
    render(<Example />);
    const all = screen.getByRole("tab", { name: "All" });
    const mine = screen.getByRole("tab", { name: "Mine" });
    expect(screen.getByRole("tablist", { name: "Project filters" })).toBeVisible();
    expect(all).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(mine).toHaveFocus();
    expect(mine).toHaveAttribute("aria-selected", "true");
});

it("keeps an actions-only table toolbar", () => {
    render(<TableToolbar actions={<button type="button">Upload</button>} />);

    const action = screen.getByRole("button", { name: "Upload" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(action.closest("[data-tabs-rail]")).not.toBeNull();
});

it("uses the same tab behavior for closable source tabs", () => {
    const close = vi.fn();
    render(<Tabs value="first" onValueChange={() => undefined}
        options={[{ value: "first", label: "First source", onClose: close,
            closeLabel: "Close First source" },
        { value: "second", label: "Second source" }]}
            ariaLabel="Open sources" variant="dock">
        <p>Source</p>
    </Tabs>);

    fireEvent.click(screen.getByRole("button", { name: "Close First source" }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "First source" }))
        .toHaveAttribute("aria-selected", "true");
});

it("recovers from a removed active tab", () => {
    function Example() {
        const [value, setValue] = useState("removed");
        return <Tabs value={value} onValueChange={setValue}
            options={[{ value: "files", label: "Files" },
                { value: "templates", label: "Templates" }]}
            ariaLabel="Library sections"><p>Library</p></Tabs>;
    }
    render(<Example />);
    expect(screen.getByRole("tab", { name: "Files" }))
        .toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(screen.getByRole("tab", { name: "Templates" }))
        .toHaveAttribute("aria-selected", "true");
});

it("does not reposition a tab rail that already fits", () => {
    function Example() {
        const [value, setValue] = useState("first");
        return <Tabs value={value} onValueChange={setValue}
            options={[{ value: "first", label: "First" }, { value: "second", label: "Second" }]}
            ariaLabel="Stable tabs"><p>Content</p></Tabs>;
    }
    render(<Example />);
    const list = screen.getByRole("tablist", { name: "Stable tabs" });
    Object.defineProperties(list, { scrollWidth: { value: 200 }, clientWidth: { value: 200 } });
    list.scrollLeft = 0;
    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    expect(list.scrollLeft).toBe(0);
});
