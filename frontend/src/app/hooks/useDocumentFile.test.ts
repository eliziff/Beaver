import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiBlobRequest } = vi.hoisted(() => ({ apiBlobRequest: vi.fn() }));
vi.mock("../lib/beaverApi", () => ({ apiBlobRequest }));

import { clearDocumentFileCache, preloadDocumentFile } from "./useDocumentFile";

describe("document file loading", () => {
  beforeEach(() => apiBlobRequest.mockReset().mockResolvedValue({
    blob: {
      type: "application/pdf",
      arrayBuffer: async () => new ArrayBuffer(8),
    },
    filename: null,
  }));

  it("keeps route-derived document identifiers in one path segment", async () => {
    await preloadDocumentFile("../user/export?confirm=true", "version/1");

    expect(apiBlobRequest).toHaveBeenCalledWith(
      "/single-documents/..%2Fuser%2Fexport%3Fconfirm%3Dtrue/file?rendition=pdf&version_id=version%2F1",
      expect.any(Object),
    );
  });

  it("does not retain private bytes across an authentication boundary", async () => {
    await preloadDocumentFile("private-document", "v1");
    clearDocumentFileCache();
    await preloadDocumentFile("private-document", "v1");

    expect(apiBlobRequest).toHaveBeenCalledTimes(2);
  });
});
