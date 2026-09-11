import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkProductAssistant, useWorkProductAssistantState } from "./WorkProductAssistant";
import { WorkProductAssistantPanel } from "./WorkProductAssistantPanel";

const mocks = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  handleChat: vi.fn(),
  listChats: vi.fn(),
}));

vi.mock("@/app/lib/api/chat", () => ({ listChats: mocks.listChats }));

vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: () => ({
    state: { messages: mocks.messages },
    actions: { handleChat: mocks.handleChat, cancel: vi.fn(),
      clearRejectedTurn: vi.fn(), retryRejectedTurn: vi.fn() },
  }),
}));
vi.mock("./AssistantDock", () => ({
  AssistantDock: ({ tabs, expanded }: { tabs: Array<{ content: React.ReactNode }>;
    expanded: boolean }) => <aside aria-label="Assistant dock" hidden={!expanded}>{tabs[0].content}</aside>,
}));
vi.mock("./ConversationView", () => ({
  ConversationView: ({ sendDisabled }: { sendDisabled?: boolean }) =>
    <button type="button" disabled={sendDisabled}>Send</button>,
}));

const product = { id: "record-1", kind: "court-record" as const,
  revision: 2, projectId: null };

beforeEach(() => { mocks.messages = []; mocks.listChats.mockReset().mockResolvedValue([]); });
afterEach(() => vi.unstubAllGlobals());

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

it("keeps drafting available while disabling send until the product is synchronized", () => {
  render(<WorkProductAssistantPanel product={product} synced={false}
    onChatIdChange={vi.fn()} onClose={vi.fn()} onProductUpdated={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("reserves the dock and stays mounted while collapsed", async () => {
  const props = { product, onChatIdChange: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<WorkProductAssistant {...props} expanded={false} />);
  const dock = screen.getByLabelText("Assistant dock");
  expect(dock).toHaveAttribute("hidden");

  rerender(<WorkProductAssistant {...props} expanded />);
  await screen.findByRole("button", { name: "Send" });
  expect(screen.getByLabelText("Assistant dock")).toBe(dock);
  rerender(<WorkProductAssistant {...props} expanded={false} />);
  expect(dock).toHaveAttribute("hidden");
  rerender(<WorkProductAssistant {...props} product={{ ...product, id: "record-2" }} />);
  expect(screen.getByLabelText("Assistant dock")).not.toBe(dock);
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

it("resumes the chat already bound to a reopened draft", async () => {
  mocks.listChats.mockResolvedValue([{ id: "chat-bound", work_product_id: product.id }]);
  function Harness() {
    const state = useWorkProductAssistantState<typeof product>();
    return <><output aria-label="Chat">{state.chatId ?? "none"}</output>
      <button type="button" onClick={() => state.onProductChange(product, true)}>Record</button>
      <button type="button" onClick={() => state.onChatIdChange("chat-live")}>Connect</button></>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByRole("status", { name: "Chat" })).toHaveTextContent("none");

  await user.click(screen.getByRole("button", { name: "Record" }));
  await vi.waitFor(() => expect(screen.getByRole("status", { name: "Chat" }))
    .toHaveTextContent("chat-bound"));
  expect(mocks.listChats).toHaveBeenCalledWith({ work_product_id: product.id, limit: 1 });

  // A live turn's chat id wins over the resumed lookup.
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByRole("status", { name: "Chat" })).toHaveTextContent("chat-live");
});

it("blocks another assistant turn until a tool-updated product has refreshed", async () => {
  function Harness() {
    const state = useWorkProductAssistantState<typeof product>();
    return <><output aria-label="Sync">{String(state.synced)}</output>
      <button onClick={() => state.onProductChange(product, true)}>Open</button>
      <button onClick={() => state.onProductUpdated(3)}>Tool update</button>
      <button onClick={() => state.onProductChange({ ...product, revision: 3 }, true)}>Refresh</button></>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByRole("status", { name: "Sync" })).toHaveTextContent("true");
  await user.click(screen.getByRole("button", { name: "Tool update" }));
  expect(screen.getByRole("status", { name: "Sync" })).toHaveTextContent("false");
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByRole("status", { name: "Sync" })).toHaveTextContent("true");
});

it("emits a fresh product-scoped refresh when the next draft has a lower revision", async () => {
  function Harness() {
    const state = useWorkProductAssistantState<typeof product>();
    return <><output aria-label="Refresh">{JSON.stringify(state.refreshToken)}</output>
      <button onClick={() => state.onProductChange({ ...product, revision: 10 }, true)}>High draft</button>
      <button onClick={() => state.onProductUpdated(11)}>High update</button>
      <button onClick={() => state.onProductChange({ ...product, id: "record-2", revision: 1 }, true)}>Low draft</button>
      <button onClick={() => state.onProductUpdated(2)}>Low update</button></>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "High draft" }));
  await user.click(screen.getByRole("button", { name: "High update" }));
  expect(screen.getByRole("status", { name: "Refresh" })).toHaveTextContent(
    JSON.stringify({ id: "record-1", revision: 11 }));
  await user.click(screen.getByRole("button", { name: "Low draft" }));
  await user.click(screen.getByRole("button", { name: "Low update" }));
  expect(screen.getByRole("status", { name: "Refresh" })).toHaveTextContent(
    JSON.stringify({ id: "record-2", revision: 2 }));
});
