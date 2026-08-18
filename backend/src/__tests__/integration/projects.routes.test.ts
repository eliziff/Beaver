import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import {
    createMutableSupabaseState,
    createMutableSupabaseStub,
} from "../helpers/supabaseStub";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, deleteUserProjects } = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    deleteUserProjects: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub. Each test seeds `supabaseState` in beforeEach;
// terminal query operations (.single()/.maybeSingle()/thenable) resolve to the
// per-table result, and rpc() resolves to a per-call result. Insert payloads
// are recorded so tests can assert on normalisation (lowercasing / dedupe).
// ---------------------------------------------------------------------------
let supabaseState = createMutableSupabaseState();
function resetSupabaseState() { supabaseState = createMutableSupabaseState(); }
resetSupabaseState();

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => createMutableSupabaseStub(supabaseState)),
}));

vi.mock("../../lib/cloudObjectStorage", () => ({
    cloudDocumentObjects: () => ({
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

// Every export of lib/access must be present — other routers (chat, documents,
// downloads, tabular) import from it at app load.
vi.mock("../../lib/access", () => ({
    cloudData: async (operation: string, query: PromiseLike<any>) => {
        const { data, error } = await query;
        if (error) throw new Error(operation);
        return data;
    },
    cloudScope: (identity: { userId: string; userEmail?: string }) => {
        const db = createMutableSupabaseStub(supabaseState);
        return {
            ...identity,
            userEmail: identity.userEmail?.toLowerCase() ?? "",
            db,
            project: async (id: string, owner = false) => {
                if (Object.hasOwn(supabaseState.tables, "projects")) {
                    const row = supabaseState.tables.projects.data as any;
                    if (!row) return null;
                    const isOwner = row.user_id === identity.userId;
                    const shared = Array.isArray(row.shared_with) && row.shared_with
                        .some((email: string) => email.toLowerCase() ===
                            identity.userEmail?.toLowerCase());
                    return (isOwner || shared) && (!owner || isOwner)
                        ? { row, isOwner } : null;
                }
                const result = await checkProjectAccess(id, identity.userId,
                    identity.userEmail, db);
                return result.ok && (!owner || result.isOwner)
                    ? { row: result.project, isOwner: result.isOwner } : null;
            },
            document: vi.fn(async () => null),
            documents: vi.fn(async () => []),
            review: vi.fn(async () => null),
            chat: vi.fn(async () => null),
            projects: vi.fn(async () => []),
        };
    },
}));

// user router imports all four cleanup helpers at module load.
vi.mock("../../lib/userDataCleanup", () => ({
    deleteUserProjects: (...args: unknown[]) => deleteUserProjects(...args),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
}));

// Version-path enrichment hits the DB in real life; no-op it so the route
// responses are driven purely by the documents/projects table stubs.
vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;

describe("projects.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isOwner: true,
            project: { id: "p1", user_id: "u1", shared_with: null },
        });
        deleteUserProjects.mockResolvedValue(1);
    });

    // ── GET /projects (overview) ──────────────────────────────────────────
    describe("GET /projects", () => {
        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [{
                    id: "p1",
                    created_at: "2026-01-01T00:00:00Z",
                    payload: { id: "p1", name: "Alpha" },
                }],
                error: null,
            };

            const res = await request(app).get("/projects").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                items: [{ id: "p1", name: "Alpha" }],
                next_cursor: null,
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

            const res = await request(app).get("/projects").set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Failed to load projects");
        });
    });

    // ── POST /projects (create) ───────────────────────────────────────────
    describe("POST /projects", () => {
        it("returns 400 when name is missing/blank", async () => {
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "   " });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("name is required");
        });

        it("returns 400 when sharing the project with yourself", async () => {
            // The authed user's email is u1@test.local; supplying it (in any
            // case) must be rejected.
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Beta", shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "You cannot share a project with yourself.",
            );
        });

        it("creates the project (201) and normalises shared_with", async () => {
            // Sharing requires each recipient to have a mirrored user_profiles
            // row (findMissingUserEmails); seed both emails so validation
            // passes and the create path proceeds.
            supabaseState.tables.user_profiles = {
                data: [{ email: "a@x.com" }, { email: "b@x.com" }],
                error: null,
            };
            supabaseState.tables.projects = {
                data: {
                    id: "p9",
                    name: "Gamma",
                    user_id: "u1",
                    shared_with: ["a@x.com", "b@x.com"],
                    created_at: "2026-07-27T18:42:00.000Z",
                },
                error: null,
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({
                    name: "  Gamma  ",
                    shared_with: ["A@x.com", "a@x.com", "B@X.com", "", "  "],
                });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                id: "p9",
                created_at: "2026-07-27T18:42:00.000Z",
            });

            // The insert payload should be lowercased, deduped, trimmed and
            // the name trimmed.
            const insert = supabaseState.inserts.find(
                (i) => i.table === "projects",
            );
            expect(insert?.payload).toMatchObject({
                name: "Gamma",
                shared_with: ["a@x.com", "b@x.com"],
            });
        });

        it("returns 400 when a shared_with recipient is not a Beaver user", async () => {
            // No user_profiles rows seeded → findMissingUserEmails reports the
            // recipient as unknown and the create is rejected before insert.
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Gamma", shared_with: ["ghost@x.com"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "ghost@x.com does not belong to a Beaver user.",
            );
            expect(
                supabaseState.inserts.find((i) => i.table === "projects"),
            ).toBeUndefined();
        });

        it("returns 500 when the insert errors", async () => {
            supabaseState.tables.projects = {
                data: null,
                error: { message: "insert failed" },
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Delta" });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Failed to create project");
        });
    });

    // ── GET /projects/:projectId (detail, inline access) ──────────────────
    describe("GET /projects/:projectId", () => {
        it("returns 404 when the project does not exist", async () => {
            supabaseState.tables.projects = { data: null, error: null };

            const res = await request(app).get("/projects/p1").set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 404 when the caller is neither owner nor shared", async () => {
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                    shared_with: ["other@x.com"],
                },
                error: null,
            };

            const res = await request(app).get("/projects/p1").set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("grants access to a shared member (is_owner false)", async () => {
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                    shared_with: ["U1@Test.Local"],
                },
                error: null,
            };
            supabaseState.tables.documents = { data: [], error: null };
            supabaseState.tables.project_subfolders = { data: [], error: null };

            const res = await request(app).get("/projects/p1").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id: "p1", is_owner: false });
        });

        it("returns project fields without embedded collections when owned", async () => {
            supabaseState.tables.projects = {
                data: { id: "p1", user_id: "u1", shared_with: null },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", user_id: "u1" }],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1" }],
                error: null,
            };

            const res = await request(app).get("/projects/p1").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: "p1",
                is_owner: true,
            });
            expect(res.body).not.toHaveProperty("documents");
            expect(res.body).not.toHaveProperty("folders");
        });
    });

    // ── GET /projects/:projectId/documents (checkProjectAccess guard) ─────
    describe("GET /projects/:projectId/directory", () => {
        it("returns an empty bounded page when no visible rows exist", async () => {
            supabaseState.rpc = { data: [], error: null };
            const res = await request(app).get("/projects/p1/directory").set(...AUTH);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ items: [], next_cursor: null });
        });

        it("returns discriminated directory entries", async () => {
            supabaseState.rpc = {
                data: [{
                    kind: "document",
                    id: "d1",
                    bucket: 1,
                    sort_name: "alpha.pdf",
                    payload: { id: "d1", filename: "Alpha.pdf" },
                }],
                error: null,
            };
            const res = await request(app).get("/projects/p1/directory").set(...AUTH);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                items: [{
                    kind: "document",
                    document: { id: "d1", filename: "Alpha.pdf" },
                }],
                next_cursor: null,
            });
        });
    });

    // ── PATCH /projects/:projectId (sharing normalisation) ────────────────
    describe("PATCH /projects/:projectId", () => {
        it("returns 400 when sharing the project with yourself", async () => {
            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ shared_with: ["u1@test.local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "You cannot share a project with yourself.",
            );
        });

        it("returns 404 when the update matches no owned project", async () => {
            supabaseState.tables.projects = { data: null, error: null };

            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ name: "Renamed" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });
    });

    // ── DELETE /projects/:projectId ───────────────────────────────────────
    describe("DELETE /projects/:projectId", () => {
        it("returns 404 when nothing was deleted", async () => {
            deleteUserProjects.mockResolvedValue(0);

            const res = await request(app).delete("/projects/p1").set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 204 when the project is deleted", async () => {
            deleteUserProjects.mockResolvedValue(1);

            const res = await request(app).delete("/projects/p1").set(...AUTH);

            expect(res.status).toBe(204);
            // Signature is deleteUserProjects(db, userId, [projectId]).
            expect(deleteUserProjects).toHaveBeenCalledWith(
                expect.anything(),
                "u1",
                ["p1"],
            );
        });

        it("returns 500 when deletion throws", async () => {
            deleteUserProjects.mockRejectedValue(new Error("cascade failed"));

            const res = await request(app).delete("/projects/p1").set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("cascade failed");
        });
    });
});
