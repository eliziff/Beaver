import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { getModelCatalog } from "@/app/lib/beaverApi";
import AssistantPage from "./page";

vi.mock("@/app/lib/beaverApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/lib/beaverApi")>(),
  getModelCatalog: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "lawyer@example.com" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    saveChat: vi.fn(),
    stagePendingChatMessage: vi.fn(),
  }),
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: () => null,
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
  AddDocumentsModal: () => null,
}));
vi.mock("@/app/components/assistant/AssistantWorkflowModal", () => ({
  AssistantWorkflowModal: () => null,
}));
vi.mock("@/app/components/popups/ApiKeyMissingPopup", () => ({
  ApiKeyMissingPopup: () => null,
}));
vi.mock("@/app/components/popups/WarningPopup", () => ({
  WarningPopup: () => null,
}));

const getCatalog = vi.mocked(getModelCatalog);

beforeEach(() => {
  localStorage.clear();
  getCatalog.mockReset();
  getCatalog.mockResolvedValue({ source: "live", models: [] });
});

it("loads the model catalogue only when the assistant model selector is opened", async () => {
  render(<MemoryRouter><AssistantPage /></MemoryRouter>);
  expect(getCatalog).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /^Model:/u }));

  await waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(1));
});
