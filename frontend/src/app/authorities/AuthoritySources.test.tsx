import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sources } from "./AuthoritySources";
import type { AuthoritiesProduct, AuthorityIdentity } from "./types";
const pageUrl = "https://www.canlii.org/en/on/onca/doc/2024/2024onca599/2024onca599.html";
const authority = (id: string): AuthorityIdentity => ({ id, key: id, kind: "case", citation: "2024 ONCA 599",
  name: id, displayName: null, evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
  source: { kind: "unresolved" } });
const draft = { state: { stage: "sources", import: { kind: "document" }, outputMode: "book",
  settings: { profileId: "general", sourceMode: "automatic", tabStyle: "numeric" } } } as AuthoritiesProduct;
function Fixture({ pending = false }: { pending?: boolean }) {
  const items = [authority("First"), authority("Second")];
  if (pending) items[0].source = { kind: "pending-canlii", authorityKey: "First", pageUrl,
    pdfUrl: pageUrl.replace(/\.html$/u, ".pdf") } as AuthorityIdentity["source"];
  return <Sources draft={draft} authorities={items} occurrences={[]} busy={false} sourceIssues={{}}
    tabs={new Map(items.map(({ id }, index) => [id, `Tab ${index + 1}`]))}
    onAction={vi.fn()} onAdd={vi.fn()} onAttach={vi.fn()} onRelink={vi.fn()} onEditIdentity={vi.fn()} />;
}
describe("fixed authority slots", () => {
  it("shows one compact row per fixed slot with no hand reordering", () => {
    render(<Fixture />);
    const slots = within(screen.getByRole("list", { name: "Authority tab slots" })).getAllByRole("listitem");
    expect(slots).toHaveLength(2);
    expect(within(slots[0]).getByText("Tab 1")).toBeVisible();
    expect(within(slots[1]).getByText("Tab 2")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(document.querySelector("[draggable=true]")).toBeNull();
  });
  it("links straight to the CanLII PDF rather than an in-app handoff", () => {
    render(<Fixture pending />);
    const link = screen.getByRole("link", { name: "CanLII" });
    expect(link).toHaveAttribute("href", pageUrl.replace(/\.html$/u, ".pdf"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
