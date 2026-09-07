import { describe, expect, it, vi } from "vitest";
import { findProfileUserByEmail, normalizeEmail, syncProfileIdentity } from "../userLookup";

type Profile = { user_id?: string; email: string; display_name?: string; mfa_on_login?: boolean };

function database(profile: Profile | null = null, readError: unknown = null, writeError: unknown = null) {
    const read = vi.fn().mockResolvedValue({ data: profile, error: readError });
    const filter = vi.fn(() => ({ maybeSingle: read }));
    const insert = vi.fn().mockResolvedValue({ error: writeError });
    const updateFilter = vi.fn().mockResolvedValue({ error: writeError });
    const update = vi.fn(() => ({ eq: updateFilter }));
    const from = vi.fn(() => ({ select: () => ({ eq: filter }), insert, update }));
    // Stub the remote boundary, not a second implementation of its query engine.
    const db = { from } as unknown as Parameters<typeof syncProfileIdentity>[0];
    return { db, from, filter, insert, update, updateFilter };
}

describe("normalizeEmail", () => {
    it("trims and lowercases", () => {
        expect(normalizeEmail("  User@Example.COM  ")).toBe("user@example.com");
    });

    it.each([null, undefined, 42])("returns an empty string for %j", (value) => {
        expect(normalizeEmail(value)).toBe("");
    });
});

describe("findProfileUserByEmail", () => {
    it("looks up the normalized email and reads the name from that user's preferences", async () => {
        const store = database({ user_id: "u1", email: "alice@example.com", display_name: "Old name" });
        const preferences = { get: vi.fn().mockResolvedValue({ displayName: "Preferred name" }) };

        await expect(findProfileUserByEmail(store.db, "  ALICE@example.com ", preferences))
            .resolves.toEqual({ id: "u1", email: "alice@example.com", display_name: "Preferred name" });
        expect(store.from).toHaveBeenCalledWith("user_profiles");
        expect(store.filter).toHaveBeenCalledWith("email", "alice@example.com");
        expect(preferences.get).toHaveBeenCalledWith("u1");
    });

    it.each([["missing@example.com", 1], ["   ", 0]] as const)(
        "does not read preferences for %j", async (email, queries) => {
            const store = database(), preferences = { get: vi.fn() };
            await expect(findProfileUserByEmail(store.db, email, preferences)).resolves.toBeNull();
            expect(preferences.get).not.toHaveBeenCalled();
            expect(store.from).toHaveBeenCalledTimes(queries);
        },
    );
});

describe("syncProfileIdentity", () => {
    it("inserts a normalized identity when no profile exists", async () => {
        const store = database();
        await expect(syncProfileIdentity(store.db, "u1", "New@Example.com")).resolves.toBe(false);
        expect(store.from).toHaveBeenCalledWith("user_profiles");
        expect(store.filter).toHaveBeenCalledWith("user_id", "u1");
        expect(store.insert).toHaveBeenCalledWith({ user_id: "u1", email: "new@example.com" });
        expect(store.update).not.toHaveBeenCalled();
    });

    it.each([false, true])("preserves MFA=%s without writing an unchanged email", async (mfa) => {
        const store = database({ email: "Same@Example.com", mfa_on_login: mfa });
        await expect(syncProfileIdentity(store.db, "u1", "same@example.com")).resolves.toBe(mfa);
        expect(store.insert).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
    });

    it("updates only the requested user's email and preserves their MFA requirement", async () => {
        const store = database({ email: "old@example.com", mfa_on_login: true });
        await expect(syncProfileIdentity(store.db, "u1", "New@Example.com")).resolves.toBe(true);
        expect(store.update).toHaveBeenCalledWith({
            email: "new@example.com", updated_at: expect.any(String),
        });
        expect(store.updateFilter).toHaveBeenCalledWith("user_id", "u1");
        expect(store.insert).not.toHaveBeenCalled();
    });

    it.each([["", "a@b.com"], ["u1", null], ["u1", "   "]] as const)(
        "returns false without querying for user=%j, email=%j", async (userId, email) => {
            const store = database();
            await expect(syncProfileIdentity(store.db, userId, email)).resolves.toBe(false);
            expect(store.from).not.toHaveBeenCalled();
        },
    );
});

describe("identity lookup failures", () => {
    it("propagates read errors before loading preferences or writing an identity", async () => {
        const error = new Error("Profile read failed"), store = database(null, error);
        const preferences = { get: vi.fn() };
        await expect(findProfileUserByEmail(store.db, "alice@example.com", preferences)).rejects.toBe(error);
        await expect(syncProfileIdentity(store.db, "u1", "alice@example.com")).rejects.toBe(error);
        expect(preferences.get).not.toHaveBeenCalled();
        expect(store.insert).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
    });

    it.each([null, { email: "old@example.com" }])("propagates write errors for profile=%j", async (profile) => {
        const error = new Error("Profile write failed"), store = database(profile, null, error);
        await expect(syncProfileIdentity(store.db, "u1", "new@example.com")).rejects.toBe(error);
    });
});
