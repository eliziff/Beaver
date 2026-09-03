import type { FormEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Button } from "./button";

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
});
