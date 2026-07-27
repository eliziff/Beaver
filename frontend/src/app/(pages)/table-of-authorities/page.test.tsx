import { render, screen } from "@testing-library/react";
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
    const firstUrl = new URL(
      (await screen.findByTitle("Table of Authorities")).getAttribute("src")!,
    );
    expect(firstUrl.searchParams.get("mode")).toBe("mike");
    expect(firstUrl.searchParams.get("session")).toMatch(/^[0-9a-f]{32}$/);
    expect(firstUrl.searchParams.has("job")).toBe(false);

    first.unmount();
    render(<TableOfAuthoritiesPage />);
    const secondUrl = new URL(
      (await screen.findByTitle("Table of Authorities")).getAttribute("src")!,
    );
    expect(secondUrl.searchParams.get("session")).toBe(
      firstUrl.searchParams.get("session"),
    );
  });

  it("forwards only a valid explicitly requested durable job", async () => {
    const job = "a".repeat(32);
    history.replaceState(null, "", `/table-of-authorities?job=${job}`);

    render(<TableOfAuthoritiesPage />);

    const serviceUrl = new URL(
      (await screen.findByTitle("Table of Authorities")).getAttribute("src")!,
    );
    expect(serviceUrl.searchParams.get("job")).toBe(job);
  });
});
