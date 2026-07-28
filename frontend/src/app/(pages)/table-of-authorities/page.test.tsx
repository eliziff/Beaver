import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { launchTableOfAuthorities } from "@/app/lib/beaverApi";
import TableOfAuthoritiesPage from "./page";

vi.mock("@/app/lib/beaverApi", () => ({
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

  it("uses a stable Beaver session for this browser tab", async () => {
    const first = render(<TableOfAuthoritiesPage />);
    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const firstFrame = screen.getByTitle("Table of Authorities");
    const firstUrl = new URL(firstFrame.getAttribute("src")!);
    expect(firstUrl.searchParams.get("mode")).toBe("mike");
    expect(firstUrl.searchParams.get("session")).toMatch(/^[0-9a-f]{32}$/);
    expect(firstUrl.searchParams.has("job")).toBe(false);

    first.unmount();
    render(<TableOfAuthoritiesPage />);
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
    history.replaceState(null, "", `/table-of-authorities?job=${job}`);

    render(<TableOfAuthoritiesPage />);

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
    history.replaceState(
      null,
      "",
      `/table-of-authorities?project=${project}`,
    );

    render(<TableOfAuthoritiesPage />);

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

  it("keeps a stable first-frame shell until the iframe is ready", async () => {
    render(<TableOfAuthoritiesPage />);

    expect(screen.queryByTitle("Table of Authorities")).not.toBeInTheDocument();
    expect(screen.getByText("Start with a Word document.")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByTitle("Table of Authorities").getAttribute("src"),
      ).toContain("127.0.0.1:8765"),
    );
    const frame = screen.getByTitle("Table of Authorities");
    expect(screen.getByText("Start with a Word document.")).toBeInTheDocument();
    expect(frame).toHaveAttribute("tabindex", "-1");

    fireEvent.load(frame);

    expect(
      screen.queryByText("Start with a Word document."),
    ).not.toBeInTheDocument();
    expect(frame).toHaveAttribute("tabindex", "0");
  });
});
