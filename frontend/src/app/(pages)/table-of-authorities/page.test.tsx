import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { launchTableOfAuthorities } from "@/app/lib/mikeApi";
import TableOfAuthoritiesPage from "./page";

vi.mock("@/app/lib/mikeApi", () => ({
  launchTableOfAuthorities: vi.fn(),
}));

describe("TableOfAuthoritiesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    history.replaceState(null, "", "/table-of-authorities");
    vi.mocked(launchTableOfAuthorities).mockResolvedValue({
      ok: true,
      url: "http://127.0.0.1:8765/",
      reused: true,
    });
  });

  it("uses a stable Mike session for this browser tab", async () => {
    const first = render(<TableOfAuthoritiesPage />);
    const firstFrame = screen.getByTitle("Table of Authorities");
    await waitFor(() =>
      expect(firstFrame.getAttribute("src")).toContain("127.0.0.1:8765"),
    );
    const firstUrl = new URL(firstFrame.getAttribute("src")!);
    expect(firstUrl.searchParams.get("mode")).toBe("mike");
    expect(firstUrl.searchParams.get("session")).toMatch(/^[0-9a-f]{32}$/);
    expect(firstUrl.searchParams.has("job")).toBe(false);

    first.unmount();
    render(<TableOfAuthoritiesPage />);
    const secondFrame = screen.getByTitle("Table of Authorities");
    await waitFor(() =>
      expect(secondFrame.getAttribute("src")).toContain("127.0.0.1:8765"),
    );
    const secondUrl = new URL(secondFrame.getAttribute("src")!);
    expect(secondUrl.searchParams.get("session")).toBe(
      firstUrl.searchParams.get("session"),
    );
  });

  it("forwards only a valid explicitly requested durable job", async () => {
    const job = "a".repeat(32);
    history.replaceState(null, "", `/table-of-authorities?job=${job}`);

    render(<TableOfAuthoritiesPage />);

    const frame = screen.getByTitle("Table of Authorities");
    await waitFor(() =>
      expect(frame.getAttribute("src")).toContain("127.0.0.1:8765"),
    );
    const serviceUrl = new URL(frame.getAttribute("src")!);
    expect(serviceUrl.searchParams.get("job")).toBe(job);
  });

  it("keeps one full-size frame while the service starts", async () => {
    render(<TableOfAuthoritiesPage />);

    const frame = screen.getByTitle("Table of Authorities");
    expect(frame).toHaveAttribute("src", "about:blank");
    expect(frame).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText("Starting Authorities…")).toBeInTheDocument();

    await waitFor(() =>
      expect(frame.getAttribute("src")).toContain("127.0.0.1:8765"),
    );
    expect(frame).toHaveAttribute("tabindex", "0");
  });
});
