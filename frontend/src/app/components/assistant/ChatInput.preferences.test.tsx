import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";
import { MemoryRouter } from "react-router-dom";

vi.mock("./ModelToggle", () => ({
  DEFAULT_MODEL_ID: "old-model",
  ModelEffortToggle: ({ model, effort, onModelChange, onEffortChange }: {
    model: string; effort?: string; onModelChange: (value: string) => void; onEffortChange: (value: string) => void;
  }) => <><button onClick={() => onModelChange("codex:gpt-5.6-sol")}>Model: {model}</button>
    <button onClick={() => onEffortChange("high")}>Effort: {effort}</button></>,
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: null, updateProfile: vi.fn().mockResolvedValue(undefined) }),
}));
afterEach(() => vi.unstubAllGlobals());

it("persists model and effort for an empty composer and restores them without a turn", async () => {
  let saved: unknown;
  const submit = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { saved = JSON.parse(String(init.body)).draft; return Response.json({}); }
    return Response.json({ chat: { id: "preferences-only", draft: null }, messages: [] });
  }));
  const input = <ChatInput draftChatId="preferences-only" initialDraft={null} initialModel="old-model"
    initialReasoningEffort="low" onSubmit={submit} onCancel={vi.fn()} isLoading={false} />;
  const view = render(input, { wrapper: MemoryRouter });
  fireEvent.click(screen.getByRole("button", { name: "Model: old-model" }));
  fireEvent.click(screen.getByRole("button", { name: "Effort: low" }));
  await waitFor(() => expect(saved).toMatchObject({ content: "", model: "codex:gpt-5.6-sol", reasoningEffort: "high" }));
  view.unmount();
  render(input, { wrapper: MemoryRouter });
  expect(screen.getByRole("button", { name: "Model: codex:gpt-5.6-sol" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Effort: high" })).toBeVisible();
  expect(submit).not.toHaveBeenCalled();
});
