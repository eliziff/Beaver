// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function storedHandle(handle: object) {
  const result = (value: unknown) => {
    const request = { result: value, onsuccess: undefined as undefined | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  vi.stubGlobal("indexedDB", { open: () => result({ transaction: () => ({
    objectStore: () => ({ get: () => result({ handle }) }),
  }) }) });
}

const input = { kind: "local-file" as const, handleId: "selected", lastSeen: {
  name: "case.pdf", size: 4, modified: 1,
} };

it("keeps a readable source available even when its permission query says prompt", async () => {
  storedHandle({ kind: "file", queryPermission: async () => "prompt",
    getFile: async () => new File(["%PDF"], "case.pdf", { lastModified: 1 }) });
  const { inspectStandaloneFile, resolveStandaloneFile } = await import("./standaloneWorkProducts");
  expect(await inspectStandaloneFile(input)).toEqual({ status: "ready" });
  expect(await resolveStandaloneFile({ ...input, lastSeen: { ...input.lastSeen, sha256: "a".repeat(64) } }))
    .toMatchObject({ status: "ready", file: expect.any(File) });
});

it.each([["NotAllowedError", "permission"], ["NotFoundError", "deleted"]])(
  "classifies an actual %s read failure as %s", async (name, reason) => {
    storedHandle({ kind: "file", queryPermission: async () => "granted",
      getFile: async () => { throw new DOMException("Cannot read", name); } });
    const { inspectStandaloneFile } = await import("./standaloneWorkProducts");
    expect(await inspectStandaloneFile(input)).toEqual({ status: "missing", reason });
  });
