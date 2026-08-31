import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./search-bar";

describe("SearchBar", () => {
    it("exposes the search and clear controls by name", async () => {
        const onValueChange = vi.fn();
        render(<SearchBar value="appeal" onValueChange={onValueChange}
            aria-label="Search projects" />);

        expect(screen.getByRole("searchbox", { name: "Search projects" })).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
        expect(onValueChange).toHaveBeenCalledWith("");
    });
});
