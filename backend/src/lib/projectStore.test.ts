import { describe, expect, it } from "vitest";
import type { DocumentRecord, DocumentStore } from "./documentStore";
import { createProjectStore, type ProjectRepository } from "./projectStore";

describe("project document membership", () => {
  it("moves a Library document, copies a document from another project, and detaches to Library", async () => {
    const rows = new Map<string, DocumentRecord>([
      ["library", { id: "library", project_id: null, current_version_id: "v1",
        filename: "Authority.pdf", file_type: "pdf" }],
      ["other", { id: "other", project_id: "p2", current_version_id: "v2",
        filename: "Record.pdf", file_type: "pdf" }],
    ]);
    const documents = {
      async metadata(_scope, id) { return rows.get(id) ?? null; },
      async relocate(_scope, id, input) {
        const row = rows.get(id);
        if (!row) return { status: "missing" } as const;
        if (row.project_id !== input.expectedProjectId) return { status: "conflict" } as const;
        const document = { ...row, project_id: input.projectId };
        rows.set(id, document);
        return { status: "moved", document } as const;
      },
      async read(_scope, id) {
        const row = rows.get(id);
        return row ? { bytes: Buffer.from(String(id)), filename: String(row.filename),
          fileType: String(row.file_type), hasPdfRendition: false,
          version: { id: String(row.current_version_id), version_number: 1,
            source: "upload", created_at: "2026-01-01T00:00:00.000Z",
            filename: String(row.filename), file_type: String(row.file_type),
            size_bytes: 1, source_sha256: "a".repeat(64) } } : null;
      },
      async create(_scope, input) {
        const document = { id: "copy", project_id: input.projectId ?? null,
          current_version_id: "v3", filename: input.filename, file_type: input.fileType,
          active_version_number: 1, source_sha256: "b".repeat(64) };
        rows.set(document.id, document);
        return document;
      },
    } as DocumentStore;
    const repository = {
      async project(_scope, id) { return ["p1", "p2"].includes(id) ? { id } : null; },
    } as ProjectRepository;
    const projects = createProjectStore(repository, documents);
    const scope = { userId: "owner" };

    await expect(projects.attachDocument(scope, "p1", "library"))
      .resolves.toMatchObject({ created: false, document: { id: "library", project_id: "p1" } });
    await expect(projects.detachDocument(scope, "p1", "library")).resolves.toBe(true);
    expect(rows.get("library")?.project_id).toBeNull();
    await expect(projects.attachDocument(scope, "p1", "other"))
      .resolves.toMatchObject({ created: true, document: { id: "copy", project_id: "p1" } });
    expect(rows.get("other")?.project_id).toBe("p2");
  });
});
