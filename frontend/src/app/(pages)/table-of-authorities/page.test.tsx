import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import { TableOfAuthoritiesHost } from "@/app/components/shared/TableOfAuthoritiesHost";

vi.mock("@/app/lib/beaverApi", () => ({
  launchTableOfAuthorities: vi.fn(),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

function attemptFor(frame: HTMLElement) {
  return (
    new URL(frame.getAttribute("src")!).searchParams.get("attempt") ?? ""
  );
}

function signal(
  frame: HTMLElement,
  type:
    | "mike:table-of-authorities-ready"
    | "mike:table-of-authorities-error",
  attempt = attemptFor(frame),
  message?: string,
) {
  fireEvent(
    window,
    new MessageEvent("message", {
      data: { type, attempt, message },
      origin: "http://127.0.0.1:8765",
      source: (frame as HTMLIFrameElement).contentWindow,
    }),
  );
}

describe("TableOfAuthoritiesHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigation.search = "";
    sessionStorage.clear();
    history.replaceState(null, "", "/table-of-authorities");
    vi.mocked(launchTableOfAuthorities).mockResolvedValue({
      ok: true,
      url: "http://127.0.0.1:8765/",
      reused: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the local frame before the launch handshake", async () => {
    const first = render(<TableOfAuthoritiesHost active enabled />);
    const firstFrame = screen.getByTitle("Table of Authorities");
    const firstUrl = new URL(firstFrame.getAttribute("src")!);
    expect(firstUrl.searchParams.get("mode")).toBe("mike");
    expect(firstUrl.searchParams.has("session")).toBe(false);
    expect(firstUrl.searchParams.get("attempt")).toBe("");
    expect(firstUrl.searchParams.has("job")).toBe(false);
    await waitFor(() =>
      expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1),
    );

    first.unmount();
    render(<TableOfAuthoritiesHost active enabled />);
    const secondFrame = screen.getByTitle("Table of Authorities");
    expect(secondFrame.getAttribute("src")).toBe(firstFrame.getAttribute("src"));
  });

  it("forwards only a valid explicitly requested durable job", async () => {
    const job = "a".repeat(32);
    navigation.search = `?job=${job}`;
    history.replaceState(null, "", `/table-of-authorities?job=${job}`);

    render(<TableOfAuthoritiesHost active enabled />);

    const frame = screen.getByTitle("Table of Authorities");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("job"),
      ).toBe(job),
    );
    const serviceUrl = new URL(frame.getAttribute("src")!);
    expect(serviceUrl.searchParams.get("job")).toBe(job);
  });

  it("forwards a valid project scope", async () => {
    const project = "08d94a48-ba98-4fcf-9e6f-17df012e180e";
    navigation.search = `?project=${project}`;
    history.replaceState(
      null,
      "",
      `/table-of-authorities?project=${project}`,
    );

    render(<TableOfAuthoritiesHost active enabled />);

    const frame = screen.getByTitle("Table of Authorities");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("project"),
      ).toBe(project),
    );
  });

  it("shows the local embedded surface on the first render", async () => {
    render(<TableOfAuthoritiesHost active enabled />);

    const frame = screen.getByTitle("Table of Authorities");
    expect(frame).toHaveAttribute("tabindex", "0");
    expect(frame).not.toHaveClass("invisible");
    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();

    fireEvent.load(frame);
    signal(frame, "mike:table-of-authorities-ready");

    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();
    expect(frame).not.toHaveClass("invisible");
    expect(frame).toHaveAttribute("tabindex", "0");
  });

  it("replaces the cover with a recoverable boot error", async () => {
    render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");

    signal(
      frame,
      "mike:table-of-authorities-error",
      attemptFor(frame),
      "Settings could not be loaded.",
    );

    expect(screen.getByText("Authorities unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Settings could not be loaded."),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();
    expect(frame).toHaveAttribute("tabindex", "-1");
  });

  it("retains one ready iframe while hidden on sibling routes", async () => {
    const view = render(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    const frame = await screen.findByTitle("Table of Authorities");
    const host = screen.getByTestId("authorities-host");
    expect(host).toHaveClass("opacity-0", "pointer-events-none");
    expect(host).toHaveAttribute("inert");
    expect(frame).toHaveAttribute("aria-hidden", "true");

    signal(frame, "mike:table-of-authorities-ready");
    view.rerender(<TableOfAuthoritiesHost active enabled />);

    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(host).not.toHaveClass("opacity-0");
    expect(host).not.toHaveAttribute("inert");
    expect(frame).toHaveAttribute("aria-hidden", "false");
    expect(frame).toHaveAttribute("tabindex", "0");
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);

    view.rerender(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("tabindex", "-1");
  });

  it("finishes one preloaded boot while hidden without reloading on activation", async () => {
    vi.mocked(launchTableOfAuthorities).mockResolvedValue({
      ok: true,
      url: "http://127.0.0.1:8765/",
      reused: false,
    });
    const view = render(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    const frame = await screen.findByTitle("Table of Authorities");
    const source = frame.getAttribute("src");

    expect(source).not.toContain("session=");
    expect(source).toContain("attempt=");
    expect(frame).not.toHaveClass("invisible");
    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();

    view.rerender(<TableOfAuthoritiesHost active enabled />);

    expect(frame).toHaveAttribute("src", source);
    expect(frame).not.toHaveClass("invisible");
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);

    signal(frame, "mike:table-of-authorities-ready");

    expect(frame).not.toHaveClass("invisible");
    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();
  });

  it("retains a ready scoped attempt while inactive", async () => {
    const job = "a".repeat(32);
    navigation.search = `?job=${job}`;
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("job"),
      ).toBe(job),
    );
    const source = frame.getAttribute("src");
    signal(frame, "mike:table-of-authorities-ready");

    navigation.search = "";
    view.rerender(
      <TableOfAuthoritiesHost active={false} enabled />,
    );

    expect(frame).toHaveAttribute("src", source);
    expect(frame).toHaveAttribute("aria-hidden", "true");

    navigation.search = `?job=${job}`;
    view.rerender(<TableOfAuthoritiesHost active enabled />);

    expect(frame).toHaveAttribute("src", source);
    expect(frame).toHaveAttribute("aria-hidden", "false");
    expect(frame).not.toHaveClass("invisible");
  });

  it("hides a ready generic frame before activating a scoped attempt", async () => {
    const view = render(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    const frame = await screen.findByTitle("Table of Authorities");
    const genericAttempt = attemptFor(frame);
    signal(frame, "mike:table-of-authorities-ready");

    const job = "b".repeat(32);
    navigation.search = `?job=${job}`;
    view.rerender(<TableOfAuthoritiesHost active enabled />);

    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("job"),
      ).toBe(job),
    );
    expect(attemptFor(frame)).not.toBe(genericAttempt);
    expect(frame).toHaveClass("invisible");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("authorities-neutral-cover")).toBeInTheDocument();
  });

  it("reacts to scope changes and ignores a stale iframe attempt", async () => {
    const firstJob = "a".repeat(32);
    const secondJob = "b".repeat(32);
    navigation.search = `?job=${firstJob}`;
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("job"),
      ).toBe(firstJob),
    );
    const firstAttempt = attemptFor(frame);

    navigation.search = `?job=${secondJob}`;
    view.rerender(<TableOfAuthoritiesHost active enabled />);
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("job"),
      ).toBe(secondJob),
    );
    const secondAttempt = attemptFor(frame);
    expect(secondAttempt).not.toBe(firstAttempt);
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(frame).toHaveClass("invisible");
    expect(screen.getByTestId("authorities-neutral-cover")).toBeInTheDocument();

    signal(frame, "mike:table-of-authorities-ready", firstAttempt);
    expect(frame).toHaveAttribute("tabindex", "-1");

    signal(frame, "mike:table-of-authorities-ready", secondAttempt);
    expect(frame).toHaveAttribute("tabindex", "0");
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);
  });

  it("fails safe when an iframe never signals readiness", async () => {
    vi.useFakeTimers();
    render(<TableOfAuthoritiesHost active enabled />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTitle("Table of Authorities")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByText("Authorities unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Table of Authorities took too long to start."),
    ).toBeInTheDocument();
  });
});
