import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProjectPageHeader } from "./ProjectPageParts";

it("holds disabled project controls while the project loads", () => {
    render(<ProjectPageHeader project={undefined} search="" isOwner={false}
        onBackToProjects={vi.fn()} onOpenDetails={vi.fn()}
        onDeleteProject={vi.fn()} onSearchChange={vi.fn()}
        onOpenPeople={vi.fn()} />);

    expect(screen.getByRole("searchbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "People with access" }))
        .toBeDisabled();
    expect(screen.getByRole("button", { name: "Actions" })).toBeDisabled();
});

it("shows an absent project without dead project controls", () => {
    render(<ProjectPageHeader project={null} search="" isOwner={false}
        onBackToProjects={vi.fn()} onOpenDetails={vi.fn()}
        onDeleteProject={vi.fn()} onSearchChange={vi.fn()}
        onOpenPeople={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1, name: "Project not found" }))
        .toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "People with access" })).toBeNull();
    expect(screen.queryByRole("button", { name: /details|delete/iu })).toBeNull();
});
