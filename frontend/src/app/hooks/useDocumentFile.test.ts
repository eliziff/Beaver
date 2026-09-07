import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/app/lib/api/client", async (original) => ({
  ...await original<typeof import("@/app/lib/api/client")>(), apiFetch,
}));

import { clearDocumentFileCache, invalidateDocumentFile, useDocumentFile } from "./useDocumentFile";

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
  it("shares an in-flight file without one closed reader cancelling another", async () => {
    let finish!: (buffer: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    apiFetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () => body });
    const first = renderHook(() => useDocumentFile("shared", "v1"));
    const second = renderHook(() => useDocumentFile("shared", "v1"));
    first.unmount();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await act(async () => finish(bytes));
    await waitFor(() => expect(second.result.current.result?.buffer).toBe(bytes));
    expect(apiFetch).toHaveBeenCalledOnce(); second.unmount();
  });

  it.each(["account", "document"])("cannot repopulate the cache from an old response body after %s invalidation", async boundary => {
    let finish!: (buffer: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    const started = vi.fn(() => body);
    apiFetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: started });
    const previous = renderHook(() => useDocumentFile("changing", "v1"));
    await waitFor(() => expect(started).toHaveBeenCalled());
    const signal = apiFetch.mock.calls[0][1].signal as AbortSignal;
    previous.unmount();
    if (boundary === "account") clearDocumentFileCache(); else invalidateDocumentFile("changing");
    expect(signal.aborted).toBe(true);
    const bytes = new Uint8Array([9]).buffer;
    apiFetch.mockResolvedValue({ ok: true, headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => bytes });
    const current = renderHook(() => useDocumentFile("changing", "v1"));
    await waitFor(() => expect(current.result.current.result?.buffer).toBe(bytes));
    await act(async () => finish(new Uint8Array([1]).buffer));
    current.unmount();
    const reopened = renderHook(() => useDocumentFile("changing", "v1"));
    expect(reopened.result.current.result?.buffer).toBe(bytes);
    expect(apiFetch).toHaveBeenCalledTimes(2); reopened.unmount();
  });

  it("evicts by retained byte size and least recent use, not only file count", async () => {
    apiFetch.mockImplementation(async () => ({ ok: true, headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => new ArrayBuffer(32 * 1024 * 1024) }));
    await load("a", "v1"); await load("b", "v1"); await load("a", "v1");
    await load("c", "v1"); // a and c fill the 64 MiB retained budget.
    const recent = renderHook(() => useDocumentFile("a", "v1"));
    expect(recent.result.current.result).not.toBeNull(); recent.unmount();
    const evicted = renderHook(() => useDocumentFile("b", "v1"));
    expect(evicted.result.current.result).toBeNull();
    await waitFor(() => expect(evicted.result.current.result).not.toBeNull()); evicted.unmount();
  });

  it("displays a file above the retention budget without keeping it after the reader closes", async () => {
    apiFetch.mockImplementation(async () => ({ ok: true, headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => new ArrayBuffer(65 * 1024 * 1024) }));
    const reader = renderHook(() => useDocumentFile("large", "v1"));
    await waitFor(() => expect(reader.result.current.result?.buffer.byteLength).toBe(65 * 1024 * 1024));
    reader.unmount();
    const reopened = renderHook(() => useDocumentFile("large", "v1"));
    expect(reopened.result.current.result).toBeNull();
    await waitFor(() => expect(reopened.result.current.result).not.toBeNull()); reopened.unmount();
  });

});
