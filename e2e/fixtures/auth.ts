import { expect, request, type Page } from "@playwright/test";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type TestUser = { email: string; password: string };
function readApiEnv(key: string) {
    if (process.env[key]) return process.env[key];
    const envPath = path.resolve(__dirname, "../../backend/.env");
    if (!fs.existsSync(envPath)) return undefined;
    let value: string | undefined;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match?.[1] === key) value = match[2].trim();
    }
    return value;
}

export async function createTestUser() {
    const url = readApiEnv("SUPABASE_URL") ?? "http://127.0.0.1:54321";
    const key = readApiEnv("SUPABASE_SECRET_KEY");
    if (!key) throw new Error("SUPABASE_SECRET_KEY is required to create isolated E2E users");
    const headers = { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` };
    const user = { email: `e2e-${randomUUID()}@mike.local`, password: `E2e-${randomUUID()}!` };
    const response = await fetch(`${url}/auth/v1/admin/users`, {
        method: "POST", headers, body: JSON.stringify({ ...user, email_confirm: true }),
    });
    if (!response.ok) throw new Error(`E2E user creation failed: ${response.status}`);
    return { ...user, remove: async () => {
        const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
        const context = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
        try {
            const loggedIn = await context.post("/api/auth/login", { data: user });
            if (!loggedIn.ok()) throw new Error(`E2E cleanup login failed: ${loggedIn.status()}`);
            // The public operation removes documents/storage before deleting auth.
            const deleted = await context.delete("/api/user/account");
            if (!deleted.ok()) throw new Error(`E2E account cleanup failed: ${deleted.status()}`);
        } finally { await context.dispose(); }
    } };
}

export async function signIn(page: Page, { email, password }: TestUser) {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click('button[type="submit"]');
}
