import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createAuthoritiesDraft } from "../../../../backend/src/lib/authoritiesDomain";
import { Sources } from "./AuthoritySources";
import type { AuthoritiesProduct, AuthorityIdentity } from "./types";

const caseSource: AuthorityIdentity = {
  id: "moor", key: "moor", name: "Moor Council v Vale Office", displayName: null,
  kind: "case", citation: "2035 WL 651882", citationFormat: "database",
  source: { kind: "unresolved" }, sourceIdentity: null, evidenceIds: [], locators: [], excluded: false,
};
function view(authority: AuthorityIdentity, outputMode: "book" | "table" = "book") {
  const state = createAuthoritiesDraft({ kind: "manual" });
  state.outputMode = outputMode;
  state.authorities = { [authority.id]: authority }; state.authorityOrder = [authority.id];
  const draft: AuthoritiesProduct = { id: "test-book", kind: "authorities", revision: 1,
    title: "Wetland sources", projectId: null, state, outputs: {}, createdAt: "", updatedAt: "" };
  const attach = vi.fn(), pick = vi.fn();
  render(<Sources draft={draft} authorities={[authority]} tabs={new Map([[authority.id, "1"]])}
    occurrences={[]} busy={false} sourceIssues={{}} onAction={vi.fn()} onAdd={vi.fn()}
    onAttach={attach} onPick={pick} onRelink={vi.fn()} onEditIdentity={vi.fn()} />);
  return { attach, pick };
}
it.each(["database", "docket"] as const)("asks for a missing %s decision PDF at Sources", citationFormat => {
  const { pick } = view({ ...caseSource, citationFormat });
  expect(screen.getByRole("img", { name: citationFormat === "database"
    ? /Database citation.*Upload a PDF/u : /Unreported decision.*Upload a PDF/u })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Upload PDF for Moor Council v Vale Office" }));
  expect(pick).toHaveBeenCalledWith("moor");
});
it("satisfies the handoff with an attached PDF", () => {
  view({ ...caseSource, source: { kind: "attached", sources: [{ bindingRole: "decision",
    filename: "Moor decision.pdf", sourceSha256: "b".repeat(64), language: "en",
    origin: "manual", sourceUrl: null }] } });
  expect(screen.queryByRole("img", { name: /citation\. Upload|Unreported decision\. Upload/u })).toBeNull();
});
it("does not require a PDF for a table that needs no copies", () => {
  view(caseSource, "table");
  expect(screen.queryByRole("img", { name: /citation\. Upload|Unreported decision\. Upload/u })).toBeNull();
});
