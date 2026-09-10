import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useWorkProductAssistantState } from "./WorkProductAssistant";
import { WorkProductAssistantPanel } from "./WorkProductAssistantPanel";

const mocks = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  handleChat: vi.fn(),
}));

vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: () => ({
    state: { messages: mocks.messages },
    actions: { handleChat: mocks.handleChat, cancel: vi.fn(),
      clearRejectedTurn: vi.fn(), retryRejectedTurn: vi.fn() },
  }),
}));
vi.mock("./ConversationView", () => ({
  ConversationView: () => null,
}));

const product = { id: "record-1", kind: "court-record" as const,
  revision: 2, projectId: null };

beforeEach(() => { mocks.messages = []; });

it("refreshes only for a newer completed mutation of the active product", () => {
  const onProductUpdated = vi.fn();
  const props = { product, chatId: undefined, onChatIdChange: vi.fn(), onClose: vi.fn(),
    onProductUpdated };
  const { rerender } = render(<WorkProductAssistantPanel {...props} />);

  mocks.messages = [{ role: "assistant", workflowRuns: [
    { status: "complete", work_product: { kind: "court-record", id: "other", revision: 9 } },
    { status: "complete", work_product: { kind: "authorities", id: "record-1", revision: 9 } },
    { status: "running", work_product: { kind: "court-record", id: "record-1", revision: 4 } },
    { status: "complete", work_product: { kind: "court-record", id: "record-1", revision: 3 } },
  ] }];
  rerender(<WorkProductAssistantPanel {...props} />);
  expect(onProductUpdated).toHaveBeenCalledOnce();
  expect(onProductUpdated).toHaveBeenCalledWith(3);

  rerender(<WorkProductAssistantPanel {...props} />);
  expect(onProductUpdated).toHaveBeenCalledOnce();
});

it("keeps one conversation per work product without assistant-owned draft state", () => {
  const { result } = renderHook(() => useWorkProductAssistantState<typeof product>());
  act(() => result.current.onProductChange(product, true));
  act(() => result.current.onChatIdChange("chat-record-1"));
  expect(result.current.chatId).toBe("chat-record-1");
  act(() => result.current.onProductChange({ ...product, id: "record-2" }, true));
  expect(result.current.chatId).toBeUndefined();
  act(() => result.current.onProductChange(product, true));
  expect(result.current.chatId).toBe("chat-record-1");
});

it("blocks another assistant turn until a tool-updated product has refreshed", () => {
  const { result } = renderHook(() => useWorkProductAssistantState<typeof product>());
  act(() => result.current.onProductChange(product, true));
  expect(result.current.synced).toBe(true);
  act(() => result.current.onProductUpdated(3));
  expect(result.current.synced).toBe(false);
  act(() => result.current.onProductChange({ ...product, revision: 3 }, true));
  expect(result.current.synced).toBe(true);
});

it("emits a fresh product-scoped refresh when the next draft has a lower revision", () => {
  const { result } = renderHook(() => useWorkProductAssistantState<typeof product>());
  act(() => result.current.onProductChange({ ...product, revision: 10 }, true));
  act(() => result.current.onProductUpdated(11));
  expect(result.current.refreshToken).toEqual({ id: "record-1", revision: 11, sequence: 1 });
  act(() => result.current.onProductChange({ ...product, id: "record-2", revision: 1 }, true));
  act(() => result.current.onProductUpdated(2));
  expect(result.current.refreshToken).toEqual({ id: "record-2", revision: 2, sequence: 2 });
});
