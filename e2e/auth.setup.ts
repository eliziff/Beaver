import { test as setup } from "@playwright/test";
import path from "path";
import fs from "fs";
import { sharedUser, logoutUser, signIn } from "./fixtures/auth";

const authFile = path.join(__dirname, ".auth/user.json");

function readApiEnv(key: string): string | undefined {
    if (process.env[key]) return process.env[key];
    const envPath = path.join(__dirname, "..", "backend", ".env");
    try {
        const contents = fs.readFileSync(envPath, "utf8");
        // CI appends real values after placeholders: the last assignment wins.
        let value: string | undefined;
        for (const line of contents.split("\n")) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m && m[1] === key) value = m[2].trim();
        }
        return value;
    } catch {
        // A missing .env leaves this value unconfigured.
    }
    return undefined;
}

async function ensureUser(email: string, password: string) {
    const supabaseUrl =
        readApiEnv("SUPABASE_URL") ?? "http://127.0.0.1:54321";
    const serviceKey = readApiEnv("SUPABASE_SECRET_KEY");
    if (!serviceKey) {
        throw new Error(
            "SUPABASE_SECRET_KEY not found (checked env and backend/.env); " +
                "cannot bootstrap E2E users",
        );
    }

    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
            email,
            password,
            email_confirm: true,
        }),
    });

    if (!res.ok && res.status !== 422) {
        const body = await res.text();
        if (!body.includes("already been registered")) {
            throw new Error(
                `Failed to create user ${email}: ${res.status} ${body}`,
            );
        }
    }
}

setup("authenticate", async ({ page }) => {
    // A dedicated logout user must never invalidate the shared session.
    await ensureUser(sharedUser.email, sharedUser.password);
    await ensureUser(logoutUser.email, logoutUser.password);
    await signIn(page, sharedUser);

    await page.waitForURL(/\/assistant/, { timeout: 15_000 });

    await page.context().storageState({ path: authFile });
});
