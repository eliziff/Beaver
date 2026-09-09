import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatFindingActions } from "./ChatFindingActions";
import type { ResearchFile } from "@/app/lib/researchFiles";
const api = vi.hoisted(() => ({ getWorkspaceFindings: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", () => api);
it("offers a grounded answer without a filing control", async () => {
  const file = { document: { id: "workspace" }, versionId: "v1", workingRevision: 3,
    state: { labels: { honesty: { id: "honesty", name: "Honesty", scope: "source", parentId: null } } } } as unknown as ResearchFile,
    reference = { kind: "answer", chatId: "chat", answerId: "message:answer:0", resource: "source://case", claimIndices: [1] },
    useAnswer = vi.fn().mockResolvedValue(undefined);
  api.getWorkspaceFindings.mockResolvedValue({ items: [{ reference, answer: { claims: [{ text: "The duty applies." }] } }], next_offset: null });
  render(<ChatFindingActions file={file} chatId="chat" messageId="message" onUseAnswer={useAnswer} />);
  await screen.findByRole("button", { name: "Use as answer" });
  expect(screen.queryByText(/^File under/)).toBeNull();
  expect(screen.queryByRole("combobox", { name: "File finding under" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use as answer" }));
  await waitFor(() => expect(useAnswer).toHaveBeenCalledOnce());
});
