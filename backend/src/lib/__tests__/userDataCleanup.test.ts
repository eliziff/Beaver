import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../documentStore";
import { deleteUserAccountData } from "../userDataCleanup";

type RequestRecord = { method: string; table: string; filters: Record<string, string>;
  body: unknown };
const ownedTables = ["tabular_reviews", "chats", "project_subfolders", "workflows",
  "work_products", "audit_events", "user_preferences", "projects"];

function setup(failure?: string) {
  const requests: RequestRecord[] = [];
  const documents = { deleteUserDocuments: vi.fn(async () => 0) };
  // Exercise the real SDK; only HTTP responses are supplied, not a second query engine.
  const db = createClient("https://cleanup.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const table = url.pathname.split("/").at(-1)!;
      url.searchParams.delete("select");
      requests.push({ method: request.method, table,
        filters: Object.fromEntries(url.searchParams),
        body: request.method === "PATCH" ? await request.json() : null });
      const operation = request.method === "GET" && url.searchParams.has("user_id")
        ? "owned projects" : `${request.method} ${table}`;
      if (operation === failure)
        return Response.json({ message: "fixture failure" }, { status: 400 });
      if (request.method !== "GET") return new Response(null, { status: 204 });
      return Response.json(url.searchParams.has("user_id") ? [{ id: "owned-project" }] : [
        { id: `${table}-shared`, shared_with: table === "projects"
          ? ["u1@example.com", " U1@EXAMPLE.COM ", "keep@example.com"] : ["u1@example.com"] },
      ]);
    } },
  });
  return { requests, documents, run: (email?: string | null) => deleteUserAccountData(
    db, documents as unknown as DocumentStore, "u1", email) };
}

const sorted = <T>(values: T[]) => values.sort((a, b) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b)));
const operations = (requests: RequestRecord[], method: string) => requests
  .filter((request) => request.method === method)
  .map(({ table, filters }) => [table, filters]);

describe("user data cleanup", () => {
  it.each([undefined, null, "", " U1@Example.com "])(
    "scopes every deletion and preserves other shared access (email: %s)", async (email) => {
      const { run, documents, requests } = setup();
      await run(email);
      expect(documents.deleteUserDocuments).toHaveBeenCalledExactlyOnceWith(
        { userId: "u1", userEmail: email ?? undefined },
        { projectIds: ["owned-project"], includeOwned: true });
      expect(sorted(operations(requests, "DELETE"))).toEqual(sorted([
        ...ownedTables.map((table) => [table, { user_id: "eq.u1" }]),
        ["workflow_open_source_submissions", { submitted_by_user_id: "eq.u1" }],
        ["workflow_shares", { shared_by_user_id: "eq.u1" }],
        ...(email ? [["workflow_shares", { shared_with_email: "eq.u1@example.com" }]] : []),
      ]));
      expect(sorted(operations(requests, "GET"))).toEqual(sorted([
        ["projects", { user_id: "eq.u1" }],
        ...(email ? ["projects", "tabular_reviews"].map((table) =>
          [table, { shared_with: 'cs.["u1@example.com"]' }]) : []),
      ]));
      expect(sorted(requests.filter(({ method }) => method === "PATCH"))).toEqual(sorted(email
        ? ["projects", "tabular_reviews"].map((table) => ({ method: "PATCH", table,
          filters: { id: `eq.${table}-shared`, shared_with: 'cs.["u1@example.com"]' },
          body: { shared_with: table === "projects" ? ["keep@example.com"] : [] } })) : []));
    });

  it("waits for object cleanup to finish before deleting metadata", async () => {
    const { run, documents, requests } = setup();
    let release!: (value: number) => void;
    documents.deleteUserDocuments.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = run();
    try {
      await vi.waitFor(() => expect(documents.deleteUserDocuments).toHaveBeenCalledOnce());
      expect(operations(requests, "DELETE")).toEqual([]);
    } finally { release(0); await pending; }
    expect(operations(requests, "DELETE")).toHaveLength(10);
  });

  it("does not delete metadata when required object cleanup fails", async () => {
    const { run, documents, requests } = setup();
    documents.deleteUserDocuments.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(run("u1@example.com")).rejects.toThrow("storage unavailable");
    expect(operations(requests, "DELETE")).toEqual([]);
  });

  it.each(["owned projects", "GET projects", "GET tabular_reviews", "PATCH projects",
    "PATCH tabular_reviews", ...[...ownedTables, "workflow_open_source_submissions",
      "workflow_shares"].map((table) => `DELETE ${table}`)])("propagates %s failures", async (failure) => {
    const { run, documents, requests } = setup(failure);
    await expect(run("u1@example.com")).rejects.toThrow("fixture failure");
    expect(documents.deleteUserDocuments).toHaveBeenCalledTimes(failure.startsWith("DELETE") ? 1 : 0);
    if (!failure.startsWith("DELETE")) expect(operations(requests, "DELETE")).toEqual([]);
  });
});
