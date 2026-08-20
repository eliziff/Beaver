import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Stack-level integration test: exercises the REAL Supabase stack (GoTrue auth +
// Postgres RLS) rather than mocks. This is the harness that makes pinning a fixed
// Supabase version set safe — it's what you re-run on every image bump to prove
// the auth↔API contract and the deny-all RLS firewall still hold. It also anchors
// the security model's central claim: RLS denies the user/anon path, and the API
// reaches data only via the service-role key.
//
// Gated: skipped unless a stack is provided (default CI unit run skips it).
// Locally: `supabase start`, then export the printed keys as:
//   SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;
const databaseUrl = process.env.SUPABASE_TEST_DB_URL;
const maybeDescribe =
    url && serviceKey && anonKey && databaseUrl ? describe : describe.skip;

maybeDescribe("Supabase stack — auth contract + RLS deny-all firewall", () => {
    const password = "StackTest1!";
    const emailA = `stack-a-${Date.now()}@test.local`;
    const emailB = `stack-b-${Date.now()}@test.local`;

    let admin: SupabaseClient; // service-role: BYPASSRLS, the app's data path
    let userA = "";
    let userB = "";
    let tokenA = "";
    let projectId = "";
    let database: ReturnType<typeof postgres> | undefined;

    // A client acting as a signed-in end user (anon key + the user's JWT): this is
    // the path RLS must fence off.
    const asUser = (token: string) =>
        createClient(url!, anonKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${token}` } },
        });

    beforeAll(async () => {
        database = postgres(
            `${databaseUrl}${databaseUrl!.includes("?") ? "&" : "?"}sslmode=disable`,
            { max: 1, prepare: false },
        );
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const a = await admin.auth.admin.createUser({
            email: emailA, password, email_confirm: true,
        });
        const b = await admin.auth.admin.createUser({
            email: emailB, password, email_confirm: true,
        });
        if (a.error || !a.data.user) throw a.error ?? new Error("no user A");
        if (b.error || !b.data.user) throw b.error ?? new Error("no user B");
        userA = a.data.user.id;
        userB = b.data.user.id;

        // Sign in as A to get a real access token (the token the API middleware
        // validates via auth.getUser).
        const signIn = await createClient(url!, anonKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        }).auth.signInWithPassword({ email: emailA, password });
        if (signIn.error || !signIn.data.session) {
            throw signIn.error ?? new Error("no session for A");
        }
        tokenA = signIn.data.session.access_token;

        // Seed one row owned by A via the service role (the app's real write path).
        const timestamp = new Date().toISOString();
        const proj = await admin
            .from("projects")
            .insert({ id: crypto.randomUUID(), user_id: userA,
                name: "Stack Test Project", created_at: timestamp, updated_at: timestamp })
            .select("id")
            .single();
        if (proj.error || !proj.data) throw proj.error ?? new Error("no project");
        projectId = proj.data.id;
    });

    afterAll(async () => {
        if (projectId) await admin.from("projects").delete().eq("id", projectId);
        if (userA) await admin.auth.admin.deleteUser(userA);
        if (userB) await admin.auth.admin.deleteUser(userB);
        await database?.end({ timeout: 1 });
    });

    it("auth contract: the access token resolves to its user (middleware path)", async () => {
        const { data, error } = await admin.auth.getUser(tokenA);
        expect(error).toBeNull();
        expect(data.user?.id).toBe(userA);
        expect(data.user?.email).toBe(emailA);
    });

    it("RLS: the service role sees seeded rows the owner cannot see via the user path", async () => {
        // Service role (app data path) sees the project…
        const svc = await admin
            .from("projects").select("id").eq("id", projectId);
        expect(svc.error).toBeNull();
        expect(svc.data ?? []).toHaveLength(1);

        // …but the owner, going through the user/anon path, sees zero rows —
        // deny-all RLS is the firewall; the app must use the service role.
        const owner = await asUser(tokenA)
            .from("projects").select("id").eq("id", projectId);
        expect(owner.data ?? []).toHaveLength(0);

        // And the owner's profile (if any) is equally invisible to the user path.
        const prof = await asUser(tokenA)
            .from("user_profiles").select("user_id").eq("user_id", userA);
        expect(prof.data ?? []).toHaveLength(0);
    });

    it("tenant isolation: user B cannot read user A's project via the user path", async () => {
        const signInB = await createClient(url!, anonKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        }).auth.signInWithPassword({ email: emailB, password });
        const tokenB = signInB.data.session!.access_token;

        const cross = await asUser(tokenB)
            .from("projects").select("id").eq("id", projectId);
        expect(cross.data ?? []).toHaveLength(0);
    });

    it("leak sweep: no public table returns rows to the authenticated user path", async () => {
        const tables = await database!<{ table_name: string; rls_enabled: boolean }[]>`
            SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY c.relname
        `;
        expect(tables.filter(({ rls_enabled }) => !rls_enabled)
            .map(({ table_name }) => table_name)).toEqual([]);
        const client = asUser(tokenA);
        const leaks: string[] = [];
        for (const { table_name } of tables) {
            const { data } = await client.from(table_name).select("*").limit(1);
            if ((data ?? []).length > 0) leaks.push(table_name);
        }
        // Any table returning rows to a normal user means RLS is missing or a
        // policy is permissive — the exact regression this guards against.
        expect(leaks).toEqual([]);
    });
});
