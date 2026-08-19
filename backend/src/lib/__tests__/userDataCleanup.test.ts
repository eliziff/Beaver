import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../documentStore";
import { deleteUserAccountData } from "../userDataCleanup";

type Row = Record<string, unknown>;

function database(seed: Record<string, Row[]>, failures: Record<string, string> = {}) {
  const tables = Object.fromEntries(Object.entries(seed)
    .map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const db = { from(table: string) {
    const rows = () => tables[table] ?? (tables[table] = []);
    let mode: "select" | "delete" | "update" = "select", patch: Row = {};
    let matches = (_row: Row) => true;
    const narrow = (test: (row: Row) => boolean) => {
      const previous = matches;
      matches = (row) => previous(row) && test(row);
    };
    const query: any = {
      select: () => query,
      delete: () => (mode = "delete", query),
      update: (value: Row) => (mode = "update", patch = value, query),
      eq: (column: string, value: unknown) => (narrow((row) => row[column] === value), query),
      in: (column: string, values: unknown[]) =>
        (narrow((row) => values.includes(row[column])), query),
      filter: (column: string, _operator: string, value: string) => {
        const expected = (JSON.parse(value) as string[]).map((item) => item.toLowerCase());
        narrow((row) => Array.isArray(row[column]) && expected.every((item) =>
          (row[column] as unknown[]).some((actual) =>
            String(actual).trim().toLowerCase() === item)));
        return query;
      },
      then(resolve: (value: { data: Row[] | null; error: unknown }) => unknown,
        reject?: (reason: unknown) => unknown) {
        let result: { data: Row[] | null; error: unknown };
        if (mode === "delete" && failures[table]) {
          result = { data: null, error: { message: failures[table] } };
        } else if (mode === "delete") {
          tables[table] = rows().filter((row) => !matches(row));
          result = { data: null, error: null };
        } else if (mode === "update") {
          rows().filter(matches).forEach((row) => Object.assign(row, patch));
          result = { data: null, error: null };
        } else {
          result = { data: rows().filter(matches).map((row) => ({ ...row })), error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  } };
  return { db: db as any, tables };
}

const documents = {
  deleteUserDocuments: vi.fn(async () => 0),
} as unknown as DocumentStore;
const ids = (rows: Row[] | undefined) => (rows ?? []).map(({ id }) => id);

beforeEach(() => vi.mocked(documents.deleteUserDocuments).mockReset().mockResolvedValue(0));

describe("user data cleanup", () => {
  it("preserves metadata when required object cleanup fails", async () => {
    const { db, tables } = database({
      projects: [{ id: "mine", user_id: "u1" }],
    });
    vi.mocked(documents.deleteUserDocuments).mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await expect(deleteUserAccountData(db, documents, "u1"))
      .rejects.toThrow("storage unavailable");
    expect(ids(tables.projects)).toEqual(["mine"]);
  });

  it("purges account objects before metadata and removes shared email access", async () => {
    const { db, tables } = database({
      projects: [
        { id: "mine", user_id: "u1", shared_with: [] },
        { id: "shared", user_id: "u2", shared_with: ["U1@example.com", "keep@example.com"] },
      ],
      tabular_reviews: [
        { id: "mine-r", user_id: "u1", shared_with: [] },
        { id: "shared-r", user_id: "u2", shared_with: ["u1@example.com"] },
      ],
      chats: [{ id: "mine-c", user_id: "u1" }], project_subfolders: [],
      hidden_workflows: [], workflow_open_source_submissions: [],
      workflow_shares: [
        { id: "by", shared_by_user_id: "u1", shared_with_email: "x@example.com" },
        { id: "to", shared_by_user_id: "u2", shared_with_email: "u1@example.com" },
        { id: "keep", shared_by_user_id: "u2", shared_with_email: "keep@example.com" },
      ],
      workflows: [{ id: "mine-w", user_id: "u1" }, { id: "other-w", user_id: "u2" }],
      audit_events: [], object_cleanup: [],
    });
    await deleteUserAccountData(db, documents, "u1", " U1@Example.com ");
    expect(documents.deleteUserDocuments).toHaveBeenCalledWith(
      { userId: "u1", userEmail: " U1@Example.com " },
      { projectIds: ["mine"], includeOwned: true, purgeObjects: true },
    );
    expect(ids(tables.projects)).toEqual(["shared"]);
    expect(tables.projects[0].shared_with).toEqual(["keep@example.com"]);
    expect(ids(tables.workflow_shares)).toEqual(["keep"]);
    expect(ids(tables.workflows)).toEqual(["other-w"]);
  });
});
