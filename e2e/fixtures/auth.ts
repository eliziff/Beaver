import { expect, type Page } from "@playwright/test";

export const sharedUser = {
    email: process.env.E2E_EMAIL ?? "e2e@mike.local",
    password: process.env.E2E_PASSWORD ?? "E2eTestPass1!",
};
export const logoutUser = {
    email: process.env.E2E_LOGOUT_EMAIL ?? "e2e-logout@mike.local",
    password: process.env.E2E_LOGOUT_PASSWORD ?? "E2eLogoutPass1!",
};

export async function signIn(page: Page, { email, password }: typeof sharedUser) {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click('button[type="submit"]');
}
