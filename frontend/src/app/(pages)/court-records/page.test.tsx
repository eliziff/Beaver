import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import CourtRecordsPage from "./page";

const assistantMock = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("@/app/court-records/CourtRecordsWorkspace", () => ({
  CourtRecordsWorkspace: ({ headerActions, onDraftChange }: {
    headerActions: ReactNode;
    onDraftChange: (draft: unknown) => void;
  }) => <section aria-label="Court record builder">
    {headerActions}
    <button type="button" onClick={() => onDraftChange({ id: "record-1",
      revision: 1, kind: "court-record", projectId: "matter-1", state: {} })}>Open test draft</button>
  </section>,
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: ({ tabs, onExpandedChange }: {
    tabs: Array<{ content: ReactNode }>;
    onExpandedChange: (expanded: boolean) => void;
  }) => <aside aria-label="Assistant dock">{tabs[0]?.content}
    <button type="button" onClick={() => onExpandedChange(false)}>Close assistant</button>
  </aside>,
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
  ChatView: () => <p>Assistant conversation</p>,
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: (options: Record<string, unknown>) => {
    assistantMock.options.push(options);
    return { state: {}, actions: {
    handleChat: vi.fn(), cancel: vi.fn(), clearRejectedTurn: vi.fn(),
    retryRejectedTurn: vi.fn(),
    } };
  },
}));

describe("Court Records assistant composition", () => {
  it("opens beside the builder and closes only when the user asks", async () => {
    render(<MemoryRouter><CourtRecordsPage /></MemoryRouter>);
    const assistant = screen.getByRole("button", { name: "Assistant" });
    expect(assistant).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open test draft" }));
    expect(assistant).toBeEnabled();
    await userEvent.click(assistant);
    expect(assistantMock.options.at(-1)).toMatchObject({ projectId: "matter-1",
      workProduct: { kind: "court-record", id: "record-1", revision: 1 } });
    expect(screen.getByRole("region", { name: "Court record builder" })).toBeVisible();
    expect(screen.getByText("Assistant conversation")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(screen.queryByText("Assistant conversation")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Court record builder" })).toBeVisible();
  });
});
