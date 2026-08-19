import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import {
    createMutableSupabaseState,
    createMutableSupabaseStub,
} from "../helpers/supabaseStub";

// ---------------------------------------------------------------------------
// Hoisted mock fns reconfigured per-test. Access helpers + model settings are
// mocked so the tests drive review-access decisions, document-access filtering
// and the missing-API-key guard without touching real Supabase / LLM IO. The
// streaming endpoints (chat/generate) are only exercised up to their GUARDS —
// the SSE loop itself is never reached in these tests.
// ---------------------------------------------------------------------------
const {
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
    getUserModelSettings,
    loadActiveVersion,
} = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    checkProjectAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    getUserModelSettings: vi.fn(),
    loadActiveVersion: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub (mirrors projects.routes.test). Each test seeds
// `supabaseState` in beforeEach; terminal query operations resolve to the
// per-table result, rpc() resolves to a per-call result. Insert payloads are
// recorded so tests can assert on what got persisted.
// ---------------------------------------------------------------------------
let supabaseState = createMutableSupabaseState();
function resetSupabaseState() { supabaseState = createMutableSupabaseState(); }
resetSupabaseState();

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => createMutableSupabaseStub(supabaseState)),
}));

vi.mock("../../lib/s3ObjectStorage", () => ({
    s3DocumentObjects: () => ({
        kind: "s3",
        put: vi.fn(async () => {}),
        get: vi.fn(async () => null),
        remove: vi.fn(async () => {}),
        list: vi.fn(async () => ({ keys: [], cursor: null })),
        signedGet: vi.fn(async () => "https://storage.test/signed"),
    }),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/access", () => ({
    cloudData: async (operation: string, query: PromiseLike<any>) => {
        const { data, error } = await query;
        if (error) throw new Error(operation);
        return data;
    },
    cloudScope: (identity: { userId: string; userEmail?: string }) => {
        const db = createMutableSupabaseStub(supabaseState);
        return {
            ...identity, userEmail: identity.userEmail?.toLowerCase() ?? "", db,
            project: async (id: string, owner = false) => {
                const result = await checkProjectAccess(id, identity.userId,
                    identity.userEmail, db);
                return result.ok && (!owner || result.isOwner)
                    ? { row: result.project, isOwner: result.isOwner } : null;
            },
            review: async (_id: string, owner = false) => {
                const row = supabaseState.tables.tabular_reviews?.data as any;
                if (!row) return null;
                const result = await ensureReviewAccess(row, identity.userId,
                    identity.userEmail, db);
                return result.ok && (!owner || result.isOwner)
                    ? { row, isOwner: result.isOwner } : null;
            },
            documents: async (ids: string[]) => {
                const allowed = await filterAccessibleDocumentIds(ids);
                const rows = supabaseState.tables.documents?.data;
                return allowed.map((id: string) => ({
                    row: Array.isArray(rows)
                        ? rows.find((row: any) => row.id === id) ??
                            { id, user_id: identity.userId, project_id: "p1" }
                        : { id, user_id: identity.userId, project_id: "p1" },
                    isOwner: true,
                }));
            },
            document: vi.fn(async () => null),
            chat: vi.fn(async () => null),
            projects: vi.fn(async () => []),
        };
    },
}));

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: (...args: unknown[]) => getUserModelSettings(...args),
    getUserApiKeys: vi.fn(async () => ({})),
}));

// Version-path enrichment + active-version resolution hit the DB in real life;
// no-op them so route responses are driven purely by the table stubs.
vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    loadActiveVersion: (...args: unknown[]) => loadActiveVersion(...args),
}));

import { api } from "../../api";

const AUTH = ["Authorization", "Bearer test"] as const;

