import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
import { OrganizeComposer, organizeRequest } from "./OrganizeComposer";

const file = { document: { id: "workspace", filename: "Research.research.md", project_id: null }, versionId: "v1", workingRevision: 0,
  state: { labels: {}, chats: ["chat"], tables: [], sources: {
    a: { id: "a", reference: { provider: "a2aj", id: "a", kind: "case" }, labelIds: [], passages: { count: 3 } },
    b: { id: "b", reference: { provider: "a2aj", id: "b", kind: "case" }, labelIds: [], passages: { count: 1 } },
  } } } as unknown as ResearchFile;

it("sends the user's own words, or the visible default, with the review clause only when proposing", async () => {
  const onRun = vi.fn(async () => undefined);
  render(<MemoryRouter><SourcesWorkspaceProvider file={file} selection={{ target: "sources", sourceIds: ["a"] }}>
    <OrganizeComposer target="labels" onRun={onRun} /></SourcesWorkspaceProvider></MemoryRouter>);
  expect(screen.getByText("1 source · 3 passages · 1 chat in the current selection")).toBeVisible();
  const input = screen.getByRole("textbox", { name: "Organization request" });
  fireEvent.click(screen.getByRole("button", { name: "Propose" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith(organizeRequest("labels", "", true), true));
  expect(onRun.mock.calls[0][0]).toMatch(/^Organize the sources .* Propose these changes for my review/u);
  fireEvent.change(input, { target: { value: "Group by the standard of review applied" } });
  fireEvent.click(screen.getByRole("button", { name: "Organize" }));
  await waitFor(() => expect(onRun).toHaveBeenLastCalledWith("Group by the standard of review applied", false));
});

it("shows a cancellable status while a run is in progress", () => {
  const onCancel = vi.fn();
  render(<MemoryRouter><SourcesWorkspaceProvider file={file}>
    <OrganizeComposer target="table" running onRun={async () => undefined} onCancel={onCancel} chatHref="/assistant/chat/chat" />
  </SourcesWorkspaceProvider></MemoryRouter>);
  expect(screen.getByRole("status")).toHaveTextContent("Organizing");
  expect(screen.getByRole("link", { name: "Open chat" })).toHaveAttribute("href", "/assistant/chat/chat");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
});
