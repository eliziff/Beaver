import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createAuthoritiesDraft } from "../../../../backend/src/lib/authoritiesDomain";
import { Sources } from "./AuthoritySources";
import type { AuthoritiesProduct, AuthorityIdentity, AuthorityOccurrence } from "./types";

function renderSource(...authorities: AuthorityIdentity[]) {
  const state = createAuthoritiesDraft({ kind: "manual" });
  state.outputMode = "book";
  state.authorities = Object.fromEntries(authorities.map((item) => [item.id, item]));
  state.authorityOrder = authorities.map(({ id }) => id);
  const draft: AuthoritiesProduct = { id: "draft", kind: "authorities", revision: 1,
    title: "Book", projectId: null, state, outputs: {}, createdAt: "", updatedAt: "" };
  const retry = vi.fn(), action = vi.fn(), open = vi.fn();
  render(<Sources draft={draft} authorities={authorities} tabs={new Map(authorities.map(({ id }, index) => [id, String(index + 1)]))}
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

it("never shows its own wait as A2AJ's time, and asks again itself once a minute has passed, then less often", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2020, 0, 1, 12) });
  try {
    // A page cannot read the Retry-After A2AJ sends with its limit: the failure names no time.
    const { retry } = renderSource({ ...authority, sourceUrl: undefined, sourceLookupFailure:
      { reason: "rate-limited", retryAfter: null } });
    expect(screen.getByRole("status")).toHaveTextContent("A2AJ is limiting requests, so this authority " +
      "wasn't checked: Example v Example. Beaver will try again in about a minute.");
    expect(screen.getByRole("img", { name: "A2AJ is limiting requests, so this authority wasn't checked. " +
      "Beaver will try again, or upload the PDF." })).toBeVisible();
    expect(screen.queryByText(/Retry after|No PDF attached/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/u })).toBeNull();
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(retry).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith("one");
    // A2AJ still limiting: twice as long before the next request, and never a loop meanwhile.
    expect(screen.getByRole("status")).toHaveTextContent("Beaver will try again in about 2 minutes.");
    act(() => { vi.advanceTimersByTime(118_000); });
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Beaver will try again in about 4 minutes.");
  } finally { vi.useRealTimers(); }
});

it("waits until the time A2AJ named, where its answer could be read", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2020, 0, 1, 12) });
  try {
    const until = Date.now() + 150_000;
    const { retry } = renderSource({ ...authority, sourceUrl: undefined, sourceLookupFailure:
      { reason: "rate-limited", retryAfter: new Date(until).toISOString() } });
    expect(screen.getByRole("status")).toHaveTextContent(`Beaver will try again at ${new Date(until)
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
    act(() => { vi.advanceTimersByTime(149_000); });
    expect(retry).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(retry).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("names A2AJ's limit and a defect of our own for what they are, and tells same-named decisions apart", () => {
  const limited = { reason: "rate-limited", retryAfter: null } as const;
  renderSource({ ...authority, sourceUrl: undefined, sourceLookupFailure: limited },
    { ...authority, id: "two", key: "two", citation: "2026 ABCA 45", sourceUrl: undefined, source: { kind: "resolved" } },
    { ...authority, id: "five", key: "five", name: "Other v Other", citation: "2023 ABKB 5", sourceUrl: undefined,
      sourceLookupFailure: limited },
    { ...authority, id: "three", key: "three", name: "Sample v Sample", citation: "2025 ABKB 9", sourceUrl: undefined,
      sourceLookupFailure: { reason: "defect", retryAfter: null, detail: "x is not a function" } });
  const banner = screen.getByRole("status");
  // A name another authority in the book shares carries its citation; a name no other has does not.
  expect(banner).toHaveTextContent("A2AJ is limiting requests, so 2 authorities weren't checked: " +
    "Example v Example, 2024 ABKB 123; Other v Other.");
  expect(banner).toHaveTextContent("Authorities failed with an error of its own (x is not a function), " +
    "so this authority wasn't checked: Sample v Sample.");
  expect(banner).not.toHaveTextContent(/couldn't be reached|answered with an error/u);
});

it("lists a CanLII ID once, with the court it is cited with", () => {
  const state = createAuthoritiesDraft({ kind: "manual" });
  const item = { ...authority, name: "Marlow v The King", citation: "1961 CanLII 7 (SCC)" };
  state.authorities = { one: item }; state.authorityOrder = ["one"];
  const occurrence = { id: "o", unitId: "u", authorityId: "one", kind: "case", citation: "1961 CanLII 7" } as AuthorityOccurrence;
  render(<Sources draft={{ id: "draft", kind: "authorities", revision: 1, title: "Book", projectId: null, state,
    outputs: {}, createdAt: "", updatedAt: "" }} authorities={[item]} tabs={new Map([["one", "1"]])}
    occurrences={[occurrence]} busy={false} sourceIssues={{}} onAction={vi.fn()} onAdd={vi.fn()}
    onAttach={vi.fn()} onRelink={vi.fn()} onOpenSource={vi.fn()} onEditIdentity={vi.fn()} />);
  expect(screen.getByText("1961 CanLII 7 (SCC)")).toBeVisible();
  expect(screen.queryByText(/1961 CanLII 7;|; 1961 CanLII 7$/u)).toBeNull();
});
