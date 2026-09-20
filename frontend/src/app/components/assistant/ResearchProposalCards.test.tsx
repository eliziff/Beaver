import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ResearchProposalCards } from "./ResearchProposalCards";
const api = vi.hoisted(() => ({ getResearchItems: vi.fn(), applyWorkspaceLabels: vi.fn(), proposeWorkspaceLabels: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", () => api);
vi.mock("../legal/SourcesWorkspace", () => ({ useSourcesWorkspace: () => ({ file: { document: { id: "workspace" }, state: { labels: {}, sources: {} } }, refresh: api.refresh }) }));
it("reopens durable revisions and applies the user's edited current draft", async () => {
  const design = { title: "Research", sourceLabels: [{ id: "a", name: "Security", members: [], children: [] }], highlightTypes: [] };
  const make = (id: string, status: string) => ({ kind: "change", value: { id, status, title: id,
    organization: { chatId: "chat", input: { chatId: "chat", repropose: true },
      design, fingerprint: "fingerprint" } } });
  api.getResearchItems.mockResolvedValue({ items: [make("Current", "pending"), make("Earlier", "rejected")], next_cursor: null });
  api.applyWorkspaceLabels.mockResolvedValue({});
  render(<ResearchProposalCards chatId="chat" refreshKey="idle" />);
  expect(await screen.findByText("Earlier · Superseded")).toBeVisible();
  const names = screen.getAllByLabelText("Proposal title");
  fireEvent.change(names[1], { target: { value: "Edited research" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply labels" }));
  await waitFor(() => expect(api.applyWorkspaceLabels).toHaveBeenCalledWith("workspace", {
    chatId: "chat", repropose: true, proposalId: "Current", fingerprint: "fingerprint",
    design: { ...design, title: "Edited research" },
  }));
  expect(api.proposeWorkspaceLabels).not.toHaveBeenCalled();
});
