import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryEditor } from "./MemoryEditor";
const api = vi.hoisted(() => ({ getMemory: vi.fn(), saveMemory: vi.fn(), clearMemory: vi.fn() }));
vi.mock("@/app/lib/api/memory", () => api);
vi.mock("../account/useMfaAction", () => ({ useMfaAction: () => ({
  runMfa: async (work: () => Promise<void>, options: { onError(error: unknown): void }) => {
    try { await work(); } catch (error) { options.onError(error); }
  }, mfaPopup: null,
}) }));
const saved = { scope: "app", ownerId: "u", content: "Use Canadian spelling.", enabled: false, revision: 3, epoch: 2, canEdit: true };
beforeEach(() => { vi.clearAllMocks(); api.getMemory.mockResolvedValue(saved); });
it("saves opt-in and edited text together, retaining the draft if another editor changed memory", async () => {
  render(<MemoryEditor />);
  const editor = await screen.findByRole("textbox", { name: "Memory text" });
  fireEvent.change(editor, { target: { value: "Use numbered paragraphs." } });
  fireEvent.click(screen.getByRole("checkbox"));
  api.saveMemory.mockRejectedValueOnce(new Error("Memory changed. Reload it before saving."));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(editor).toHaveValue("Use numbered paragraphs.");
  expect(api.saveMemory).toHaveBeenCalledWith(undefined, { revision: 3, content: "Use numbered paragraphs.", enabled: true });
  api.saveMemory.mockResolvedValue({ ...saved, content: "Use numbered paragraphs.", enabled: true, revision: 4 });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
});
it("confirms deletion and reflects the server's retained enabled setting", async () => {
  api.getMemory.mockResolvedValue({ ...saved, enabled: true });
  api.clearMemory.mockResolvedValue({ ...saved, content: "", enabled: true, revision: 4 });
  render(<MemoryEditor />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete memory" }));
  expect(api.clearMemory).not.toHaveBeenCalled();
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete memory")!);
  await waitFor(() => expect(api.clearMemory).toHaveBeenCalledWith(undefined, 3));
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("textbox")).toHaveValue("");
});
it("allows viewers to read project memory without offering mutations", async () => {
  api.getMemory.mockResolvedValue({ ...saved, scope: "project", canEdit: false });
  render(<MemoryEditor projectId="project" />);
  expect(await screen.findByRole("textbox")).toHaveAttribute("readonly");
  expect(screen.getByRole("checkbox")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});
it("does not show a late private save response after switching to project memory", async () => {
  let finish!: (value: typeof saved) => void;
  api.saveMemory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<MemoryEditor />);
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "PRIVATE" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  api.getMemory.mockResolvedValue({ ...saved, scope: "project", content: "Project facts" });
  view.rerender(<MemoryEditor projectId="project" />);
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Project facts"));
  finish({ ...saved, content: "PRIVATE" });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Project facts"));
});
