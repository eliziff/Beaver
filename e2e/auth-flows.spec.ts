import { test, expect } from "@playwright/test";
import { sharedUser, logoutUser, signIn } from "./fixtures/auth";

// These cases must not inherit the authenticated storage state.
test.describe("unauthenticated", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("login with invalid credentials shows error message", async ({
        page,
    }) => {
        await signIn(page, {
            email: "e2e@mike.local", password: "definitely-wrong-password",
        });

        await page.waitForLoadState("networkidle");

        await expect(page.getByRole("alert")).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByRole("alert")).not.toBeEmpty();
        await expect(page).toHaveURL(/\/login/);
    });

    test("login with valid credentials redirects to /assistant", async ({
        page,
    }) => {
        await signIn(page, sharedUser);

        await expect(page).toHaveURL(/\/assistant/, { timeout: 15_000 });
    });

    test("all protected routes redirect unauthenticated users to /login", async ({
        page,
    }) => {
        const protectedRoutes = [
            "/assistant",
            "/projects",
            "/tabular-reviews",
            "/workflows",
            "/account",
        ];

        for (const route of protectedRoutes) {
            await page.goto(route);
            await expect(page).toHaveURL(/\/login/, { timeout: route === "/assistant" ? 15_000 : 10_000 });
        }
    });
});

// A dedicated user prevents logout from invalidating other tests' shared session.
test.describe("logout (isolated user)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("logout from account settings redirects to /login", async ({
        page,
    }) => {
        await signIn(page, logoutUser);

        await page.waitForURL(/\/assistant/, { timeout: 15_000 });
        await page.waitForLoadState("networkidle");

        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("dialog", { name: "Settings", exact: true })
            .getByRole("link", { name: "Account", exact: true }).click();

        await expect(page).toHaveURL(/\/account/, { timeout: 10_000 });
        await page.waitForLoadState("networkidle");

        const signOutButton = page.getByRole("button", { name: "Sign out", exact: true });
        await expect(signOutButton).toBeVisible({ timeout: 5_000 });
        await signOutButton.click();

        await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    });
});
