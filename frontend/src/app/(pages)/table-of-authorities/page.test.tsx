import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getApiAuthorization } from "@/app/lib/beaverApi";
import { TableOfAuthoritiesHost } from "@/app/components/shared/TableOfAuthoritiesHost";

vi.mock("@/app/lib/beaverApi", () => ({ getApiAuthorization: vi.fn() }));
const navigation = vi.hoisted(() => ({ search: "" }));
vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(navigation.search), vi.fn()],
}));

function attempt(frame: HTMLElement) {
  return new URL(frame.getAttribute("src")!, window.location.origin)
    .searchParams.get("attempt") ?? "";
}

function signal(frame: HTMLElement, type: string, value = attempt(frame)) {
  fireEvent(window, new MessageEvent("message", {
    data: { type, attempt: value },
    origin: window.location.origin,
    source: (frame as HTMLIFrameElement).contentWindow,
  }));
}

describe("TableOfAuthoritiesHost", () => {
  beforeEach(() => {
    navigation.search = "";
    vi.mocked(getApiAuthorization).mockResolvedValue("Bearer session-token");
  });

  it("loads the canonical same-origin workspace with valid scope only", async () => {
    const job = "a".repeat(32);
    const project = "08d94a48-ba98-4fcf-9e6f-17df012e180e";
    navigation.search = `?job=${job}&project=${project}`;
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
    const url = new URL(frame.getAttribute("src")!, window.location.origin);
    expect(url.pathname).toBe("/authorities-helper/");
    expect(url.searchParams.get("job")).toBe(job);
    expect(url.searchParams.get("project")).toBe(project);

    view.rerender(<TableOfAuthoritiesHost active enabled />);
    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(frame).toHaveAttribute("src", url.pathname + url.search);
  });

  it("passes API authorization to the trusted workspace and waits for readiness", async () => {
    render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mike:authorities-helper-probe",
        authorization: "Bearer session-token",
      }),
      window.location.origin,
    ));
    expect(frame).toHaveAttribute("tabindex", "-1");
    signal(frame, "mike:authorities-helper-ready");
    expect(frame).toHaveAttribute("tabindex", "0");
  });

  it("retains one ready workspace while navigating away", async () => {
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
    signal(frame, "mike:authorities-helper-ready");
    view.rerender(<TableOfAuthoritiesHost active={false} enabled />);
    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("authorities-host")).toHaveAttribute("inert");
  });

  it("ignores stale attempts and exposes a current boot failure", async () => {
    navigation.search = `?job=${"a".repeat(32)}`;
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
    const oldAttempt = attempt(frame);
    navigation.search = `?job=${"b".repeat(32)}`;
    view.rerender(<TableOfAuthoritiesHost active enabled />);
    await waitFor(() => expect(attempt(frame)).not.toBe(oldAttempt));
    signal(frame, "mike:authorities-helper-ready", oldAttempt);
    expect(frame).toHaveAttribute("tabindex", "-1");
    signal(frame, "mike:authorities-helper-error");
    expect(screen.getByText("Authorities unavailable")).toBeInTheDocument();
  });
});
