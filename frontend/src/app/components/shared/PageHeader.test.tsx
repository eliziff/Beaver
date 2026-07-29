import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
    it("renders one stable action language for breadcrumbs, search, and new", () => {
        const back = vi.fn();
        const search = vi.fn();
        const create = vi.fn();
        render(
            <PageHeader
                breadcrumbs={[
                    { label: "Projects", onClick: back },
                    { label: "Matter" },
                ]}
                actions={[
                    {
                        type: "search",
                        value: "",
                        onChange: search,
                    },
                    { type: "new", title: "New chat", onClick: create },
                ]}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "brief" },
        });
        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

        expect(back).toHaveBeenCalledOnce();
        expect(search).toHaveBeenCalledWith("brief");
        expect(create).toHaveBeenCalledOnce();
    });
});
