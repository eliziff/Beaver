import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/app/lib/api/client", async (original) => ({
  ...await original<typeof import("@/app/lib/api/client")>(),
  apiRequest: api.apiRequest,
}));
import { clearLegalSourceRequests, getDirectLegalSourceDocument } from "./legalSources";

const payload = {
  reference: { docType: "cases" as const, provider: "a2aj", id: "1", kind: "case" as const,
    citation: "2024 SCC 1", language: "en" as const, dataset: null, sourceSha256: "sha" },
  metadata: { title: "Example", citation: "2024 SCC 1", alternateCitation: null, date: null,
    url: null, language: "en" as const },
  slices: [], truncated: false,
};

describe("legal source document cache", () => {
  beforeEach(() => {
    clearLegalSourceRequests();
    vi.clearAllMocks();
    api.apiRequest.mockResolvedValue(payload);
  });

  it("reuses a warmed document for the same request", async () => {
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 1" });
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 1" });
    expect(api.apiRequest).toHaveBeenCalledOnce();
  });

  it("keeps distinct sources and request shapes apart", async () => {
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 1" });
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 2" });
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 1", docType: "laws", sourceId: "other" });
    expect(api.apiRequest).toHaveBeenCalledTimes(3);
  });

  it("forgets warmed documents when the session changes", async () => {
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 1" });
    clearLegalSourceRequests();
    await getDirectLegalSourceDocument({ provider: "a2aj", citation: "2024 SCC 1" });
    expect(api.apiRequest).toHaveBeenCalledTimes(2);
  });
});
