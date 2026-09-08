import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatFindingActions } from "./ChatFindingActions";
import type { ResearchFile } from "@/app/lib/researchFiles";
const api = vi.hoisted(() => ({ getWorkspaceFindings: vi.fn(), saveWorkspaceFindings: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", () => api);
it("files the chosen grounded finding with the current workspace revision", async () => {
  const file = { document: { id: "workspace" }, versionId: "v1", workingRevision: 3,
    state: { labels: { honesty: { id: "honesty", name: "Honesty", scope: "source", parentId: null } } } } as unknown as ResearchFile,
    reference = { kind: "answer", chatId: "chat", answerId: "message:answer:0", resource: "source://case", claimIndices: [1] },
    saved = { ...file, workingRevision: 4 }, accepted = vi.fn(), useAnswer = vi.fn().mockResolvedValue(undefined);
  api.getWorkspaceFindings.mockResolvedValue({ items: [{ reference, answer: { claims: [{ text: "The duty applies." }] } }], next_offset: null });
  api.saveWorkspaceFindings.mockResolvedValue({ file: saved, saved: 1 });
  render(<ChatFindingActions file={file} chatId="chat" messageId="message" onFiled={accepted} onUseAnswer={useAnswer} />);
  fireEvent.click(await screen.findByText("File under…"));
  const choose = screen.getByRole("combobox", { name: "File finding under" });
  expect(api.saveWorkspaceFindings).not.toHaveBeenCalled();
  fireEvent.change(choose, { target: { value: "honesty" } });
  await waitFor(() => expect(accepted).toHaveBeenCalledWith(saved));
  expect(api.saveWorkspaceFindings).toHaveBeenCalledWith("workspace", { references: [reference], typeId: "honesty", versionId: "v1", workingRevision: 3 });
  expect(useAnswer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use as answer" }));
  await waitFor(() => expect(useAnswer).toHaveBeenCalledOnce());
});
