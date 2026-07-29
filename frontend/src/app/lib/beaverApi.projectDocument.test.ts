import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("removeProjectDocument", () => {
  it.each([
    [
      "anonymous",
      "http://localhost:3001/projects/matter-1/documents/document-1",
    ],
    ["required", "http://localhost:3001/single-documents/document-1"],
  ])("uses the %s removal route", async (authMode, expectedUrl) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { removeProjectDocument } = await import("./beaverApi");

    await removeProjectDocument("matter-1", "document-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("apiFetch", () => {
  it("preserves native Headers values and overrides", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("./beaverApi");

    await apiFetch("/health", {
      headers: new Headers({ Accept: "text/plain", "X-Test": "kept" }),
    });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("accept")).toBe("text/plain");
    expect(headers.get("x-test")).toBe("kept");
  });
});
