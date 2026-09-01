import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WorkProductAssistant, useWorkProductAssistantState } from "./WorkProductAssistant";

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
vi.mock("./AssistantDock", () => ({
  AssistantDock: ({ tabs }: { tabs: Array<{ content: React.ReactNode }> }) => tabs[0].content,
}));
vi.mock("./ChatView", () => ({
  ChatView: ({ sendDisabled }: { sendDisabled?: boolean }) =>
    <button type="button" disabled={sendDisabled}>Send</button>,
}));

const product = { id: "record-1", kind: "court-record" as const,
  revision: 2, projectId: null };

it("refreshes only for a newer completed mutation of the active product", () => {
  const onProductUpdated = vi.fn();
  const props = { product, chatId: undefined, onChatIdChange: vi.fn(), onClose: vi.fn(),
    onProductUpdated };
  const { rerender } = render(<WorkProductAssistant {...props} />);

  mocks.messages = [{ role: "assistant", workflowRuns: [
    { status: "complete", work_product: { kind: "court-record", id: "other", revision: 9 } },
    { status: "complete", work_product: { kind: "authorities", id: "record-1", revision: 9 } },
    { status: "running", work_product: { kind: "court-record", id: "record-1", revision: 4 } },
    { status: "complete", work_product: { kind: "court-record", id: "record-1", revision: 3 } },
  ] }];
  rerender(<WorkProductAssistant {...props} />);
  expect(onProductUpdated).toHaveBeenCalledOnce();
  expect(onProductUpdated).toHaveBeenCalledWith(3);

  rerender(<WorkProductAssistant {...props} />);
  expect(onProductUpdated).toHaveBeenCalledOnce();
});

it("keeps drafting available while disabling send until the product is synchronized", () => {
  render(<WorkProductAssistant product={product} synced={false}
    onChatIdChange={vi.fn()} onClose={vi.fn()} onProductUpdated={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("keeps one conversation per work product without assistant-owned draft state", async () => {
  function Harness() {
    const state = useWorkProductAssistantState<typeof product>();
    return <><output aria-label="Chat">{state.chatId ?? "none"}</output>
      <button type="button" onClick={() => state.onProductChange(product, true)}>Record</button>
      <button type="button" onClick={() => state.onProductChange({ ...product, id: "record-2" }, true)}>Other</button>
      <button type="button" onClick={() => state.onChatIdChange(`chat-${state.product?.id}`)}>Connect</button></>;
  }
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("button", { name: "Record" }));
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByRole("status", { name: "Chat" })).toHaveTextContent("chat-record-1");
  await user.click(screen.getByRole("button", { name: "Other" }));
  expect(screen.getByRole("status", { name: "Chat" })).toHaveTextContent("none");
  await user.click(screen.getByRole("button", { name: "Record" }));
  expect(screen.getByRole("status", { name: "Chat" })).toHaveTextContent("chat-record-1");
});
