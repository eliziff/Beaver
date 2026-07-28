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

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

function attemptFor(frame: HTMLElement) {
  return new URL(frame.getAttribute("src")!).searchParams.get("attempt");
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

  it("uses a stable Beaver session for this browser tab", async () => {
    const first = render(<TableOfAuthoritiesHost active enabled />);
    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const firstFrame = screen.getByTitle("Table of Authorities");
    const firstUrl = new URL(firstFrame.getAttribute("src")!);
    expect(firstUrl.searchParams.get("mode")).toBe("mike");
    expect(firstUrl.searchParams.get("session")).toMatch(/^[0-9a-f]{32}$/);
    expect(firstUrl.searchParams.get("attempt")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(firstUrl.searchParams.has("job")).toBe(false);

    first.unmount();
    render(<TableOfAuthoritiesHost active enabled />);
    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const secondFrame = screen.getByTitle("Table of Authorities");
    const secondUrl = new URL(secondFrame.getAttribute("src")!);
    expect(secondUrl.searchParams.get("session")).toBe(
      firstUrl.searchParams.get("session"),
    );
  });

  it("forwards only a valid explicitly requested durable job", async () => {
    const job = "a".repeat(32);
    navigation.search = `?job=${job}`;
    history.replaceState(null, "", `/table-of-authorities?job=${job}`);

    render(<TableOfAuthoritiesHost active enabled />);

    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const frame = screen.getByTitle("Table of Authorities");
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

    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const frame = screen.getByTitle("Table of Authorities");
    expect(
      new URL(frame.getAttribute("src")!).searchParams.get("project"),
    ).toBe(project);
  });

  it("keeps a neutral cover until the embedded app signals readiness", async () => {
    render(<TableOfAuthoritiesHost active enabled />);

    expect(screen.queryByTitle("Table of Authorities")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("authorities-neutral-cover"),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const frame = screen.getByTitle("Table of Authorities");
    expect(frame).toHaveAttribute("tabindex", "-1");

    fireEvent.load(frame);
    expect(
      screen.getByTestId("authorities-neutral-cover"),
    ).toBeInTheDocument();
    signal(frame, "mike:table-of-authorities-ready");

    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();
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
    expect(host).toHaveClass("invisible", "pointer-events-none");
    expect(host).toHaveAttribute("inert");
    expect(frame).toHaveAttribute("aria-hidden", "true");

    signal(frame, "mike:table-of-authorities-ready");
    view.rerender(<TableOfAuthoritiesHost active enabled />);

    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(host).toHaveClass("visible");
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

  it("reacts to scope changes and ignores a stale iframe attempt", async () => {
    const firstJob = "a".repeat(32);
    const secondJob = "b".repeat(32);
    navigation.search = `?job=${firstJob}`;
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
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
    expect(screen.getByTestId("authorities-neutral-cover")).toBeInTheDocument();

    signal(frame, "mike:table-of-authorities-ready", firstAttempt);
    expect(screen.getByTestId("authorities-neutral-cover")).toBeInTheDocument();

    signal(frame, "mike:table-of-authorities-ready", secondAttempt);
    expect(
      screen.queryByTestId("authorities-neutral-cover"),
    ).not.toBeInTheDocument();
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
