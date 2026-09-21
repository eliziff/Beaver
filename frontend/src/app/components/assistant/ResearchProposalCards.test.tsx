import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ResearchProposalCards } from "./ResearchProposalCards";
import type { ResearchLabelDesign } from "@/app/lib/api/researchFiles";
const api = vi.hoisted(() => ({ getResearchItems: vi.fn(), applyWorkspaceLabels: vi.fn(), proposeWorkspaceLabels: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", () => api);
vi.mock("../legal/SourcesWorkspace", () => ({ useSourcesWorkspace: () => ({ file: { document: { id: "workspace" }, state: { labels: {}, sources: {} } }, refresh: api.refresh }) }));
vi.mock("../legal/ResearchProposalEditor", () => ({ ResearchProposalEditor: ({ design, onChange }: {
  design: ResearchLabelDesign; onChange: (design: ResearchLabelDesign) => void }) =>
  <input aria-label="Organization name" value={design.title} onChange={(event) => onChange({ ...design, title: event.target.value })} /> }));
it("opens review without writing and applies the edited draft from the modal", async () => {
  const design = { title: "Research", sourceLabels: [{ id: "a", name: "Security", members: [], children: [] }], highlightTypes: [] };
  const make = (id: string, status: string) => ({ kind: "change", value: { id, status, title: id,
    organization: { chatId: "chat", input: { chatId: "chat", repropose: true }, sources: [], items: [], design, fingerprint: "fingerprint" } } });
  api.getResearchItems.mockResolvedValue({ items: [make("Current", "pending"), make("Earlier", "applied")], next_cursor: null });
  api.applyWorkspaceLabels.mockResolvedValue({}); api.refresh.mockResolvedValue(undefined);
  render(<ResearchProposalCards chatId="chat" refreshKey="idle" />);
  const review = await screen.findByRole("button", { name: "Review organization" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Earlier" })).not.toBeInTheDocument();
  fireEvent.click(review);
  expect(api.proposeWorkspaceLabels).not.toHaveBeenCalled();
  expect(api.applyWorkspaceLabels).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Edited research" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply labels" }));
  await waitFor(() => expect(api.applyWorkspaceLabels).toHaveBeenCalledWith("workspace", {
    chatId: "chat", repropose: true, proposalId: "Current", fingerprint: "fingerprint", design: { ...design, title: "Edited research" },
  }));
});
