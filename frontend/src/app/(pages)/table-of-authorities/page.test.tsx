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
vi.mock("@/app/lib/authMode", () => ({ isLocalMode: true }));

const navigation = vi.hoisted(() => ({ search: "" }));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(navigation.search), vi.fn()],
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

  it("mounts one launcher-owned frame after the launch handshake", async () => {
    let resolveLaunch!: (value: {
      ok: true;
      url: string;
      reused: true;
    }) => void;
    vi.mocked(launchTableOfAuthorities).mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
    );

    const first = render(<TableOfAuthoritiesHost active enabled />);
    expect(screen.queryByTitle("Table of Authorities")).not.toBeInTheDocument();

    resolveLaunch({
      ok: true,
      url: "http://127.0.0.1:8765/",
      reused: true,
    });
    const firstFrame = await screen.findByTitle("Table of Authorities");
    const firstUrl = new URL(firstFrame.getAttribute("src")!);
    expect(firstUrl.searchParams.get("mode")).toBe("mike");
    expect(firstUrl.searchParams.has("session")).toBe(false);
    expect(firstUrl.searchParams.get("attempt")).not.toBe("");
    expect(firstUrl.searchParams.has("job")).toBe(false);

    first.rerender(<TableOfAuthoritiesHost active enabled />);
    const secondFrame = screen.getByTitle("Table of Authorities");
    expect(secondFrame.getAttribute("src")).toBe(firstFrame.getAttribute("src"));
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);
  });

  it("forwards only a valid explicitly requested durable job", async () => {
    const job = "a".repeat(32);
    navigation.search = `?job=${job}`;
    history.replaceState(null, "", `/table-of-authorities?job=${job}`);

    render(<TableOfAuthoritiesHost active enabled />);

    const frame = await screen.findByTitle("Table of Authorities");
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

    const frame = await screen.findByTitle("Table of Authorities");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("project"),
      ).toBe(project),
    );
  });

  it("shows the embedded surface immediately but keeps it noninteractive until ready", async () => {
    render(<TableOfAuthoritiesHost active enabled />);

    const frame = await screen.findByTitle("Table of Authorities");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(frame).not.toHaveClass("invisible");

    fireEvent.load(frame);
    signal(frame, "mike:table-of-authorities-ready");

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

  it("reveals a ready generic frame immediately on navigation intent", async () => {
    const view = render(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    const frame = await screen.findByTitle("Table of Authorities");
    const source = frame.getAttribute("src");
    signal(frame, "mike:table-of-authorities-ready");

    view.rerender(
      <TableOfAuthoritiesHost active={false} pending enabled />,
    );

    expect(screen.getByTestId("authorities-host")).not.toHaveAttribute("inert");
    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(frame).toHaveAttribute("src", source);
    expect(frame).toHaveAttribute("aria-hidden", "false");
    expect(frame).toHaveAttribute("tabindex", "0");
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);
  });

  it("covers a retained scoped frame during bare navigation intent", async () => {
    const job = "a".repeat(32);
    navigation.search = `?job=${job}`;
    const view = render(<TableOfAuthoritiesHost active enabled />);
    const frame = await screen.findByTitle("Table of Authorities");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.get("job"),
      ).toBe(job),
    );
    const scopedAttempt = attemptFor(frame);
    signal(frame, "mike:table-of-authorities-ready");

    navigation.search = "";
    view.rerender(
      <TableOfAuthoritiesHost active={false} pending enabled />,
    );

    expect(screen.getByTestId("authorities-host")).not.toHaveAttribute("inert");
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(frame).toHaveClass("invisible");
    expect(frame).toHaveAttribute(
      "src",
      expect.stringContaining(`job=${job}`),
    );
    expect(attemptFor(frame)).toBe(scopedAttempt);

    view.rerender(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    expect(screen.getByTestId("authorities-host")).toHaveAttribute("inert");
    expect(attemptFor(frame)).toBe(scopedAttempt);

    view.rerender(
      <TableOfAuthoritiesHost active={false} pending enabled />,
    );
    view.rerender(<TableOfAuthoritiesHost active enabled />);
    expect(frame).toHaveAttribute("aria-hidden", "true");
    await waitFor(() =>
      expect(
        new URL(frame.getAttribute("src")!).searchParams.has("job"),
      ).toBe(false),
    );
    expect(attemptFor(frame)).not.toBe(scopedAttempt);
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);
  });

  it("hides the retained frame again when navigation intent rolls back", async () => {
    const view = render(
      <TableOfAuthoritiesHost active={false} enabled />,
    );
    const frame = await screen.findByTitle("Table of Authorities");
    const source = frame.getAttribute("src");
    signal(frame, "mike:table-of-authorities-ready");
    view.rerender(
      <TableOfAuthoritiesHost active={false} pending enabled />,
    );
    expect(frame).toHaveAttribute("tabindex", "0");

    view.rerender(
      <TableOfAuthoritiesHost active={false} enabled />,
    );

    expect(screen.getByTitle("Table of Authorities")).toBe(frame);
    expect(frame).toHaveAttribute("src", source);
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("authorities-host")).toHaveAttribute("inert");
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);
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
    expect(frame).toHaveClass("invisible");

    view.rerender(<TableOfAuthoritiesHost active enabled />);

    expect(frame).toHaveAttribute("src", source);
    expect(frame).not.toHaveClass("invisible");
    expect(launchTableOfAuthorities).toHaveBeenCalledTimes(1);

    signal(frame, "mike:table-of-authorities-ready");

    expect(frame).not.toHaveClass("invisible");
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
    expect(frame).not.toHaveClass("invisible");
    expect(frame).toHaveAttribute("tabindex", "-1");
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
    expect(frame).not.toHaveClass("invisible");

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
