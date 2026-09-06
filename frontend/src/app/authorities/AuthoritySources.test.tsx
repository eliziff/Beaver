import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sources } from "./AuthoritySources";
import type { AuthoritiesProduct, AuthorityIdentity } from "./types";
const authority = (id: string): AuthorityIdentity => ({ id, key: id, kind: "case", citation: "2024 ONCA 599",
  name: id, displayName: null, evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
  source: { kind: "unresolved" } });
const draft = { state: { stage: "sources", import: { kind: "document" }, outputMode: "book",
  settings: { profileId: "general", sourceMode: "automatic", tabStyle: "numeric" } } } as AuthoritiesProduct;
function Fixture({ pending = false }: { pending?: boolean }) {
  const [items, setItems] = useState([authority("First"), authority("Second")]);
  if (pending) items[0].source = { kind: "pending-canlii", pageUrl: "https://www.canlii.org/en/on/onca/doc/2024/2024onca599/2024onca599.html" } as AuthorityIdentity["source"];
  return <Sources draft={draft} authorities={items} occurrences={[]} busy={false} sourceIssues={{}}
    tabs={new Map(items.map(({ id }, index) => [id, `Tab ${index + 1}`]))}
    onAction={(action) => { if (action.type === "move-authority") setItems((before) => {
      const next = [...before], [item] = next.splice(next.findIndex(({ id }) => id === action.authorityId), 1);
      next.splice(action.toIndex, 0, item); return next;
    }); }} onAdd={vi.fn()} onAttach={vi.fn()} onRelink={vi.fn()} onEditIdentity={vi.fn()} />;
}
describe("fixed authority slots", () => {
  it("moves authorities through fixed slots by keyboard, arrows and drag/drop", async () => {
    render(<Fixture />);
    const slots = () => within(screen.getByRole("list", { name: "Authority tab slots" })).getAllByRole("listitem");
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Second", exact: true }), { key: "ArrowUp", altKey: true });
    expect(within(slots()[0]).getByText("Tab 1")).toBeVisible();
    expect(within(slots()[0]).getByRole("button", { name: "Move Second", exact: true })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Move Second down" }));
    expect(within(slots()[1]).getByRole("button", { name: "Move Second", exact: true })).toBeInTheDocument();
    const dataTransfer = { types: ["application/x-beaver-authority"], getData: () => "Second" };
    fireEvent.drop(slots()[0], { dataTransfer });
    expect(within(slots()[0]).getByRole("button", { name: "Move Second", exact: true })).toHaveFocus();
    expect(within(slots()[1]).getByText("Tab 2")).toBeVisible();
  });
  it("offers an explicit manual CanLII handoff, not a folder watcher or embedded scraper", async () => {
    render(<Fixture pending />);
    await userEvent.click(screen.getByRole("button", { name: "Get from CanLII" }));
    const link = screen.getByRole("link", { name: "Open CanLII" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("button", { name: "Choose downloaded PDF" })).toBeVisible();
    expect(screen.queryByText(/Connect downloads folder/i)).not.toBeInTheDocument();
  });
});
