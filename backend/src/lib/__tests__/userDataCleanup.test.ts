import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../documentStore";
import { deleteUserAccountData } from "../userDataCleanup";

type Call = { table: string; method: string; query: Record<string, string>; body: unknown };
const userId = "u1", email = "u1@example.com";
const ownedTables = ["tabular_reviews", "chats", "project_subfolders", "workflows",
  "work_products", "audit_events", "user_preferences", "projects"];

function fixture(failure?: string) {
  const calls: Call[] = [], deleteUserDocuments = vi.fn(async () => 0);
  const db = createClient("https://cleanup.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)), table = url.pathname.split("/").at(-1)!;
      const method = init?.method ?? "GET", query = Object.fromEntries(url.searchParams);
      calls.push({ table, method, query, body: init?.body ? JSON.parse(String(init.body)) : null });
      const operation = method === "GET" && query.select === "id" ? "owned projects" : `${method} ${table}`;
      const failed = failure === operation;
      // Fixed HTTP responses, not a second implementation of PostgREST's query language.
      const data = query.select === "id" ? [{ id: "mine" }] : [{ id: `shared-${table}`,
        shared_with: [email, " U1@EXAMPLE.COM ", "keep@example.com"] }];
      return new Response(failed ? JSON.stringify({ message: "offline" }) : method === "GET" ? JSON.stringify(data) : null,
        { status: failed ? 400 : method === "GET" ? 200 : 204, headers: { "Content-Type": "application/json" } });
    } },
  });
  const run = (userEmail?: string) => deleteUserAccountData(db,
    { deleteUserDocuments } as unknown as DocumentStore, userId, userEmail);
  return { calls, deleteUserDocuments, run };
}

it.each([undefined, " U1@Example.com "])("scopes account cleanup with email=%j", async (input) => {
  const { calls, deleteUserDocuments, run } = fixture();
  await run(input);
  expect(calls).toContainEqual({ table: "projects", method: "GET", body: null, query: { select: "id", user_id: "eq.u1" } });
  expect(deleteUserDocuments).toHaveBeenCalledExactlyOnceWith(
    { userId, userEmail: input }, { projectIds: ["mine"], includeOwned: true });
  const filters = calls.filter(({ method }) => method === "DELETE").map(({ table, query }) => JSON.stringify([table, query]));
  expect(filters.sort()).toEqual([
    ...ownedTables.map((table) => [table, { user_id: "eq.u1" }]),
    ["workflow_open_source_submissions", { submitted_by_user_id: "eq.u1" }],
    ["workflow_shares", { shared_by_user_id: "eq.u1" }],
    ...(input ? [["workflow_shares", { shared_with_email: `eq.${email}` }]] : []),
  ].map((filter) => JSON.stringify(filter)).sort());
  const sharing = calls.filter(({ query }) => "shared_with" in query);
  expect(sharing).toHaveLength(input ? 4 : 0);
  for (const table of input ? ["projects", "tabular_reviews"] : []) {
    expect(sharing).toContainEqual({ table, method: "GET", body: null,
      query: { select: "id,shared_with", shared_with: `cs.["${email}"]` } });
    expect(sharing).toContainEqual({ table, method: "PATCH", body: { shared_with: ["keep@example.com"] },
      query: { id: `eq.shared-${table}`, shared_with: `cs.["${email}"]` } });
  }
});

it("does not delete metadata while object cleanup is pending or after it fails", async () => {
  const { calls, deleteUserDocuments, run } = fixture();
  let reject!: (error: Error) => void;
  deleteUserDocuments.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const deletion = run(), rejected = expect(deletion).rejects.toThrow("storage unavailable");
  await vi.waitFor(() => expect(deleteUserDocuments).toHaveBeenCalledOnce());
  try {
    expect(calls.filter(({ method }) => method === "DELETE")).toEqual([]);
  } finally {
    reject(new Error("storage unavailable"));
    await rejected;
  }
  expect(calls.filter(({ method }) => method === "DELETE")).toEqual([]);
});

describe("remote cleanup failures", () => {
  it.each(["owned projects", "GET projects", "GET tabular_reviews", "PATCH projects", "PATCH tabular_reviews"])(
    "stops before object and metadata deletion on %s failure", async (failure) => {
      const { calls, deleteUserDocuments, run } = fixture(failure);
      await expect(run(email)).rejects.toThrow("offline");
      expect(deleteUserDocuments).not.toHaveBeenCalled();
      expect(calls.filter(({ method }) => method === "DELETE")).toEqual([]);
    },
  );
  it.each([...ownedTables, "workflow_open_source_submissions", "workflow_shares"])(
    "does not report success when deleting %s fails", async (table) => {
      await expect(fixture(`DELETE ${table}`).run(email)).rejects.toThrow("Failed to delete account data: offline");
    },
  );
});
