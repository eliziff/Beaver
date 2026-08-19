import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./access", () => ({
  cloudScope: (identity: { userId: string; userEmail?: string }) => ({
    ...identity, userEmail: identity.userEmail ?? "", db,
  }),
  cloudData: async (_operation: string, query: PromiseLike<{ data: unknown }>) =>
    (await query).data,
}));

import { postgresDocumentRepository } from "./postgresDocumentRepository";

const scope = { userId: "owner", userEmail: "owner@example.test" };
const version = (id: string) => ({
  id, documentId: "10000000-0000-4000-8000-000000000001", versionNumber: 2,
  source: "user_upload", createdAt: "2026-01-01T00:00:00.000Z",
  filename: "Brief.docx", fileType: "docx", sizeBytes: 4, pageCount: null,
  sourceSha256: "a".repeat(64), blobKey: `owner/document/${id}`,
  pdfBlobKey: null, cleanupKeys: [],
});

beforeEach(() => { db.rpc.mockReset(); });

describe("cloud document atomic writes", () => {
  it("allows exactly one version insert for a shared current version", async () => {
    let current = "20000000-0000-4000-8000-000000000001";
    db.rpc.mockImplementation(async (...args: unknown[]) => {
      const input = args[1] as { p_expected: string; p_payload: { version: { id: string } } };
      if (input.p_expected !== current)
        return { data: { status: "conflict" }, error: null };
      current = input.p_payload.version.id;
      return { data: { status: "created" }, error: null };
    });

    const results = await Promise.all(["30000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000001"].map((id) =>
      postgresDocumentRepository.insertVersion(scope, version(id).documentId, {
        expectedCurrentVersionId: "20000000-0000-4000-8000-000000000001",
        version: version(id),
      })));

    expect(results.sort()).toEqual(["conflict", "created"]);
  });
});
