import type { FormEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Button } from "./button";

it("does not submit forms unless requested", () => {
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}>
        <Button>Save</Button>
        <Button type="submit">Submit</Button>
        <Button variant="danger" disabled>Delete</Button>
    </form>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("type", "button");
});
