import type { FormEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Button, buttonClassName } from "./button";

it("keeps the standard and compact button contracts in one primitive", () => {
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}>
        <Button>Save</Button>
        <Button variant="danger" disabled>Delete</Button>
    </form>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("type", "button");
    expect(buttonClassName({ variant: "white", size: "normal" }))
        .toContain("border-gray-300 bg-white");
    expect(buttonClassName({ variant: "black", size: "compact" }))
        .toContain("px-2 py-1 text-xs");
    expect(buttonClassName({ variant: "outline", size: "icon-sm" }))
        .toContain("h-8 w-8 p-0");
});
