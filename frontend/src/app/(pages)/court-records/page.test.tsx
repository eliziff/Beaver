import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import CourtRecordsPage from "./page";

const assistantMock = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("@/app/court-records/CourtRecordsWorkspace", () => ({
  CourtRecordsWorkspace: ({ headerActions, onDraftChange, initialDraftId }: {
    headerActions: ReactNode;
    initialDraftId?: string;
    onDraftChange: (draft: unknown, synced: boolean) => void;
  }) => <section aria-label="Court record builder">
    {headerActions}
    <span>Requested draft: {initialDraftId ?? "none"}</span>
    <button type="button" onClick={() => onDraftChange({ id: "record-1",
      revision: 1, kind: "court-record", projectId: "matter-1", state: {} }, true)}>Open test draft</button>
    <button type="button" onClick={() => onDraftChange({ id: "record-1",
      revision: 1, kind: "court-record", projectId: "matter-1", state: {} }, false)}>Edit test draft</button>
    <button type="button" onClick={() => onDraftChange(undefined, true)}>Close test draft</button>
  </section>,
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: ({ tabs, expanded, onExpandedChange }: {
    tabs: Array<{ content: ReactNode }>;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
  }) => <aside aria-label="Assistant dock" hidden={!expanded}>{tabs[0]?.content}
    {expanded && <button type="button" onClick={() => onExpandedChange(false)}>Close assistant</button>}
  </aside>,
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
  ChatView: ({ sendDisabled }: { sendDisabled?: boolean }) => {
    const [turns, setTurns] = useState(0);
    return <button type="button" disabled={sendDisabled}
      onClick={() => setTurns((count) => count + 1)}>
      Assistant conversation: {turns}
    </button>;
  },
}));

function LocationProbe() {
  return <output aria-label="Location">{useLocation().search}</output>;
}
vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: (options: Record<string, unknown>) => {
    assistantMock.options.push(options);
    return { state: { messages: [] }, actions: {
    handleChat: vi.fn(), cancel: vi.fn(), clearRejectedTurn: vi.fn(),
    retryRejectedTurn: vi.fn(),
    } };
  },
}));

describe("Court Records assistant composition", () => {
  it("opens beside the builder and preserves the conversation when collapsed", async () => {
    render(<MemoryRouter><CourtRecordsPage /><LocationProbe /></MemoryRouter>);
    const assistant = screen.getByRole("button", { name: "Assistant" });
    expect(assistant).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open test draft" }));
    expect(assistant).toBeEnabled();
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("?draft=record-1");
    await userEvent.click(assistant);
    expect(assistantMock.options.at(-1)).toMatchObject({ projectId: "matter-1",
      workProduct: { kind: "court-record", id: "record-1", revision: 1 } });
    expect(screen.getByRole("region", { name: "Court record builder" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Assistant conversation: 0" }));
    expect(screen.getByRole("button", { name: "Assistant conversation: 1" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(screen.getByText("Assistant conversation: 1")).not.toBeVisible();
    expect(screen.getByRole("region", { name: "Court record builder" })).toBeVisible();
    await userEvent.click(assistant);
    expect(screen.getByRole("button", { name: "Assistant conversation: 1" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Edit test draft" }));
    expect(screen.getByRole("button", { name: "Assistant conversation: 1" })).toBeDisabled();
    expect(assistantMock.options.at(-1)).toMatchObject({
      workProduct: { kind: "court-record", id: "record-1", revision: 1 },
    });
    await userEvent.click(screen.getByRole("button", { name: "Close test draft" }));
    expect(screen.getByRole("status", { name: "Location" })).toBeEmptyDOMElement();
    expect(assistant).toBeDisabled();
  });
});
