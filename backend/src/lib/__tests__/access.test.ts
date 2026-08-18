import { describe, expect, it } from "vitest";
import { CloudScope } from "../access";

type Row = Record<string, any>;

function makeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value); return query;
        },
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column])); return query;
        },
        is: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value); return query;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: { data: Row[]; error: null }) => unknown,
          reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return query;
    },
  } as any;
}

describe("CloudScope", () => {
  const tables = {
    projects: [
      { id: "own-project", user_id: "owner", shared_with: [] },
      { id: "shared-project", user_id: "other", shared_with: ["Reviewer@Example.com"] },
      { id: "private-project", user_id: "other", shared_with: [] },
    ],
    documents: [
      { id: "own-doc", user_id: "owner", project_id: null },
      { id: "shared-doc", user_id: "other", project_id: "shared-project" },
      { id: "private-doc", user_id: "other", project_id: "private-project" },
    ],
    tabular_reviews: [
      { id: "own-review", user_id: "owner", project_id: null, shared_with: [] },
      { id: "shared-review", user_id: "other", project_id: null,
        shared_with: ["REVIEWER@example.com"] },
      { id: "project-review", user_id: "other", project_id: "shared-project", shared_with: [] },
    ],
    chats: [
      { id: "own-chat", user_id: "owner", project_id: null,
        tabular_review_id: null, deleted_at: null },
      { id: "shared-chat", user_id: "other", project_id: "shared-project",
        tabular_review_id: null, deleted_at: null },
      { id: "review-chat", user_id: "other", project_id: null,
        tabular_review_id: "shared-review", deleted_at: null },
    ],
  };

  it("allows owners of every root resource", async () => {
    const scope = new CloudScope({ userId: "owner", userEmail: "owner@example.com" },
      makeDb(tables));
    await expect(scope.project("own-project")).resolves.toMatchObject({ isOwner: true });
    await expect(scope.document("own-doc")).resolves.toMatchObject({ isOwner: true });
    await expect(scope.review("own-review")).resolves.toMatchObject({ isOwner: true });
    await expect(scope.chat("own-chat")).resolves.toMatchObject({ isOwner: true });
  });

  it("inherits project and direct-review shares case-insensitively", async () => {
    const scope = new CloudScope({ userId: "reviewer", userEmail: " reviewer@example.com " },
      makeDb(tables));
    await expect(scope.project("shared-project")).resolves.toMatchObject({ isOwner: false });
    await expect(scope.document("shared-doc")).resolves.toMatchObject({ isOwner: false });
    await expect(scope.review("shared-review")).resolves.toMatchObject({ isOwner: false });
    await expect(scope.review("project-review")).resolves.toMatchObject({ isOwner: false });
    await expect(scope.chat("shared-chat")).resolves.toMatchObject({ isOwner: false });
    await expect(scope.chat("review-chat")).resolves.toMatchObject({ isOwner: false });
  });

  it("makes foreign and nonexistent IDs indistinguishable", async () => {
    const scope = new CloudScope({ userId: "stranger", userEmail: "stranger@example.com" },
      makeDb(tables));
    for (const id of ["private-project", "missing"]) {
      await expect(scope.project(id)).resolves.toBeNull();
    }
    for (const id of ["private-doc", "missing"]) {
      await expect(scope.document(id)).resolves.toBeNull();
    }
    for (const id of ["project-review", "missing"]) {
      await expect(scope.review(id)).resolves.toBeNull();
    }
    for (const id of ["shared-chat", "missing"]) {
      await expect(scope.chat(id)).resolves.toBeNull();
    }
  });

  it("revokes access on the next lookup", async () => {
    const scope = new CloudScope({ userId: "reviewer", userEmail: "reviewer@example.com" },
      makeDb(tables));
    await expect(scope.project("shared-project")).resolves.not.toBeNull();
    await expect(scope.document("shared-doc")).resolves.not.toBeNull();
    await expect(scope.review("shared-review")).resolves.not.toBeNull();
    await expect(scope.chat("review-chat")).resolves.not.toBeNull();
    tables.projects[1].shared_with = [];
    tables.tabular_reviews[1].shared_with = [];
    await expect(scope.project("shared-project")).resolves.toBeNull();
    await expect(scope.document("shared-doc")).resolves.toBeNull();
    await expect(scope.review("shared-review")).resolves.toBeNull();
    await expect(scope.chat("review-chat")).resolves.toBeNull();
  });

  it("does not let request-shaped foreign identity fields widen the bound scope", async () => {
    const scope = new CloudScope({ userId: "stranger", userEmail: "stranger@example.com",
      requestedUserId: "owner", requestedEmail: "reviewer@example.com" } as any, makeDb(tables));
    await expect(scope.document("own-doc")).resolves.toBeNull();
    await expect(scope.project("shared-project")).resolves.toBeNull();
  });
});
