import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { ResearchWorkspaceHost as WorkspaceHost } from "./ResearchWorkspaceHost";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
function ResearchWorkspaceHost({ file, onChange, restoreLast = true, ...props }: React.ComponentProps<typeof WorkspaceHost> & {
  file: ResearchFile | null; onChange: (file: ResearchFile | null) => void; restoreLast?: boolean }) {
  return <SourcesWorkspaceProvider file={file ?? undefined} onChange={onChange} restoreLast={restoreLast}>
    <WorkspaceHost {...props} /></SourcesWorkspaceProvider>;
}
import { BeaverApiError } from "@/app/lib/api/client";

const api = vi.hoisted(() => ({ getResearchFile: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", () => ({
  getResearchFile: api.getResearchFile
}));
vi.mock("./ResearchFileBar", () => ({ ResearchFileBar: () => <div>Saved sources</div> }));
const file = { document: { id: "research-1" }, state: { labels: {}, sources: {} } } as ResearchFile;

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

it("keeps the collection inline and retains its contents when returning to search", () => {
  const view = render(<ResearchWorkspaceHost embedded inline open onOpenChange={vi.fn()}
    file={file} onChange={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Research collection" })).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const contents = screen.getByText("Saved sources");
  view.rerender(<ResearchWorkspaceHost embedded inline open={false} onOpenChange={vi.fn()}
    file={file} onChange={vi.fn()} />);
  expect(contents).toBeInTheDocument();
  expect(contents).not.toBeVisible();
});

it("restores a remembered file only when requested", async () => {
  localStorage.setItem("beaver.research.current:personal", "research-1");
  api.getResearchFile.mockResolvedValue(file); const onChange = vi.fn();
  const view = render(<ResearchWorkspaceHost embedded={false} open onOpenChange={vi.fn()}
    file={null} onChange={onChange} restoreLast={false} />);
  expect(api.getResearchFile).not.toHaveBeenCalled();
  view.rerender(<ResearchWorkspaceHost embedded={false} open onOpenChange={vi.fn()}
    file={null} onChange={onChange} />);
  await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledWith("research-1"));
  expect(onChange).toHaveBeenCalledWith(file);
});

it("keeps a remembered workspace after a connection failure and retries opening it", async () => {
  localStorage.setItem("beaver.research.current:personal", "research-1");
  api.getResearchFile.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(file);
  const onChange = vi.fn();
  render(<ResearchWorkspaceHost embedded={false} open onOpenChange={vi.fn()}
    file={null} onChange={onChange} />);
  expect(screen.getByRole("status")).toHaveTextContent("Opening workspace");
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(localStorage.getItem("beaver.research.current:personal")).toBe("research-1");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(file));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("forgets a remembered workspace only when it no longer exists", async () => {
  localStorage.setItem("beaver.research.current:personal", "research-1");
  api.getResearchFile.mockRejectedValueOnce(new BeaverApiError({ status: 404, message: "Not found" }));
  render(<ResearchWorkspaceHost embedded={false} open onOpenChange={vi.fn()}
    file={null} onChange={vi.fn()} />);
  await waitFor(() => expect(localStorage.getItem("beaver.research.current:personal")).toBeNull());
  expect(screen.getByText("Saved sources")).toBeVisible();
});
