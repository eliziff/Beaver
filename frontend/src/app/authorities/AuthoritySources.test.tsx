import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createAuthoritiesDraft } from "../../../../backend/src/lib/authoritiesDomain";
import { Sources } from "./AuthoritySources";
import type { AuthoritiesProduct, AuthorityIdentity } from "./types";

function renderSource(authority: AuthorityIdentity) {
  const state = createAuthoritiesDraft({ kind: "manual" });
  state.outputMode = "book";
  state.authorities = { [authority.id]: authority }; state.authorityOrder = [authority.id];
  const draft: AuthoritiesProduct = { id: "draft", kind: "authorities", revision: 1,
    title: "Book", projectId: null, state, outputs: {}, createdAt: "", updatedAt: "" };
  const retry = vi.fn(), action = vi.fn(), open = vi.fn();
  render(<Sources draft={draft} authorities={[authority]} tabs={new Map([[authority.id, "1"]])}
    occurrences={[]} busy={false} sourceIssues={{}} onAction={action} onAdd={vi.fn()}
    onAttach={vi.fn()} onRelink={vi.fn()} onOpenSource={open} onRetrySource={retry}
    onEditIdentity={vi.fn()} />);
  return { retry, action, open };
}
const authority: AuthorityIdentity = { id: "one", key: "one", kind: "case", name: "Example v Example",
  displayName: null, citation: "2024 ABKB 123", evidenceIds: [], locators: [], sourceIdentity: null,
  excluded: false, sourceUrl: "https://publisher.example/decision", source: { kind: "unresolved" } };

it("keeps a loaded PDF's View action without an extra source-link action", () => {
  const { open } = renderSource({ ...authority, source: { kind: "attached", sources: [{
    bindingRole: "pdf", sourceSha256: "a".repeat(64), filename: "Decision.pdf", language: "en",
    origin: "manual", sourceUrl: authority.sourceUrl! }] } });
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View PDF for Example v Example" }));
  expect(open).toHaveBeenCalledWith("pdf");
});

it("keeps retry in the options menu and opens the authority's publisher document", () => {
  const { retry } = renderSource({ ...authority, sourceVerificationUrl:
    "https://publisher.example/robocop/captcha/en/query.do?token=server-session" });
  expect(screen.getByRole("link", { name: "Open publisher for Example v Example" }))
    .toHaveAttribute("href", authority.sourceUrl);
  expect(screen.queryByRole("button", { name: "Retry download", exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Options for Example v Example" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Retry download" }));
  expect(retry).toHaveBeenCalledWith("one");
});

it("edits a non-case title separately from its citation", () => {
  const { action } = renderSource({ ...authority, kind: "commentary", name: null,
    citation: "(2020) 58:2 Alta L Rev 123", sourceUrl: undefined });
  fireEvent.click(screen.getByRole("button", { name: "Edit title for (2020) 58:2 Alta L Rev 123" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: 'John Smith, "Judicial Review"' } });
  fireEvent.blur(title);
  expect(action).toHaveBeenCalledWith({ type: "rename-authority", authorityId: "one",
    displayName: 'John Smith, "Judicial Review"' });
  expect(screen.getByText("(2020) 58:2 Alta L Rev 123")).toBeVisible();
});

it("names an authority A2AJ left unchecked and offers retry once its window passes", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2020, 0, 1, 12) });
  try {
    const { retry } = renderSource({ ...authority, sourceUrl: undefined, sourceLookupFailure:
      { reason: "rate-limited", retryAfter: new Date(Date.now() + 90_000).toISOString() } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "A2AJ is limiting requests, so this authority wasn't checked: Example v Example.");
    expect(screen.getByRole("img", { name: /^A2AJ is limiting requests, so this authority wasn't checked\. Retry after/ })).toBeVisible();
    expect(screen.queryByText(/No PDF attached/)).toBeNull();
    const button = screen.getByRole("button", { name: /^Retry after/ });
    expect(button).toBeDisabled();
    act(() => { vi.advanceTimersByTime(91_000); });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("one");
  } finally { vi.useRealTimers(); }
});
