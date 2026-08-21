import { describe, it, expect } from "vitest";
import {
    normalizeEmail,
    findProfileUserByEmail,
    syncProfileIdentity,
} from "../userLookup";

type Row = Record<string, unknown>;

/**
 * Minimal user_profiles-shaped Supabase mock. Supports the query chains
 * userLookup uses (select/eq/in/not + single-row readers) plus insert and
 * update so syncProfileIdentity can be exercised end to end.
 */
function makeDb(initialRows: Row[]) {
    const tables: Record<string, Row[]> = {
        user_profiles: initialRows.map((row) => ({ ...row })),
    };
    return {
        tables,
        from(table: string) {
            const all = () => tables[table] ?? [];
            let predicate: (row: Row) => boolean = () => true;
            let mode: "select" | "insert" | "update" = "select";
            let pendingRow: Row = {};
            const narrow = (next: (row: Row) => boolean) => {
                const prev = predicate;
                predicate = (row) => prev(row) && next(row);
            };
            const query: any = {
                select: () => query,
                insert: (row: Row) => {
                    mode = "insert";
                    pendingRow = row;
                    return query;
                },
                update: (patch: Row) => {
                    mode = "update";
                    pendingRow = patch;
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    narrow((row) => row[column] === value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    narrow((row) => values.includes(row[column]));
                    return query;
                },
                not: (column: string, operator: string, value: unknown) => {
                    if (operator === "is" && value === null) {
                        narrow((row) => row[column] != null);
                    }
                    return query;
                },
                maybeSingle: async () => ({
                    data: all().filter(predicate)[0] ?? null,
                    error: null,
                }),
                then: (
                    resolve: (value: { data: Row[] | null; error: null }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) => {
                    if (mode === "insert") {
                        all().push({ ...pendingRow });
                        return Promise.resolve({ data: null, error: null }).then(
                            resolve,
                            reject,
                        );
                    }
                    if (mode === "update") {
                        for (const row of all().filter(predicate)) {
                            Object.assign(row, pendingRow);
                        }
                        return Promise.resolve({ data: null, error: null }).then(
                            resolve,
                            reject,
                        );
                    }
                    return Promise.resolve({
                        data: all().filter(predicate),
                        error: null,
                    }).then(resolve, reject);
                },
            };
            return query;
        },
    };
}

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

describe("normalizeEmail", () => {
    it("trims and lowercases", () => {
        expect(normalizeEmail("  User@Example.COM  ")).toBe("user@example.com");
    });

    it("returns empty string for non-strings", () => {
        expect(normalizeEmail(null)).toBe("");
        expect(normalizeEmail(undefined)).toBe("");
        expect(normalizeEmail(42)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// findProfileUserByEmail
// ---------------------------------------------------------------------------

describe("findProfileUserByEmail", () => {
    const rows = [
        { user_id: "u1", email: "alice@example.com", display_name: "Alice" },
    ];

    it("finds a profile by normalized email", async () => {
        const db = makeDb(rows);
        await expect(
            findProfileUserByEmail(db as any, "  ALICE@example.com "),
        ).resolves.toEqual({
            id: "u1",
            email: "alice@example.com",
            display_name: "Alice",
        });
    });

    it("returns null when no profile matches", async () => {
        const db = makeDb(rows);
        await expect(
            findProfileUserByEmail(db as any, "missing@example.com"),
        ).resolves.toBeNull();
    });

    it("returns null without querying for empty input", async () => {
        const db = makeDb(rows);
        await expect(findProfileUserByEmail(db as any, "   ")).resolves.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// syncProfileIdentity
// ---------------------------------------------------------------------------

describe("syncProfileIdentity", () => {
    it("inserts a profile row when none exists", async () => {
        const db = makeDb([]);
        const result = await syncProfileIdentity(db as any, "u1", "New@Example.com");
        expect(result).toBe(false);
        expect(db.tables.user_profiles).toEqual([
            { user_id: "u1", email: "new@example.com" },
        ]);
    });

    it("is a no-op when the stored email already matches (case-insensitive)", async () => {
        const db = makeDb([
            { user_id: "u1", email: "Same@Example.com", display_name: null },
        ]);
        const result = await syncProfileIdentity(db as any, "u1", "same@example.com");
        expect(result).toBe(false);
        expect(db.tables.user_profiles[0].email).toBe("Same@Example.com");
    });

    it("updates the stored email when it changed", async () => {
        const db = makeDb([
            { user_id: "u1", email: "old@example.com", display_name: null },
        ]);
        const result = await syncProfileIdentity(db as any, "u1", "New@Example.com");
        expect(result).toBe(false);
        expect(db.tables.user_profiles[0].email).toBe("new@example.com");
        expect(db.tables.user_profiles[0].updated_at).toEqual(expect.any(String));
    });

    it("returns null without touching the table for missing inputs", async () => {
        const db = makeDb([]);
        await expect(syncProfileIdentity(db as any, "", "a@b.com")).resolves.toBe(false);
        await expect(syncProfileIdentity(db as any, "u1", null)).resolves.toBe(false);
        await expect(syncProfileIdentity(db as any, "u1", "   ")).resolves.toBe(false);
        expect(db.tables.user_profiles).toEqual([]);
    });
});
