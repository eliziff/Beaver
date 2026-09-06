import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/app/lib/api/client", async (original) => ({
  ...await original<typeof import("@/app/lib/api/client")>(), apiFetch,
}));

import { clearDocumentFileCache, useDocumentFile } from "./useDocumentFile";

async function load(documentId: string, versionId: string) {
  const hook = renderHook(() => useDocumentFile(documentId, versionId));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  hook.unmount();
}

describe("document file loading", () => {
  beforeEach(() => {
    clearDocumentFileCache();
    apiFetch.mockReset().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => new ArrayBuffer(8),
    });
  });

  it("keeps route-derived document identifiers in one path segment", async () => {
    await load("../user/export?confirm=true", "version/1");

    expect(apiFetch).toHaveBeenCalledWith(
      "/single-documents/..%2Fuser%2Fexport%3Fconfirm%3Dtrue/file?rendition=pdf&version_id=version%2F1",
      expect.any(Object),
    );
  });

  it("does not retain private bytes across an authentication boundary", async () => {
    await load("private-document", "v1");
    clearDocumentFileCache();
    await load("private-document", "v1");

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("reuses PDF bytes when the dock is reopened", async () => {
    await load("docked-pdf", "v1");
    await load("docked-pdf", "v1");

    expect(apiFetch).toHaveBeenCalledOnce();
  });
});
