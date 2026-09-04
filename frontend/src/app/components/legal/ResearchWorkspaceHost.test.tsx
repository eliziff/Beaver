import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import * as api from "@/app/lib/beaverApi";
import { ResearchWorkspaceHost } from "./ResearchWorkspaceHost";

vi.mock("./ResearchFileBar", () => ({ ResearchFileBar: () => <div>Workspace panels
  <button onKeyDown={(event) => event.preventDefault()}>Nested menu</button></div> }));
vi.mock("@/app/lib/beaverApi", () => ({ getResearchFile: vi.fn() }));
beforeEach(() => localStorage.clear());
const file = { document: { id: "research-1" } } as never;

it("renders the embedded workspace above the dock and closes it", () => {
  const close = vi.fn();
  render(<div data-testid="clipping-parent" style={{ overflow: "hidden" }}>
    <ResearchWorkspaceHost embedded open onOpenChange={close} file={file} onChange={vi.fn()} />
  </div>);
  const workspace = screen.getByRole("dialog", { name: "Workspace" });
  expect(workspace.parentElement).toBe(document.body);
  fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
  expect(close).toHaveBeenCalledWith(false);
});

it("leaves Escape to a nested chooser", () => {
  const close = vi.fn();
  render(<ResearchWorkspaceHost embedded open onOpenChange={close} file={file} onChange={vi.fn()} />);
  const workspace = screen.getByRole("dialog", { name: "Workspace" });
  const chooser = document.createElement("dialog"); chooser.open = true;
  const button = document.createElement("button"); chooser.append(button); workspace.append(chooser);
  fireEvent.keyDown(button, { key: "Escape" }); expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("button", { name: "Nested menu" }), { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(workspace, { key: "Escape" }); expect(close).toHaveBeenCalledWith(false);
});

it("uses the shared resizable dock outside embedded Sources", () => {
  render(<ResearchWorkspaceHost embedded={false} open onOpenChange={vi.fn()}
    file={null} onChange={vi.fn()} />);
  expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
  expect(screen.getByText("Workspace panels")).toBeVisible();
});

it("restores the selected personal research document by id", async () => {
  localStorage.setItem("beaver.research.current:personal", "research-1");
  vi.mocked(api.getResearchFile).mockResolvedValue(file as never);
  const onChange = vi.fn();
  render(<ResearchWorkspaceHost embedded={false} open onOpenChange={vi.fn()} file={null} onChange={onChange} />);
  await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledWith("research-1"));
  expect(onChange).toHaveBeenCalledWith(file);
});
