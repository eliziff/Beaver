import { StrictMode, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AssistantSessionState } from "@/app/lib/assistantSession";
import { TRChatPanel } from "./TRChatPanel";

const api = vi.hoisted(() => ({ streamChat: vi.fn(), getChat: vi.fn(), loadChats: vi.fn(), renameChat: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/app/lib/api/chat", async (original) => ({ ...await original<typeof import("@/app/lib/api/chat")>(),
  streamChat: api.streamChat, getChat: api.getChat, listChats: async () => [], generateChatTitle: async () => ({ title: "Research" }) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: () => ({ profile: null }) }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({ useChatHistoryContext: () => ({ loadChats: api.loadChats, renameChat: api.renameChat }) }));
vi.mock("../assistant/ChatView", () => ({ ChatView: ({ session }: { session: AssistantSessionState }) =>
  <div>{session.messages.map((message, index) => <p key={index}>{message.role === "user" ? message.content
    : message.blocks.map(({ text }) => text).join("\n")}</p>)}{session.run && <p role="status">Running</p>}</div> }));

it("shows the arrangement intent as one ordinary turn and refreshes the table when it completes", async () => {
  let finish!: (response: Response) => void;
  api.streamChat.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  api.getChat.mockResolvedValue({ chat: { id: "arrangement-chat", transcript_version: 2 }, messages: [] });
  function Example() {
    const [intent, setIntent] = useState<string | undefined>("Arrange the existing research"), [refreshed, setRefreshed] = useState(false);
    return <><TRChatPanel reviewId="review" initialMessage={intent} onInitialMessageSent={() => setIntent(undefined)}
      onChatIdChange={vi.fn()} onCitationClick={vi.fn()} onClose={vi.fn()} onUpdated={() => setRefreshed(true)} />
      {refreshed && <p>Table refreshed</p>}</>;
  }
  const { rerender } = render(<StrictMode><Example /></StrictMode>);
  expect(await screen.findByText("Arrange the existing research")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Running");
  rerender(<StrictMode><Example /></StrictMode>);
  await act(async () => finish(new Response([
    'data: {"type":"chat_id","chatId":"arrangement-chat","transcriptVersion":1}\n\n',
    'data: {"type":"content_final","text":"Table arranged","citations":[]}\n\n',
    'data: {"type":"transcript_version","transcriptVersion":2}\n\n', "data: [DONE]\n\n",
  ].join(""), { headers: { "Content-Type": "text/event-stream" } })));
  expect(await screen.findByText("Table arranged")).toBeVisible();
  expect(screen.getByText("Table refreshed")).toBeVisible();
  await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));
  expect(api.streamChat.mock.calls[0][0]).toMatchObject({ tabular_review_id: "review" });
});