describe("tabular.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        // Default: caller is the owner with full access.
        ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: true });
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isOwner: true,
            project: { id: "p1", user_id: "u1", shared_with: null },
        });
        // Default: every requested doc is accessible (identity passthrough).
        filterAccessibleDocumentIds.mockImplementation(
            async (ids: string[]) => ids,
        );
        getUserModelSettings.mockResolvedValue({
            title_model: "claude-haiku-4-5",
            tabular_model: "claude-sonnet-4-5",
            legal_research_us: false,
            api_keys: { claude: "sk-test" },
        });
        loadActiveVersion.mockResolvedValue(null);
    });

    // ── GET /tabular-review (overview) ────────────────────────────────────
    describe("GET /tabular-review", () => {
        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [{
                    id: "r1",
                    created_at: "2026-01-01T00:00:00.000Z",
                    payload: { id: "r1", title: "Alpha" },
                }],
                error: null,
            };

            const res = await request(api).get("/tabular-review").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                items: [{ id: "r1", title: "Alpha", project_name: null }],
                next_cursor: null,
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

            const res = await request(api).get("/tabular-review").set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Failed to load tabular reviews");
        });
    });

    // ── POST /tabular-review (create) ─────────────────────────────────────
    describe("POST /tabular-review", () => {
        it("rejects a review containing an inaccessible document ID", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r9", title: "Gamma", document_ids: ["d1"] },
                error: null,
            };
            // d2 is not accessible — it must be filtered out of the insert.
            filterAccessibleDocumentIds.mockResolvedValue(["d1"]);

            const res = await request(api)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Gamma",
                    document_ids: ["d1", "d2"],
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Document not found");
            expect(supabaseState.inserts).toEqual([]);
            // Cells are created for accessible docs × columns only (1 × 1).
        });

        it("returns 404 when project access is denied", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(api)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    project_id: "p-nope",
                    document_ids: [],
                    columns_config: [],
                });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("rejects a document from a different accessible project", async () => {
            filterAccessibleDocumentIds.mockResolvedValue(["d2"]);
            supabaseState.tables.documents = {
                data: [{ id: "d2", user_id: "u1", project_id: "p2" }],
                error: null,
            };
            const res = await request(api).post("/tabular-review").set(...AUTH)
                .send({ project_id: "p1", document_ids: ["d2"], columns_config: [] });
            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Document not found");
            expect(supabaseState.inserts).toEqual([]);
        });

    });

    // ── GET /tabular-review/:reviewId (detail) ────────────────────────────
    describe("GET /tabular-review/:reviewId", () => {
        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(api)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(api)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 200 with review/cells/documents + is_owner", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    document_ids: ["d1"],
                    columns_config: [],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = {
                data: [
                    {
                        id: "c1",
                        document_id: "d1",
                        column_index: 0,
                        content: null,
                        status: "pending",
                    },
                ],
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", current_version_id: null }],
                error: null,
            };

            const res = await request(api)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.review).toMatchObject({ id: "r1", is_owner: true });
            expect(res.body.cells).toHaveLength(1);
            expect(res.body.documents).toEqual([]);
        });
    });

    // ── PATCH /tabular-review/:reviewId ───────────────────────────────────
    describe("PATCH /tabular-review/:reviewId", () => {
        it("returns 400 when project_id is an invalid type", async () => {
            const res = await request(api)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ project_id: 123 });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "project_id must be a non-empty string or null",
            );
        });

        it("returns 400 when sharing the review with yourself", async () => {
            const res = await request(api)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "You cannot share a tabular review with yourself.",
            );
        });

        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(api)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ title: "Renamed" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 403 when a non-owner edits columns_config", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: "p1" },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: false });

            const res = await request(api)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ columns_config: [{ index: 0, name: "X", prompt: "p" }] });

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe("Only the review owner can change columns");
        });
    });

    // ── DELETE /tabular-review/:reviewId ──────────────────────────────────
    describe("DELETE /tabular-review/:reviewId", () => {
        it("returns 204 on success", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };

            const res = await request(api)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(204);
        });

        it("does not disclose a review when its access lookup fails", async () => {
            supabaseState.tables.tabular_reviews = {
                data: null,
                error: { message: "delete failed" },
            };

            const res = await request(api)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });
    });

    // ── POST /tabular-review/:reviewId/clear-cells ────────────────────────
    describe("POST /tabular-review/:reviewId/clear-cells", () => {
        it("returns 400 when document_ids is missing", async () => {
            const res = await request(api)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("document_ids is required");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(api)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ document_ids: ["d1"] });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 204 on success", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null,
                    document_ids: ["d1"] },
                error: null,
            };

            const res = await request(api)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ document_ids: ["d1"] });

            expect(res.status).toBe(204);
        });
    });

    // ── POST /tabular-review/:reviewId/regenerate-cell ────────────────────
    describe("POST /tabular-review/:reviewId/regenerate-cell", () => {
        it("returns 400 when document_id / column_index are missing", async () => {
            const res = await request(api)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "document_id and column_index are required",
            );
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(api)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ document_id: "d1", column_index: 0 });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 400 when the column is not configured", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 5, name: "Other", prompt: "p" }],
                },
                error: null,
            };

            const res = await request(api)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ document_id: "d1", column_index: 0 });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("Column not found");
        });

        it("returns 404 when the document is not accessible", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                    document_ids: ["d1"],
                },
                error: null,
            };
            filterAccessibleDocumentIds.mockResolvedValue([]);

            const res = await request(api)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ document_id: "d-forbidden", column_index: 0 });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Document not found");
        });

        it("returns 422 with missing_api_key when the model key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                    document_ids: ["d1"],
                },
                error: null,
            };
            supabaseState.tables.documents = {
                data: { id: "d1", current_version_id: null },
                error: null,
            };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-4-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(api)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ document_id: "d1", column_index: 0 });

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
            expect(res.body.provider).toBe("claude");
        });
    });

    // ── POST /tabular-review/:reviewId/generate (streaming GUARDS only) ───
    describe("POST /tabular-review/:reviewId/generate", () => {
        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(api)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(api)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 400 when no columns are configured", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [],
                },
                error: null,
            };

            const res = await request(api)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("No columns configured");
        });

        it("returns 422 missing_api_key before streaming when the key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-4-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(api)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
        });
    });

});
